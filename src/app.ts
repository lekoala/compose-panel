import { escapeHtml, documentHtml, htmlResponse, loginPage } from "./html.ts";
import { listStacks, readStackCompose, StackError } from "./stacks.ts";
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

export interface AppOptions {
    config: AppConfig;
    /** Absolute, canonical stacks directory resolved at startup. */
    stacksRoot: string;
}

export interface App {
    fetch(request: Request): Promise<Response>;
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

export function createApp({ config, stacksRoot }: AppOptions): App {
    const sessions = new SessionStore(config.sessionTtlMs, config.sessionIdleMs);
    const limiter = new LoginRateLimiter(
        config.loginRateLimit.maxAttempts,
        config.loginRateLimit.windowMs,
        config.loginRateLimit.blockMs,
    );

    async function readForm(request: Request): Promise<URLSearchParams | null> {
        const text = await readTextLimited(request, config.maxBodyBytes);
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
        if (url.pathname === "/login") {
            if (method === "GET") return handleLoginGet(request);
            if (method === "POST") return handleLoginPost(request);
            return methodNotAllowed("GET, POST");
        }

        // Everything below requires an authenticated session.
        const cookies = parseCookies(request.headers.get("cookie"));
        const id = cookies[SESSION_COOKIE];
        const session = id ? sessions.get(id) : null;
        if (!session) {
            if (method === "GET" || method === "HEAD") return redirect("/login", 302);
            return plain("Unauthorized", 401);
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

        if (method !== "GET" && method !== "HEAD") return methodNotAllowed("GET");

        try {
            if (url.pathname === "/") {
                const stacks = await listStacks(stacksRoot);
                const rows = stacks.length
                    ? stacks.map(stack => `<li><a href="/stacks/${encodeURIComponent(stack.name)}">${escapeHtml(stack.name)}</a><small>${escapeHtml(stack.composeFile)}</small></li>`).join("")
                    : `<li>No recognized Compose stack.</li>`;
                return htmlResponse(documentHtml(
                    "Stacks",
                    `<h1>Stacks</h1><p>Read-only — no Docker command is executed.</p><ul class="stack-list">${rows}</ul>`,
                    { logoutCsrf: session.csrf },
                ));
            }
            const match = /^\/stacks\/([^/]+)$/.exec(url.pathname);
            if (match) {
                let name: string;
                try { name = decodeURIComponent(match[1]!); }
                catch { throw new StackError("Invalid name encoding."); }
                const stack = await readStackCompose(stacksRoot, name);
                return htmlResponse(documentHtml(
                    stack.name,
                    `<p><a href="/">← All stacks</a></p><h1>${escapeHtml(stack.name)}</h1><p>${escapeHtml(stack.filename)} · read-only</p><pre>${escapeHtml(stack.source)}</pre>`,
                    { logoutCsrf: session.csrf },
                ));
            }
            return htmlResponse(documentHtml("Not found", "<h1>Page not found</h1>", { logoutCsrf: session.csrf }), 404);
        } catch (error) {
            return routeError(error, session.csrf);
        }
    }

    return { fetch };
}
