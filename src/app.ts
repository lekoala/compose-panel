import { escapeHtml, documentHtml, editPage, htmlResponse, loginPage, logsPanel, messagePage, note, operationControls, operationPanel, servicesSection, stateBadge, auditPage, type NoteKind } from "./html.ts";
import { dirname, join } from "node:path";
import { locateComposeFile, readStackCompose, StackError } from "./stacks.ts";
import { loadStackDetail, loadStackStates, resolveProjectContext, type StackDetailStatus } from "./status.ts";
import { StackConflictError, StackPartialError, StackValidationError, readEditableStack, saveEditableStack } from "./editor.ts";
import { StackBusyError, StackLocks } from "./locks.ts";
import { OperationManager, OperationsDisabledError, isOperationAction, type OperationView } from "./operations.ts";
import { LogManager } from "./logs.ts";
import { AuditLog, AuditError } from "./audit.ts";
import { formatSseEvent, formatSseHeartbeat, sseHeaders } from "./sse.ts";
import { createComposeProvider, type ComposeProvider } from "./compose-provider.ts";
import type { DockerRunner } from "./docker.ts";
import {
    CSRF_COOKIE,
    SESSION_COOKIE,
    LoginRateLimiter,
    SessionStore,
    type Session,
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
    "Referrer-Policy": "same-origin",
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
    /** Activity log. Built from `config` and `stacksRoot` when omitted. */
    audit?: AuditLog;
}

export interface App {
    fetch(request: Request): Promise<Response>;
    operations: OperationManager;
    logs: LogManager;
    sseSubscriptions(): number;
    beginShutdown(graceMs: number): Promise<void>;
}

interface SaveDraft {
    composeSource: string;
    envSource: string;
    baseComposeHash: string;
    baseEnvHash: string;
    baseEnvExists: boolean;
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

const ENV_NOT_REGULAR = "This stack's .env is a symbolic link or not a regular file. For safety, the panel will not run Docker with it.";

const ERROR_TITLES: Record<number, string> = {
    400: "Request refused",
    404: "Not found",
    409: "Nothing was done",
    503: "Temporarily unavailable",
};

const ORIGIN_BLOCKED_MESSAGE = "Sign-in was blocked because the request did not come from this panel's own page. Open the panel address directly in a browser tab: embedding the panel in another page or app is not allowed.";

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
    if (candidate === expected) return true;
    // A sandboxed frame / opaque context sends the literal `Origin: null` (or no
    // Origin at all). Rejected by default: the panel must not be driven from an
    // embedded context. The opt-in COMPOSE_PANEL_ALLOW_OPAQUE_ORIGIN relaxes this
    // for local testing only, and only when Fetch Metadata confirms the request
    // is same-origin/none (a cross-site frame is still refused).
    if (config.allowOpaqueOrigin && (candidate === "null" || candidate === null)) {
        const site = request.headers.get("sec-fetch-site");
        return site === "same-origin" || site === "none" || site === null;
    }
    return false;
}

/** The session was revoked or expired while a mutation was being prepared. */
class SessionEndedError extends Error {}

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]", "::1"] as const;

/**
 * Accept only the loopback authorities (on the configured port) and the
 * explicitly configured public origin. This rejects an unexpected Host before
 * routing, which protects against DNS rebinding and proxy misrouting.
 */
function isAllowedHost(request: Request, config: AppConfig): boolean {
    const raw = request.headers.get("host") ?? new URL(request.url).host;
    if (!raw) return false;
    const host = raw.toLowerCase();
    const allowed = new Set<string>();
    for (const name of LOOPBACK_HOSTS) {
        allowed.add(name);
        allowed.add(`${name}:${config.port}`);
    }
    if (config.publicOrigin) {
        const origin = new URL(config.publicOrigin);
        allowed.add(origin.host.toLowerCase());
        allowed.add(origin.hostname.toLowerCase());
    }
    return allowed.has(host);
}

function clientKey(request: Request, config: AppConfig): string {
    if (config.trustProxy) {
        // The last entry is the one our own proxy appended. Earlier entries
        // come from the client and can be forged, which would let an attacker
        // dodge the throttle or put someone else's address in the audit log.
        const forwarded = request.headers.get("x-forwarded-for");
        const last = forwarded?.split(",").map(part => part.trim()).filter(Boolean).pop();
        if (last) return last;
    }
    return "direct";
}

export function createApp(options: AppOptions): App {
    const { config, stacksRoot, locks = new StackLocks() } = options;
    const provider = options.provider
        ?? createComposeProvider({ runner: options.runner ?? unavailableRunner, engine: config.composeEngine });
    const audit = options.audit ?? new AuditLog({
        dir: config.audit.dir ?? join(stacksRoot, ".compose-panel", "audit"),
        // The default layout is checked from the stacks root down, so a
        // symlinked .compose-panel cannot redirect the log.
        root: config.audit.dir ? undefined : stacksRoot,
        enabled: config.audit.enabled,
        rotation: config.audit.rotation,
        retainFiles: config.audit.retainFiles,
        maxReadLines: config.audit.maxReadLines,
        maxFileBytes: config.audit.maxFileBytes,
    });
    const operations = new OperationManager(locks, provider, {
        timeoutMs: config.operationTimeoutMs,
        maxBytes: config.dockerMaxBytes,
        // The outcome is recorded when the action ends, even if nobody watches it.
        onFinish: operation => void audit.record({
            event: "operation",
            result: operation.status,
            stack: operation.stack,
            action: operation.action,
            detail: [
                operation.exitCode !== null ? `exit code ${operation.exitCode}` : "",
                operation.timedOut ? "timed out" : "",
            ].filter(Boolean).join(", ") || undefined,
        }),
    });
    const logs = new LogManager(provider, {
        tailLines: config.logTailLines,
        maxBytes: config.logMaxBytes,
        timeoutMs: config.logTimeoutMs,
    });
    let activeSse = 0;
    let shuttingDown = false;
    const saves = new Set<Promise<unknown>>();
    const sessions = new SessionStore(config.sessionTtlMs, config.sessionIdleMs);
    // Open streams are bound to their session id so logout or expiry can close
    // them; otherwise a revoked session would keep receiving streamed output.
    const sessionStreams = new Map<string, Set<() => void>>();
    function registerStream(id: string, close: () => void): void {
        let set = sessionStreams.get(id);
        if (!set) {
            set = new Set();
            sessionStreams.set(id, set);
        }
        set.add(close);
    }
    function unregisterStream(id: string, close: () => void): void {
        const set = sessionStreams.get(id);
        if (!set) return;
        set.delete(close);
        if (set.size === 0) sessionStreams.delete(id);
    }
    function closeSessionStreams(id: string): void {
        const set = sessionStreams.get(id);
        if (!set) return;
        sessionStreams.delete(id);
        for (const close of [...set]) {
            try { close(); } catch { /* a broken stream must not block logout */ }
        }
    }
    const limiter = new LoginRateLimiter(
        config.loginRateLimit.maxAttempts,
        config.loginRateLimit.windowMs,
        config.loginRateLimit.backoffMaxMs,
    );

    function sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /** Best-effort activity record. `record` never throws, so awaiting is safe. */
    function recordAudit(event: Parameters<AuditLog["record"]>[0]): Promise<void> {
        return audit.record(event);
    }

    /** Sign-in refusals and failures: anyone can trigger them, so they are rate-capped in the log. */
    function recordLoginNoise(event: Parameters<AuditLog["record"]>[0]): Promise<void> {
        return audit.record(event, { noisy: true });
    }

    // Shared page options: sign-out form and how the panel is reached.
    const access = config.publicOrigin ? `${new URL(config.publicOrigin).host} (proxy)` : `127.0.0.1:${config.port} (loopback)`;
    function pageChrome(csrf: string | undefined): { logoutCsrf?: string; access: string; timezone?: string } {
        return { logoutCsrf: csrf, access, timezone: config.timeZone || undefined };
    }

    function sessionEnded(): Response {
        return htmlResponse(messagePage(
            "Signed out",
            "Your session has ended (signed out, timed out, or the panel restarted), so nothing was done. Sign in again, then retry.",
            { href: "/login", label: "Sign in" },
            { bare: true },
        ), 401);
    }

    async function readForm(request: Request, maxBytes = config.maxBodyBytes): Promise<URLSearchParams | null> {
        const text = await readTextLimited(request, maxBytes);
        if (text === null) return null;
        return new URLSearchParams(text);
    }

    function routeError(error: unknown, csrf?: string, stack?: string): Response {
        const status = error instanceof StackError ? error.status : 500;
        if (!(error instanceof StackError)) console.error("Internal error", error);
        const message = error instanceof StackError
            ? error.message
            : "An unexpected error occurred. Details were written to the server log.";
        const back = stack !== undefined && status !== 404
            ? { href: `/stacks/${encodeURIComponent(stack)}`, label: `← Back to ${stack}` }
            : { href: "/", label: "← Back to all stacks" };
        return htmlResponse(messagePage(ERROR_TITLES[status] ?? "Something went wrong", message, back, { ...pageChrome(csrf) }), status);
    }

    /** A form post the panel refused before doing anything (stale page, foreign origin). */
    function staleForm(csrf: string, back = "/"): Response {
        return htmlResponse(messagePage(
            "Nothing was done",
            "This page is out of date, for example because you signed in again in another tab. Go back, reload the page and try again.",
            { href: back, label: "← Go back" },
            { ...pageChrome(csrf) },
        ), 403);
    }

    function tooLarge(csrf: string, back: string): Response {
        return htmlResponse(messagePage(
            "Nothing was saved",
            `The submitted content is larger than the ${Math.floor(config.maxEditBytes / 1024)} KiB limit.`,
            { href: back, label: "← Go back" },
            { ...pageChrome(csrf) },
        ), 413);
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
        const blocked = new URL(request.url).searchParams.get("e") === "blocked";
        const response = htmlResponse(loginPage({ csrf: nonce, error: blocked ? ORIGIN_BLOCKED_MESSAGE : null }));
        response.headers.append("Set-Cookie", csrfCookie(nonce, config.cookieSecure));
        return response;
    }

    async function handleLoginPost(request: Request): Promise<Response> {
        // A blocked Origin (mismatch, or the opaque `null` of an embedded/
        // sandboxed context) is refused, but as a soft POST→GET redirect to the
        // login page with an explanation instead of a bare 403.
        if (!isAllowedOrigin(request, config)) {
            // Name both sides so a misconfigured origin is diagnosable from the log.
            const received = request.headers.get("origin") ?? (request.headers.get("referer") ? "referer only" : "none");
            const expected = config.publicOrigin ?? requestOrigin(request, config) ?? "unknown";
            await recordLoginNoise({ event: "login", result: "refused", actor: clientKey(request, config), detail: `origin blocked: received ${received}, expected ${expected}` });
            return redirect("/login?e=blocked", 303);
        }
        const form = await readForm(request);
        if (form === null) return plain("Payload too large", 413);

        const cookies = parseCookies(request.headers.get("cookie"));
        const cookieToken = cookies[CSRF_COOKIE] ?? "";
        const formToken = form.get("csrf") ?? "";
        if (!cookieToken || !formToken || !safeEqual(cookieToken, formToken)) {
            await recordLoginNoise({ event: "login", result: "refused", actor: clientKey(request, config), detail: "stale form" });
            return loginFailure("The sign-in form expired. Please sign in again.", 403);
        }

        const key = clientKey(request, config);
        // Reserve the attempt synchronously, before any awaited password work,
        // so a burst of concurrent requests cannot all pass the limit before the
        // first failure is recorded. A per-key over-limit attempt is not refused
        // (that would let an attacker lock out the real admin); it is delayed.
        // Only a parallel attempt from the same key is refused, so a source
        // cannot bypass its own delay. The reservation is settled below.
        const verdict = limiter.tryReserve(key);
        if (!verdict.allowed && verdict.reason === "capacity") {
            await recordLoginNoise({ event: "login", result: "refused", actor: key, detail: "too many sources tracked" });
            return loginFailure("The panel is busy with sign-in attempts from many addresses. Try again later.", 429, verdict.retryAfterSec);
        }
        if (!verdict.allowed) {
            await recordLoginNoise({ event: "login", result: "refused", actor: key, detail: "parallel attempt" });
            return loginFailure("Another sign-in attempt from your address is still being checked. Try again in a moment.", 429, verdict.retryAfterSec);
        }

        const user = form.get("user") ?? "";
        const password = form.get("password") ?? "";
        let success = false;
        let slotHeld = false;
        try {
            // Wait before taking a global verification slot, so delayed attempts
            // never hold one of the scarce slots while sleeping.
            if (verdict.delayMs > 0) await sleep(verdict.delayMs);
            slotHeld = limiter.acquireSlot();
            if (!slotHeld) {
                await recordLoginNoise({ event: "login", result: "refused", actor: key, detail: "verification capacity reached" });
                return loginFailure("The panel is busy with other sign-in attempts. Try again in a moment.", 429, 1);
            }
            // Verify unconditionally to keep the response time independent of the username.
            const passwordOk = await verifyPassword(config.adminPasswordHash, password);
            success = passwordOk && user === config.adminUser;
            if (!success) {
                // Never log the typed username itself: people regularly type
                // their password into that field by mistake.
                await recordLoginNoise({
                    event: "login",
                    result: "failure",
                    actor: key,
                    username: user === config.adminUser ? "admin account" : "unknown user",
                    detail: verdict.delayMs > 0 ? "over limit, delayed" : undefined,
                });
                return loginFailure("Wrong username or password.", 401);
            }
            await recordAudit({ event: "login", result: "success", actor: key });

            const session = sessions.create(config.adminUser);
            const response = redirect("/", 303);
            response.headers.append(
                "Set-Cookie",
                sessionCookie(session.id, { secure: config.cookieSecure, maxAgeSec: Math.floor(config.sessionTtlMs / 1000) }),
            );
            return response;
        } finally {
            limiter.settle(key, success, slotHeld);
        }
    }

    async function renderStackList(csrf: string): Promise<Response> {
        const { stacks, dockerNote } = await loadStackStates(stacksRoot, provider);
        const intro = `<p class="lead">Stacks in <code>${escapeHtml(stacksRoot)}</code></p>`;
        let content: string;
        if (stacks.length === 0) {
            content = `<section class="card empty"><h2>No stacks found</h2>`
                + `<p>Create a folder in <code>${escapeHtml(stacksRoot)}</code> with a <code>compose.yaml</code> (or <code>compose.yml</code>, <code>docker-compose.yaml</code>, <code>docker-compose.yml</code>) and reload this page.</p>`
                + `<p class="muted">Folder names may use lowercase letters, digits, <code>-</code> and <code>_</code>.</p>`
                + `<p class="muted">The panel never takes ownership of your stacks: the Compose files stay where they are, and every stack can still be managed with the <code>docker compose</code> CLI.</p></section>`;
        } else {
            const counts = new Map<string, number>();
            for (const stack of stacks) counts.set(stack.state, (counts.get(stack.state) ?? 0) + 1);
            // One tile per state present, in a fixed order; colors match the badges.
            const tiles = ([["running", "Running"], ["stopped", "Stopped"], ["not-created", "Not deployed"], ["unknown", "Unknown"]] as const)
                .filter(([state]) => counts.has(state))
                .map(([state, label]) => `<div class="stat stat-${state}"><span class="stat-value">${counts.get(state)}</span><span class="stat-label">${label}</span></div>`)
                .join("");
            const rows = stacks.map(stack => {
                const href = `/stacks/${encodeURIComponent(stack.name)}`;
                // The Docker-wide note is shown once above the table, not on every row.
                const rowNote = stack.note && stack.note !== dockerNote ? `<div class="hint">${escapeHtml(stack.note)}</div>` : "";
                return `<tr><td><a href="${href}" class="stack-name">${escapeHtml(stack.name)}</a>${rowNote}</td>`
                    + `<td>${stateBadge(stack.state)}</td>`
                    + `<td class="col-optional">${stack.project ? escapeHtml(stack.project) : `<span class="muted">—</span>`}</td>`
                    + `<td class="col-optional"><code>${escapeHtml(stack.composeFile)}</code></td></tr>`;
            }).join("");
            content = `<div class="stats" aria-label="Stacks by status">${tiles}</div>`
                + `<div class="table-wrap"><table class="table"><thead><tr><th>Stack</th><th>Status</th><th class="col-optional">Compose project</th><th class="col-optional">File</th></tr></thead><tbody>${rows}</tbody></table></div>`;
        }
        const warning = dockerNote ? note("warn", dockerNote) : "";
        return htmlResponse(documentHtml(
            "Stacks",
            `<h1>Stacks</h1>${intro}${warning}${content}`,
            { ...pageChrome(csrf) },
        ));
    }

    async function renderAudit(csrf: string, requested: string | null): Promise<Response> {
        const periods = await audit.listPeriods();
        const selected = requested !== null && periods.includes(requested) ? requested : periods[0] ?? null;
        let entries: Awaited<ReturnType<typeof audit.readPeriod>> = [];
        if (selected) {
            try {
                entries = await audit.readPeriod(selected, config.audit.maxReadLines);
            } catch (error) {
                if (error instanceof AuditError) throw new StackError(error.message, 404);
                throw error;
            }
        }
        return htmlResponse(auditPage({ csrf, access, timezone: config.timeZone || undefined, periods, selected, entries }));
    }

    async function renderStackDetail(name: string, csrf: string, notice?: { kind: NoteKind; text: string }, statusCode = 200): Promise<Response> {
        const stack = await readStackCompose(stacksRoot, name);
        let status: StackDetailStatus;
        try {
            status = await loadStackDetail(stacksRoot, name, provider);
        } catch (error) {
            if (error instanceof StackError) throw error;
            status = { project: null, state: "unknown", note: "The status could not be read.", services: [] };
        }
        const href = `/stacks/${encodeURIComponent(stack.name)}`;
        const operation = operations.forStack(stack.name);
        const project = status.project
            ? `<span>Compose project <code>${escapeHtml(status.project)}</code></span>`
            : "";
        return htmlResponse(documentHtml(
            stack.name,
            `<p class="crumbs"><a href="/">← All stacks</a></p>`
            + `<div class="page-head"><h1>${escapeHtml(stack.name)}</h1><a href="${href}/edit" class="btn">Edit files</a></div>`
            + `<p class="meta">${stateBadge(status.state)}<span><code>${escapeHtml(stack.filename)}</code></span>${project}</p>`
            + (notice ? note(notice.kind, notice.text) : "")
            + (status.note ? note("warn", status.note) : "")
            + operationControls(stack.name, csrf, { busy: operation?.status === "running", deployed: status.state !== "not-created", updatesReady: Object.keys(status.updates ?? {}) })
            + operationPanel(operation, stack.name)
            + servicesSection(status.services, status.state, status.updates)
            + logsPanel(stack.name, config.logTailLines, config.timeZone)
            + `<section class="card"><details><summary>${escapeHtml(stack.filename)}</summary><pre class="output">${escapeHtml(stack.source)}</pre></details></section>`,
            { ...pageChrome(csrf), scripts: ["/app.js"] },
        ), statusCode);
    }

    function decodeName(raw: string): string {
        try { return decodeURIComponent(raw); }
        catch { throw new StackError("This stack name is not valid."); }
    }

    function safeName(raw: string): string | undefined {
        try { return decodeURIComponent(raw); }
        catch { return undefined; }
    }

    async function renderEdit(
        name: string,
        csrf: string,
        options: { error?: { title: string; message: string }; draft?: SaveDraft; keepDraft?: boolean; status?: number } = {},
    ): Promise<Response> {
        const stack = await readEditableStack(stacksRoot, name, config.maxEditBytes);
        const draft = options.keepDraft === true ? options.draft : undefined;
        return htmlResponse(editPage({
            name,
            csrf,
            access,
            timezone: config.timeZone || undefined,
            composeFilename: stack.composeFilename,
            // A kept draft keeps the versions it was based on, so a change made
            // on disk meanwhile is still detected as a conflict on the next save.
            composeSource: draft ? draft.composeSource : stack.composeSource,
            composeHash: draft ? draft.baseComposeHash : stack.composeHash,
            envSource: draft ? draft.envSource : stack.envSource,
            envHash: draft ? draft.baseEnvHash : stack.envHash,
            envExists: draft ? draft.baseEnvExists : stack.envExists,
            error: options.error ?? null,
        }), options.status ?? 200);
    }

    async function handleSave(request: Request, name: string, session: Session): Promise<Response> {
        const csrf = session.csrf;
        const back = `/stacks/${encodeURIComponent(name)}/edit`;
        if (!isAllowedOrigin(request, config)) return staleForm(csrf, back);
        const form = await readForm(request, config.maxEditBytes);
        if (form === null) return tooLarge(csrf, back);
        if (!safeEqual(form.get("csrf") ?? "", csrf)) return staleForm(csrf, back);
        // The body may have arrived long after the session was checked.
        if (!sessions.isActive(session.id)) return sessionEnded();

        const saveRequest = {
            composeSource: form.get("compose") ?? "",
            envSource: form.get("env") ?? "",
            baseComposeHash: form.get("composeHash") ?? "",
            baseEnvHash: form.get("envHash") ?? "",
            baseEnvExists: form.get("envExists") === "1",
        };

        try {
            const task = locks.run(name, () => {
                if (shuttingDown) throw new OperationsDisabledError();
                return saveEditableStack(stacksRoot, name, saveRequest, provider, config.maxEditBytes, {
                    // Validation awaits a subprocess: re-check right before writing.
                    beforeCommit: () => { if (!sessions.isActive(session.id)) throw new SessionEndedError(); },
                });
            });
            saves.add(task);
            let result: Awaited<typeof task>;
            try { result = await task; }
            finally { saves.delete(task); }
            await recordAudit({ event: "save", result: result.changed ? "success" : "no-change", actor: clientKey(request, config), stack: name });
            return redirect(`/stacks/${encodeURIComponent(name)}?saved=${result.changed ? "1" : "0"}`, 303);
        } catch (error) {
            if (error instanceof StackValidationError) {
                await recordAudit({ event: "save", result: "failure", actor: clientKey(request, config), stack: name, detail: "validation failed" });
                return renderEdit(name, csrf, { error: { title: "Not saved: the Compose check failed.", message: error.message }, draft: saveRequest, keepDraft: true, status: 400 });
            }
            if (error instanceof StackConflictError) {
                await recordAudit({ event: "save", result: "conflict", actor: clientKey(request, config), stack: name });
                return renderEdit(name, csrf, {
                    error: { title: "Not saved.", message: `${error.message} The editor now shows the current files: apply your changes again, then save.` },
                    keepDraft: false,
                    status: 409,
                });
            }
            if (error instanceof StackBusyError || error instanceof OperationsDisabledError) {
                // Keep the draft: nothing was written, the user can retry.
                await recordAudit({ event: "save", result: "refused", actor: clientKey(request, config), stack: name, detail: error.message });
                return renderEdit(name, csrf, { error: { title: "Not saved.", message: error.message }, draft: saveRequest, keepDraft: true, status: 409 });
            }
            if (error instanceof SessionEndedError) {
                await recordAudit({ event: "save", result: "refused", actor: clientKey(request, config), stack: name, detail: "session ended" });
                return sessionEnded();
            }
            if (error instanceof StackPartialError) {
                await recordAudit({ event: "save", result: "partial", actor: clientKey(request, config), stack: name });
                return renderEdit(name, csrf, { error: { title: "Save incomplete.", message: error.message }, draft: saveRequest, keepDraft: true, status: 500 });
            }
            throw error;
        }
    }

    async function handleOperation(request: Request, name: string, session: Session): Promise<Response> {
        const csrf = session.csrf;
        const back = `/stacks/${encodeURIComponent(name)}`;
        if (!isAllowedOrigin(request, config)) return staleForm(csrf, back);
        const form = await readForm(request);
        if (form === null) return tooLarge(csrf, back);
        if (!safeEqual(form.get("csrf") ?? "", csrf)) return staleForm(csrf, back);
        // The body may have arrived long after the session was checked.
        if (!sessions.isActive(session.id)) return sessionEnded();

        const action = form.get("action") ?? "";
        if (!isOperationAction(action)) return renderStackDetail(name, csrf, { kind: "error", text: "Unknown action. Nothing was run." }, 400);

        // Fail closed: ambiguous or unreachable project identity never runs
        // blind. An undeployed stack can only be created (up / pull-up) or have
        // its images downloaded (pull, which touches no container); destructive
        // actions require a resolved project passed as explicit -p. Resolve a
        // new project's effective name through Compose, check for collisions,
        // then pin that identity explicitly.
        const creates = action === "up" || action === "pull-up" || action === "pull";
        const context = await resolveProjectContext(stacksRoot, name, provider, creates);
        if (context.kind === "invalid") {
            throw new StackError(ENV_NOT_REGULAR, 409);
        }
        if (context.kind === "ambiguous") {
            throw new StackError("The panel cannot tell which Docker Compose project belongs to this stack: several projects match, or the project name is already used by another stack. It will not guess, so nothing was run.", 409);
        }
        if (context.kind === "unavailable") {
            throw new StackError("Docker did not respond, so the panel could not check which project this stack belongs to. Nothing was run.", 503);
        }
        if (context.kind === "absent" && !creates) {
            throw new StackError("This stack is not deployed yet, so there is nothing to stop, restart or remove. Use Up or Pull + up to create it.", 409);
        }
        // Project discovery awaits Docker: re-check before starting anything.
        if (!sessions.isActive(session.id)) {
            await recordAudit({ event: "operation", result: "refused", actor: clientKey(request, config), stack: name, action, detail: "session ended" });
            return sessionEnded();
        }
        try {
            operations.start({
                stack: name,
                action,
                target: { project: context.project ?? undefined, composeFile: context.composeFile, cwd: context.cwd, envFile: context.envFile ?? undefined },
            });
            await recordAudit({ event: "operation", result: "started", actor: clientKey(request, config), stack: name, action });
            return redirect(`/stacks/${encodeURIComponent(name)}`, 303);
        } catch (error) {
            if (error instanceof StackBusyError || error instanceof OperationsDisabledError) {
                await recordAudit({ event: "operation", result: "refused", actor: clientKey(request, config), stack: name, action, detail: error.message });
                return renderStackDetail(name, csrf, { kind: "error", text: `${error.message} Nothing was run.` }, 409);
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
            startedAt: operation.startedAt,
            endedAt: operation.endedAt,
            output: operation.output,
        });
    }

    function operationDone(operation: OperationView): string {
        return JSON.stringify({
            status: operation.status,
            exitCode: operation.exitCode,
            timedOut: operation.timedOut,
            truncated: operation.truncated,
            startedAt: operation.startedAt,
            endedAt: operation.endedAt,
        });
    }

    /**
     * Build an SSE response around a subscription. The subscriber limit bounds
     * concurrent streams; heartbeat keeps idle streams alive through proxies;
     * the timeout bounds stream lifetime; a full buffer drops slow readers so
     * one stuck client cannot grow server memory without bound.
     */
    function sseResponse(request: Request, wire: (send: (frame: string) => void, close: () => void) => () => void, guard?: { id: string; isAlive: () => boolean }): Response {
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
                    if (guard) unregisterStream(guard.id, close);
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
                const heartbeat = setInterval(() => {
                    // Expiry check must not itself refresh idle activity, so a
                    // stream cannot keep a session alive past its limits.
                    if (guard && !guard.isAlive()) {
                        close();
                        return;
                    }
                    send(formatSseHeartbeat());
                }, config.sseHeartbeatMs);
                const timeout = setTimeout(close, config.sseTimeoutMs);
                const onAbort = () => close();
                if (request.signal.aborted) {
                    close();
                    return;
                }
                request.signal.addEventListener("abort", onAbort, { once: true });
                try {
                    if (guard) registerStream(guard.id, close);
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

    async function handleOperationEvents(name: string, request: Request, sessionId: string): Promise<Response> {
        // Validates the name and rejects unknown stacks before a slot is taken.
        await locateComposeFile(stacksRoot, name);
        // The session may have been revoked while we awaited: re-check
        // synchronously before subscribing so a logout during discovery cannot
        // let the stream register and keep receiving data.
        if (!sessions.isActive(sessionId)) return plain("Unauthorized", 401);
        const guard = { id: sessionId, isAlive: () => sessions.isActive(sessionId) };
        return sseResponse(request, (send, close) => {
            let sentOutput = "";
            let sentTerminal = false;
            const sub = operations.subscribe(name, operation => {
                const full = operation.output;
                if (full.length >= sentOutput.length && full.startsWith(sentOutput)) {
                    const delta = full.slice(sentOutput.length);
                    sentOutput = full;
                    if (delta) send(formatSseEvent("output", JSON.stringify({ text: delta })));
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
        }, guard);
    }

    async function handleLogsEvents(name: string, request: Request, sessionId: string): Promise<Response> {
        // Same fail-closed context as mutations: a follow without a verified
        // project could attach to the wrong one. An undeployed stack simply
        // yields an empty/ended stream.
        const context = await resolveProjectContext(stacksRoot, name, provider);
        if (context.kind === "invalid") {
            throw new StackError(ENV_NOT_REGULAR, 409);
        }
        if (context.kind === "ambiguous") {
            throw new StackError("Several Docker Compose projects match this stack. The panel will not guess which logs to follow.", 409);
        }
        if (context.kind === "unavailable") {
            throw new StackError("Docker did not respond, so the panel could not check which project's logs to follow.", 503);
        }
        if (shuttingDown) throw new StackError("The panel is shutting down and no longer starts log streams.", 503);
        // Re-check the session after the awaited discovery, before subscribing.
        if (!sessions.isActive(sessionId)) return plain("Unauthorized", 401);
        const guard = { id: sessionId, isAlive: () => sessions.isActive(sessionId) };
        if (context.kind === "absent") {
            return sseResponse(request, (send, close) => {
                send(formatSseEvent("replay", JSON.stringify({ text: "", truncated: false })));
                send(formatSseEvent("end", "This stack is not deployed yet, so there are no logs."));
                close();
                return () => {};
            }, guard);
        }
        const target = { project: context.project ?? undefined, composeFile: context.composeFile, cwd: context.cwd, envFile: context.envFile ?? undefined };
        return sseResponse(request, (send, close) => {
            const sub = logs.subscribe(
                name,
                target,
                chunk => send(formatSseEvent("chunk", JSON.stringify({ text: chunk }))),
                reason => {
                    send(formatSseEvent("end", reason === "timeout"
                        ? `Stopped following after ${Math.round(config.logTimeoutMs / 60000)} minutes (time limit). Click Follow logs to continue.`
                        : "The log stream ended, usually because the containers stopped."));
                    close();
                },
            );
            send(formatSseEvent("replay", JSON.stringify({ text: sub.replay.text, truncated: sub.replay.truncated })));
            return sub.unsubscribe;
        }, guard);
    }

    function sseError(error: unknown): Response {
        if (error instanceof StackError) return plain(error.message, error.status);
        console.error("Internal error", error);
        return plain("Internal error.", 500);
    }

    async function fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        const method = request.method.toUpperCase();

        // Reject an unexpected Host before any routing. Health probes are
        // exempt so infrastructure checks with a service-name Host still work.
        if (url.pathname !== "/health/live" && !isAllowedHost(request, config)) {
            return plain("Invalid Host header.", 400);
        }

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
            return sessionEnded();
        }

        if (isEventStream) {
            if (method !== "GET") return methodNotAllowed("GET");
            try {
                if (opEventsMatch) return await handleOperationEvents(decodeName(opEventsMatch[1]!), request, session.id);
                return await handleLogsEvents(decodeName(logEventsMatch![1]!), request, session.id);
            } catch (error) {
                return sseError(error);
            }
        }

        if (url.pathname === "/logout") {
            if (method !== "POST") return methodNotAllowed("POST");
            const form = await readForm(request);
            if (form === null) return plain("Payload too large", 413);
            if (!isAllowedOrigin(request, config) || !safeEqual(form.get("csrf") ?? "", session.csrf)) {
                return staleForm(session.csrf);
            }
            sessions.destroy(session.id);
            closeSessionStreams(session.id);
            await recordAudit({ event: "logout", result: "success", actor: clientKey(request, config) });
            const response = redirect("/login", 303);
            response.headers.append("Set-Cookie", clearedSessionCookie(config.cookieSecure));
            return response;
        }

        const editMatch = /^\/stacks\/([^/]+)\/edit$/.exec(url.pathname);
        if (editMatch && method === "POST") {
            try { return await handleSave(request, decodeName(editMatch[1]!), session); }
            catch (error) { return routeError(error, session.csrf, safeName(editMatch[1]!)); }
        }
        const operationsMatch = /^\/stacks\/([^/]+)\/operations$/.exec(url.pathname);
        if (operationsMatch) {
            if (method !== "POST") return methodNotAllowed("POST");
            try { return await handleOperation(request, decodeName(operationsMatch[1]!), session); }
            catch (error) { return routeError(error, session.csrf, safeName(operationsMatch[1]!)); }
        }
        if (method !== "GET" && method !== "HEAD") return methodNotAllowed("GET");

        try {
            if (url.pathname === "/") return await renderStackList(session.csrf);
            if (url.pathname === "/audit") return await renderAudit(session.csrf, url.searchParams.get("period"));
            if (editMatch) return await renderEdit(decodeName(editMatch[1]!), session.csrf);
            const detailMatch = /^\/stacks\/([^/]+)$/.exec(url.pathname);
            if (detailMatch) {
                // Fixed messages only: the query flag is never reflected.
                const saved = url.searchParams.get("saved");
                const notice = saved === "1"
                    ? { kind: "success" as const, text: "Saved. The running containers are unchanged: use Up to apply the new configuration." }
                    : saved === "0" ? { kind: "info" as const, text: "No changes to save: the files on disk already match." } : undefined;
                return await renderStackDetail(decodeName(detailMatch[1]!), session.csrf, notice);
            }
            return htmlResponse(messagePage("Not found", "This page does not exist.", { href: "/", label: "← Back to all stacks" }, pageChrome(session.csrf)), 404);
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
            // One shared deadline for operations, saves and follows; unresolved work stays
            // unknown and is never reported as done.
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                await Promise.race([
                    Promise.allSettled([logs.shutdown(graceMs), operations.shutdown(graceMs), ...saves]),
                    new Promise<void>(resolve => { timer = setTimeout(resolve, graceMs); }),
                ]);
            } finally { clearTimeout(timer); }
        },
    };
}
