import { escapeHtml, documentHtml, editPage, htmlResponse, loginPage, logsPanel, operationControls, operationPanel } from "./html.ts";
import { dirname } from "node:path";
import { locateComposeFile, readStackCompose, StackError } from "./stacks.ts";
import { loadStackDetail, loadStackStates, resolveProjectContext, type StackDetailStatus } from "./status.ts";
import { StackConflictError, StackPartialError, StackValidationError, readEditableStack, saveEditableStack } from "./editor.ts";
import { StackBusyError, StackLocks } from "./locks.ts";
import { OperationManager, OperationsDisabledError, isOperationAction, type OperationView } from "./operations.ts";
import { LogManager } from "./logs.ts";
import { formatSseEvent, formatSseHeartbeat, sseHeaders } from "./sse.ts";
import { createComposeProvider, type ComposeProvider } from "./compose-provider.ts";
import type { ComposeService } from "./compose-state.ts";
import type { DockerRunner } from "./docker.ts";
import {
    CSRF_COOKIE,
    SESSION_COOKIE,
    LoginRateLimiter,
    SessionStore,
    clearedSessionCookie,
    csrfCookie,
    parseCookies,
    randomToken,
    safeEqual,
    sessionCookie,
    verifyPassword,
} from "./auth.ts";
import type { AppConfig } from "./config.ts";

const BASE_HEADERS: Record<string, string> = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
};

/** Brand assets served unauthenticated (login page included). Fixed map, no user input. */
const BRAND_FILES: Record<string, { file: string; type: string }> = {
    "/favicon.svg": { file: "favicon.svg", type: "image/svg+xml; charset=utf-8" },
    "/favicon.ico": { file: "favicon.ico", type: "image/x-icon" },
    "/apple-touch-icon.png": { file: "apple-touch-icon.png", type: "image/png" },
    "/icon-active-on-light.svg": { file: "icon-active-on-light.svg", type: "image/svg+xml; charset=utf-8" },
    "/icon-active-on-dark.svg": { file: "icon-active-on-dark.svg", type: "image/svg+xml; charset=utf-8" },
    "/icon-boot-on-light.svg": { file: "icon-boot-on-light.svg", type: "image/svg+xml; charset=utf-8" },
    "/icon-boot-on-dark.svg": { file: "icon-boot-on-dark.svg", type: "image/svg+xml; charset=utf-8" },
};

const STATE_LABELS: Record<string, string> = {
    running: "running",
    stopped: "stopped",
    "not-created": "not created",
    unknown: "unknown",
};

function stateBadge(state: string): string {
    return `<span class="state state-${escapeHtml(state)}">${escapeHtml(STATE_LABELS[state] ?? state)}</span>`;
}

function servicesTable(services: ComposeService[]): string {
    if (services.length === 0) return "";
    const rows = services
        .map(service => `<tr><td>${escapeHtml(service.name)}</td><td>${escapeHtml(service.state)}${service.health ? ` (${escapeHtml(service.health)})` : ""}</td></tr>`)
        .join("");
    return `<table class="services"><thead><tr><th>Service</th><th>State</th></tr></thead><tbody>${rows}</tbody></table>`;
}

const unavailableRunner: DockerRunner = async () => ({ code: -1, stdout: "", stderr: "", timedOut: false, truncated: false });

export interface AppOptions {
    config: AppConfig;
    /** Absolute, canonical stacks directory resolved at startup. */
    stacksRoot: string;
    /** Docker runner. Defaults to an unavailable stub so callers opt in explicitly. */
    runner?: DockerRunner;
    /** Pre-built Compose provider. Built from `runner` when omitted. */
    provider?: ComposeProvider;
    /** Per-stack modifying-operation lock. */
    locks?: StackLocks;
}

export interface App {
    fetch(request: Request): Promise<Response>;
    operations: OperationManager;
    logs: LogManager;
    sseSubscriptions(): number;
    beginShutdown(graceMs: number): Promise<void>;
}

function plain(body: string, status: number): Response {
    return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...BASE_HEADERS } });
}

function methodNotAllowed(allow: string): Response {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: allow, ...BASE_HEADERS } });
}

function redirect(location: string, status: number): Response {
    return new Response(null, { status, headers: { Location: location, ...BASE_HEADERS } });
}

/** Bounded body reader: returns null when the payload exceeds the configured limit. */
async function readTextLimited(request: Request, maxBytes: number): Promise<string | null> {
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > maxBytes) return null;
    const body = request.body;
    if (!body) return "";
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxBytes) {
            await reader.cancel();
            return null;
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
}

function requestOrigin(request: Request, config: AppConfig): string | null {
    const url = new URL(request.url);
    let proto = url.protocol.replace(":", "");
    if (config.trustProxy) {
        const forwarded = request.headers.get("x-forwarded-proto");
        if (forwarded) proto = forwarded.split(",")[0]!.trim();
    }
    const host = request.headers.get("host") ?? url.host;
    if (!host) return null;
    return `${proto}://${host}`;
}

/** Strict same-origin check for state-changing requests. Fails closed. */
function isAllowedOrigin(request: Request, config: AppConfig): boolean {
    const expected = config.publicOrigin ?? requestOrigin(request, config);
    if (!expected) return false;
    let candidate: string | null = request.headers.get("origin");
    if (!candidate) {
        const referer = request.headers.get("referer");
        if (referer) {
            try { candidate = new URL(referer).origin; }
            catch { candidate = null; }
        }
    }
    return candidate === expected;
}

function clientKey(request: Request, config: AppConfig): string {
    if (config.trustProxy) {
        const forwarded = request.headers.get("x-forwarded-for");
        if (forwarded) return forwarded.split(",")[0]!.trim();
    }
    return "direct";
}

export function createApp(options: AppOptions): App {
    const { config, stacksRoot, locks = new StackLocks() } = options;
    const provider = options.provider
        ?? createComposeProvider({ runner: options.runner ?? unavailableRunner, engine: config.composeEngine });
    const operations = new OperationManager(locks, provider, {
        timeoutMs: config.operationTimeoutMs,
        maxBytes: config.dockerMaxBytes,
    });
    const logs = new LogManager(provider, {
        tailLines: config.logTailLines,
        maxBytes: config.logMaxBytes,
        timeoutMs: config.logTimeoutMs,
    });
    let activeSse = 0;
    let shuttingDown = false;
    const sessions = new SessionStore(config.sessionTtlMs, config.sessionIdleMs);
    const limiter = new LoginRateLimiter(
        config.loginRateLimit.maxAttempts,
        config.loginRateLimit.windowMs,
        config.loginRateLimit.blockMs,
    );

    async function readForm(request: Request, maxBytes = config.maxBodyBytes): Promise<URLSearchParams | null> {
        const text = await readTextLimited(request, maxBytes);
        if (text === null) return null;
        return new URLSearchParams(text);
    }

    function routeError(error: unknown, csrf?: string): Response {
        const status = error instanceof StackError ? error.status : 500;
        if (!(error instanceof StackError)) console.error("Internal error", error);
        const message = error instanceof StackError ? error.message : "Internal error.";
        return htmlResponse(
            documentHtml("Error", `<h1>Error</h1><p>${escapeHtml(message)}</p><p><a href="/">Back</a></p>`, { logoutCsrf: csrf }),
            status,
        );
    }

    function loginFailure(message: string | null, status: number, retryAfterSec?: number): Response {
        const nonce = randomToken();
        const response = htmlResponse(loginPage({ csrf: nonce, error: message }), status);
        response.headers.append("Set-Cookie", csrfCookie(nonce, config.cookieSecure));
        if (retryAfterSec !== undefined) response.headers.set("Retry-After", String(retryAfterSec));
        return response;
    }

    async function handleLoginGet(request: Request): Promise<Response> {
        const cookies = parseCookies(request.headers.get("cookie"));
        const id = cookies[SESSION_COOKIE];
        if (id && sessions.get(id)) return redirect("/", 302);
        const nonce = randomToken();
        const response = htmlResponse(loginPage({ csrf: nonce }));
        response.headers.append("Set-Cookie", csrfCookie(nonce, config.cookieSecure));
        return response;
    }

    async function handleLoginPost(request: Request): Promise<Response> {
        if (!isAllowedOrigin(request, config)) return plain("Forbidden", 403);
        const form = await readForm(request);
        if (form === null) return plain("Payload too large", 413);

        const cookies = parseCookies(request.headers.get("cookie"));
        const cookieToken = cookies[CSRF_COOKIE] ?? "";
        const formToken = form.get("csrf") ?? "";
        if (!cookieToken || !formToken || !safeEqual(cookieToken, formToken)) return plain("Forbidden", 403);

        const key = clientKey(request, config);
        const verdict = limiter.check(key);
        if (!verdict.allowed) return loginFailure("Too many attempts. Try again later.", 429, verdict.retryAfterSec);

        const user = form.get("user") ?? "";
        const password = form.get("password") ?? "";
        // Verify unconditionally to keep the response time independent of the username.
        const passwordOk = await verifyPassword(config.adminPasswordHash, password);
        if (!passwordOk || user !== config.adminUser) {
            limiter.recordFailure(key);
            return loginFailure("Invalid credentials.", 401);
        }

        limiter.reset(key);
        const session = sessions.create(config.adminUser);
        const response = redirect("/", 303);
        response.headers.append(
            "Set-Cookie",
            sessionCookie(session.id, { secure: config.cookieSecure, maxAgeSec: Math.floor(config.sessionTtlMs / 1000) }),
        );
        return response;
    }

    async function renderStackList(csrf: string): Promise<Response> {
        const { stacks, dockerNote } = await loadStackStates(stacksRoot, provider);
        const rows = stacks.length
            ? stacks.map(stack => {
                const project = stack.project ? ` · project ${escapeHtml(stack.project)}` : "";
                return `<li><a href="/stacks/${encodeURIComponent(stack.name)}">${escapeHtml(stack.name)}</a><small>${escapeHtml(stack.composeFile)} · ${stateBadge(stack.state)}${project}</small></li>`;
            }).join("")
            : `<li>No recognized Compose stack.</li>`;
        const note = dockerNote ? `<p class="note">${escapeHtml(dockerNote)}</p>` : "";
        return htmlResponse(documentHtml(
            "Stacks",
            `<h1>Stacks</h1><p>Read-only — no mutating Docker command is executed.</p>${note}<ul class="stack-list">${rows}</ul>`,
            { logoutCsrf: csrf },
        ));
    }

    async function renderStackDetail(name: string, csrf: string, notice?: string, statusCode = 200): Promise<Response> {
        const stack = await readStackCompose(stacksRoot, name);
        let status: StackDetailStatus;
        try {
            status = await loadStackDetail(stacksRoot, name, provider);
        } catch (error) {
            if (error instanceof StackError) throw error;
            status = { project: null, state: "unknown", note: "Status unavailable.", services: [] };
        }
        const project = status.project ? ` · project ${escapeHtml(status.project)}` : "";
        const note = status.note ? `<p class="note">${escapeHtml(status.note)}</p>` : "";
        const noticeHtml = notice ? `<p class="note">${escapeHtml(notice)}</p>` : "";
        return htmlResponse(documentHtml(
            stack.name,
            `<p><a href="/">← All stacks</a> · <a href="/stacks/${encodeURIComponent(stack.name)}/edit">Edit files</a></p><h1>${escapeHtml(stack.name)}</h1>`
            + `<p>${escapeHtml(stack.filename)} · ${stateBadge(status.state)}${project}</p>`
            + `${noticeHtml}${note}${operationControls(stack.name, csrf)}${operationPanel(operations.forStack(stack.name), stack.name)}`
            + `${logsPanel(stack.name)}`
            + `${servicesTable(status.services)}<pre>${escapeHtml(stack.source)}</pre>`,
            { logoutCsrf: csrf, scripts: ["/app.js"] },
        ), statusCode);
    }

    function decodeName(raw: string): string {
        try { return decodeURIComponent(raw); }
        catch { throw new StackError("Invalid name encoding."); }
    }

    async function renderEdit(
        name: string,
        csrf: string,
        options: { error?: string; draft?: { composeSource: string; envSource: string }; keepDraft?: boolean; status?: number } = {},
    ): Promise<Response> {
        const stack = await readEditableStack(stacksRoot, name, config.maxEditBytes);
        const keep = options.keepDraft === true && options.draft !== undefined;
        return htmlResponse(editPage({
            name,
            csrf,
            composeFilename: stack.composeFilename,
            composeSource: keep ? options.draft!.composeSource : stack.composeSource,
            composeHash: stack.composeHash,
            envSource: keep ? options.draft!.envSource : stack.envSource,
            envHash: stack.envHash,
            envExists: stack.envExists,
            error: options.error ?? null,
        }), options.status ?? 200);
    }

    async function handleSave(request: Request, name: string, csrf: string): Promise<Response> {
        if (!isAllowedOrigin(request, config)) return plain("Forbidden", 403);
        const form = await readForm(request, config.maxEditBytes);
        if (form === null) return plain("Payload too large", 413);
        if (!safeEqual(form.get("csrf") ?? "", csrf)) return plain("Forbidden", 403);

        const saveRequest = {
            composeSource: form.get("compose") ?? "",
            envSource: form.get("env") ?? "",
            baseComposeHash: form.get("composeHash") ?? "",
            baseEnvHash: form.get("envHash") ?? "",
            baseEnvExists: form.get("envExists") === "1",
        };

        try {
            await locks.run(name, () => {
                if (shuttingDown) throw new OperationsDisabledError();
                return saveEditableStack(stacksRoot, name, saveRequest, provider, config.maxEditBytes);
            });
            return redirect(`/stacks/${encodeURIComponent(name)}`, 303);
        } catch (error) {
            if (error instanceof StackValidationError) {
                return renderEdit(name, csrf, { error: error.message, draft: saveRequest, keepDraft: true, status: 400 });
            }
            if (error instanceof StackConflictError) {
                return renderEdit(name, csrf, { error: `${error.message} Reload to see the current content.`, keepDraft: false, status: 409 });
            }
            if (error instanceof StackBusyError || error instanceof OperationsDisabledError) {
                return htmlResponse(documentHtml("Busy", `<h1>Busy</h1><p>${escapeHtml(error.message)}</p><p><a href="/stacks/${encodeURIComponent(name)}">Back</a></p>`), 409);
            }
            if (error instanceof StackPartialError) {
                return renderEdit(name, csrf, { error: error.message, draft: saveRequest, keepDraft: true, status: 500 });
            }
            throw error;
        }
    }

    async function handleOperation(request: Request, name: string, csrf: string): Promise<Response> {
        if (!isAllowedOrigin(request, config)) return plain("Forbidden", 403);
        const form = await readForm(request);
        if (form === null) return plain("Payload too large", 413);
        if (!safeEqual(form.get("csrf") ?? "", csrf)) return plain("Forbidden", 403);

        const action = form.get("action") ?? "";
        if (!isOperationAction(action)) return renderStackDetail(name, csrf, "Unknown operation.", 400);

        // Fail closed: ambiguous or unreachable project identity never runs
        // blind. An undeployed stack can only be created (up / pull-up);
        // destructive actions require a resolved project passed as explicit -p.
        // For a new project Compose derives the identity itself, and a
        // cross-directory name clash fails inside Compose (non-zero exit),
        // never as a silent takeover.
        const context = await resolveProjectContext(stacksRoot, name, provider);
        if (context.kind === "ambiguous") {
            throw new StackError("Several Docker projects match this stack. Refusing to guess which one to control.", 409);
        }
        if (context.kind === "unavailable") {
            throw new StackError("Docker state is unavailable. Refusing to run without a verified project.", 503);
        }
        const creates = action === "up" || action === "pull-up";
        if (context.kind === "absent" && !creates) {
            throw new StackError("This stack is not deployed yet. Only Up (or Pull + up) can create it.", 409);
        }
        try {
            operations.start({
                stack: name,
                action,
                target: { project: context.project ?? undefined, composeFile: context.composeFile, cwd: context.cwd },
            });
            return redirect(`/stacks/${encodeURIComponent(name)}`, 303);
        } catch (error) {
            if (error instanceof StackBusyError || error instanceof OperationsDisabledError) {
                return renderStackDetail(name, csrf, error.message, 409);
            }
            throw error;
        }
    }

    function operationSnapshot(operation: OperationView): string {
        return JSON.stringify({
            status: operation.status,
            exitCode: operation.exitCode,
            timedOut: operation.timedOut,
            truncated: operation.truncated,
            output: operation.output,
        });
    }

    function operationDone(operation: OperationView): string {
        return JSON.stringify({
            status: operation.status,
            exitCode: operation.exitCode,
            timedOut: operation.timedOut,
            truncated: operation.truncated,
        });
    }

    /**
     * Build an SSE response around a subscription. The subscriber limit bounds
     * concurrent streams; heartbeat keeps idle streams alive through proxies;
     * the timeout bounds stream lifetime; a full buffer drops slow readers so
     * one stuck client cannot grow server memory without bound.
     */
    function sseResponse(request: Request, wire: (send: (frame: string) => void, close: () => void) => () => void): Response {
        if (activeSse >= config.sseMaxSubscribers) return plain("Too many subscriptions", 503);
        activeSse += 1;
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            activeSse -= 1;
        };
        let cleanup = () => {};
        let doClose = () => {};
        let startError: unknown = null;
        let startFailed = false;
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                const encoder = new TextEncoder();
                let closed = false;
                const close = () => {
                    if (closed) return;
                    closed = true;
                    try { cleanup(); } catch { /* ignore */ }
                    clearInterval(heartbeat);
                    clearTimeout(timeout);
                    release();
                    try { controller.close(); } catch { /* already closed */ }
                };
                doClose = close;
                const send = (frame: string) => {
                    if (closed) return;
                    // Backpressure: drop a reader that stopped consuming instead of
                    // buffering large log volumes for it indefinitely.
                    if (controller.desiredSize !== null && controller.desiredSize <= 0) {
                        close();
                        return;
                    }
                    try {
                        controller.enqueue(encoder.encode(frame));
                    } catch {
                        close();
                    }
                };
                const heartbeat = setInterval(() => send(formatSseHeartbeat()), config.sseHeartbeatMs);
                const timeout = setTimeout(close, config.sseTimeoutMs);
                const onAbort = () => close();
                if (request.signal.aborted) {
                    close();
                    return;
                }
                request.signal.addEventListener("abort", onAbort, { once: true });
                try {
                    cleanup = wire(send, close);
                } catch (error) {
                    // A synchronous subscription refusal (e.g. server shutting
                    // down) must surface as an error status, not an empty 200
                    // stream. start() runs synchronously, so rethrow below.
                    startFailed = true;
                    startError = error;
                    close();
                }
            },
            cancel() {
                doClose();
            },
        }, { highWaterMark: 64 });
        if (startFailed) throw startError;
        return new Response(stream, { headers: sseHeaders() });
    }

    async function handleOperationEvents(name: string, request: Request): Promise<Response> {
        // Validates the name and rejects unknown stacks before a slot is taken.
        await locateComposeFile(stacksRoot, name);
        return sseResponse(request, (send, close) => {
            let sentOutput = "";
            let sentTerminal = false;
            const sub = operations.subscribe(name, operation => {
                const full = operation.output;
                if (full.length >= sentOutput.length && full.startsWith(sentOutput)) {
                    const delta = full.slice(sentOutput.length);
                    sentOutput = full;
                    if (delta) send(formatSseEvent("output", delta));
                } else {
                    sentOutput = full;
                    send(formatSseEvent("snapshot", operationSnapshot(operation)));
                    return;
                }
                if (operation.status !== "running" && !sentTerminal) {
                    sentTerminal = true;
                    send(formatSseEvent("done", operationDone(operation)));
                    close();
                }
            });
            sentOutput = sub.snapshot?.output ?? "";
            if (sub.snapshot) send(formatSseEvent("snapshot", operationSnapshot(sub.snapshot)));
            else send(formatSseEvent("snapshot", JSON.stringify({ status: "none" })));
            return sub.unsubscribe;
        });
    }

    async function handleLogsEvents(name: string, request: Request): Promise<Response> {
        // Same fail-closed context as mutations: a follow without a verified
        // project could attach to the wrong one. An undeployed stack simply
        // yields an empty/ended stream.
        const context = await resolveProjectContext(stacksRoot, name, provider);
        if (context.kind === "ambiguous") {
            throw new StackError("Several Docker projects match this stack. Refusing to guess which logs to follow.", 409);
        }
        if (context.kind === "unavailable") {
            throw new StackError("Docker state is unavailable. Refusing to follow without a verified project.", 503);
        }
        const target = { project: context.project ?? undefined, composeFile: context.composeFile, cwd: context.cwd };
        return sseResponse(request, (send, close) => {
            const sub = logs.subscribe(
                name,
                target,
                chunk => send(formatSseEvent("chunk", chunk)),
                reason => {
                    send(formatSseEvent("end", reason === "timeout" ? "Follow stopped: time limit reached." : "Follow ended."));
                    close();
                },
            );
            send(formatSseEvent("replay", JSON.stringify({ text: sub.replay.text, truncated: sub.replay.truncated })));
            return sub.unsubscribe;
        });
    }

    function sseError(error: unknown): Response {
        if (error instanceof StackError) return plain(error.message, error.status);
        console.error("Internal error", error);
        return plain("Internal error.", 500);
    }

    async function fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        const method = request.method.toUpperCase();

        if (url.pathname === "/health/live") {
            if (method !== "GET") return methodNotAllowed("GET");
            return new Response("ok", { headers: { "Content-Type": "text/plain; charset=utf-8", ...BASE_HEADERS } });
        }
        if (url.pathname === "/styles.css") {
            if (method !== "GET") return methodNotAllowed("GET");
            return new Response(Bun.file(new URL("../public/style.css", import.meta.url)), {
                headers: { "Content-Type": "text/css; charset=utf-8", ...BASE_HEADERS },
            });
        }
        if (url.pathname === "/app.js") {
            if (method !== "GET") return methodNotAllowed("GET");
            return new Response(Bun.file(new URL("../public/app.js", import.meta.url)), {
                headers: { "Content-Type": "text/javascript; charset=utf-8", ...BASE_HEADERS },
            });
        }
        const brandFile = BRAND_FILES[url.pathname];
        if (brandFile) {
            if (method !== "GET") return methodNotAllowed("GET");
            return new Response(Bun.file(new URL(`../public/${brandFile.file}`, import.meta.url)), {
                headers: { "Content-Type": brandFile.type, ...BASE_HEADERS },
            });
        }
        if (url.pathname === "/login") {
            if (method === "GET") return handleLoginGet(request);
            if (method === "POST") return handleLoginPost(request);
            return methodNotAllowed("GET, POST");
        }

        const opEventsMatch = /^\/stacks\/([^/]+)\/operations\/events$/.exec(url.pathname);
        const logEventsMatch = /^\/stacks\/([^/]+)\/logs\/events$/.exec(url.pathname);
        const isEventStream = opEventsMatch !== null || logEventsMatch !== null;

        // Everything below requires an authenticated session. Event streams
        // answer 401 instead of a login redirect so clients do not parse HTML.
        const cookies = parseCookies(request.headers.get("cookie"));
        const id = cookies[SESSION_COOKIE];
        const session = id ? sessions.get(id) : null;
        if (!session) {
            if (isEventStream) return plain("Unauthorized", 401);
            if (method === "GET" || method === "HEAD") return redirect("/login", 302);
            return plain("Unauthorized", 401);
        }

        if (isEventStream) {
            if (method !== "GET") return methodNotAllowed("GET");
            try {
                if (opEventsMatch) return await handleOperationEvents(decodeName(opEventsMatch[1]!), request);
                return await handleLogsEvents(decodeName(logEventsMatch![1]!), request);
            } catch (error) {
                return sseError(error);
            }
        }

        if (url.pathname === "/logout") {
            if (method !== "POST") return methodNotAllowed("POST");
            const form = await readForm(request);
            if (form === null) return plain("Payload too large", 413);
            if (!isAllowedOrigin(request, config) || !safeEqual(form.get("csrf") ?? "", session.csrf)) {
                return plain("Forbidden", 403);
            }
            sessions.destroy(session.id);
            const response = redirect("/login", 303);
            response.headers.append("Set-Cookie", clearedSessionCookie(config.cookieSecure));
            return response;
        }

        const editMatch = /^\/stacks\/([^/]+)\/edit$/.exec(url.pathname);
        if (editMatch && method === "POST") {
            try { return await handleSave(request, decodeName(editMatch[1]!), session.csrf); }
            catch (error) { return routeError(error, session.csrf); }
        }
        const operationsMatch = /^\/stacks\/([^/]+)\/operations$/.exec(url.pathname);
        if (operationsMatch) {
            if (method !== "POST") return methodNotAllowed("POST");
            try { return await handleOperation(request, decodeName(operationsMatch[1]!), session.csrf); }
            catch (error) { return routeError(error, session.csrf); }
        }
        if (method !== "GET" && method !== "HEAD") return methodNotAllowed("GET");

        try {
            if (url.pathname === "/") return await renderStackList(session.csrf);
            if (editMatch) return await renderEdit(decodeName(editMatch[1]!), session.csrf);
            const detailMatch = /^\/stacks\/([^/]+)$/.exec(url.pathname);
            if (detailMatch) return await renderStackDetail(decodeName(detailMatch[1]!), session.csrf);
            return htmlResponse(documentHtml("Not found", "<h1>Page not found</h1>", { logoutCsrf: session.csrf }), 404);
        } catch (error) {
            return routeError(error, session.csrf);
        }
    }

    return {
        fetch,
        operations,
        logs,
        sseSubscriptions: () => activeSse,
        beginShutdown: async (graceMs: number) => {
            // Refuse everything synchronously first: no new mutation, save or
            // follow can slip in while the drains below are awaited.
            shuttingDown = true;
            operations.refuseNew();
            logs.refuseNew();
            // One shared deadline for both drains; unresolved work stays
            // unknown and is never reported as done.
            await Promise.race([
                Promise.allSettled([logs.shutdown(graceMs), operations.shutdown(graceMs)]),
                new Promise<void>(resolve => setTimeout(resolve, graceMs)),
            ]);
        },
    };
}
