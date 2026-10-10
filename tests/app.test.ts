import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp, type App } from "../src/app.ts";
import { AuditLog } from "../src/audit.ts";
import type { AppConfig } from "../src/config.ts";
import type { CommandResult, DockerRunner } from "../src/docker.ts";
import type { ComposeCapabilities, ComposeProvider, ComposeTarget } from "../src/compose-provider.ts";
import { resolveRoot } from "../src/stacks.ts";

const PASSWORD = "correct horse battery staple";
const ORIGIN = "http://localhost";
let root: string;
let passwordHash: string;

beforeAll(async () => {
    root = await resolveRoot(await mkdtemp(join(tmpdir(), "compose-panel-app-")));
    await mkdir(join(root, "demo"));
    await writeFile(join(root, "demo", "compose.yaml"), "services:\n  app:\n    image: nginx:alpine\n");
    passwordHash = await Bun.password.hash(PASSWORD);
});

afterAll(async () => {
    await rm(root, { recursive: true, force: true });
});

function makeApp(overrides: Partial<AppConfig> = {}, runner?: DockerRunner, provider?: ComposeProvider, audit?: AuditLog): App {
    const config: AppConfig = {
        stacksDir: root,
        port: 5081,
        adminUser: "admin",
        adminPasswordHash: passwordHash,
        cookieSecure: false,
        publicOrigin: null,
        trustProxy: false,
        allowOpaqueOrigin: false,
        devMode: false,
        sessionTtlMs: 3_600_000,
        sessionIdleMs: 3_600_000,
        loginRateLimit: { windowMs: 60_000, maxAttempts: 5, backoffMaxMs: 1 },
        audit: { enabled: true, dir: null, rotation: "day", retainFiles: 31, maxReadLines: 2000, maxFileBytes: 10 * 1024 * 1024 },
        maxBodyBytes: 8192,
        maxEditBytes: 1024 * 1024,
        dockerPath: "docker",
        composeEngine: "docker",
        dockerTimeoutMs: 5000,
        dockerMaxBytes: 1024 * 1024,
        operationTimeoutMs: 60_000,
        shutdownGraceMs: 5_000,
        sseHeartbeatMs: 15_000,
        sseTimeoutMs: 1_800_000,
        sseMaxSubscribers: 100,
        logTailLines: 200,
        logMaxBytes: 262_144,
        logTimeoutMs: 1_800_000,
        ...overrides,
    };
    return createApp({ config, stacksRoot: root, runner, provider, audit });
}

interface FollowCall {
    target: ComposeTarget & { tailLines?: number };
    onChunk: (chunk: string) => void;
    signal: AbortSignal;
}

/** Provider with a controllable `logs --follow` for SSE tests. No subprocess. */
function controllableProvider(): { provider: ComposeProvider; calls: FollowCall[] } {
    const calls: FollowCall[] = [];
    const caps: ComposeCapabilities = { engine: "fake", available: true, operations: { ls: true, ps: true, config: true, logs: true } };
    const empty: CommandResult = { code: 0, stdout: "[]", stderr: "", timedOut: false, truncated: false };
    const provider: ComposeProvider = {
        engine: "fake",
        capabilities: () => caps,
        detect: async () => caps,
        listProjects: async () => ({ ...empty, stdout: JSON.stringify([{ Name: "demo-proj", Status: "running(1)", ConfigFiles: join(root, "demo", "compose.yaml") }]) }),
        projectName: async () => "demo-proj",
        projectServices: async () => empty,
        validateConfig: async () => empty,
        pull: async () => empty,
        up: async () => empty,
        stop: async () => empty,
        restart: async () => empty,
        down: async () => empty,
        followLogs: (followTarget, onChunk, signal) => new Promise(resolve => {
            calls.push({ target: followTarget, onChunk, signal });
            signal.addEventListener("abort", () => resolve({ code: 137, timedOut: false }), { once: true });
        }),
    };
    return { provider, calls };
}

async function readSseUntil(reader: ReadableStreamDefaultReader<Uint8Array>, marker: string, maxMs = 5000): Promise<string> {
    const decoder = new TextDecoder();
    let text = "";
    const deadline = Date.now() + maxMs;
    while (!text.includes(marker) && Date.now() < deadline) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
    }
    return text;
}

function sseReader(response: Response): ReadableStreamDefaultReader<Uint8Array> {
    return response.body!.getReader();
}

function setCookies(response: Response): string[] {
    const headers = response.headers as unknown as { getSetCookie?: () => string[] };
    if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
    const single = response.headers.get("set-cookie");
    return single ? [single] : [];
}

function cookieValue(cookies: string[], name: string): string | null {
    for (const cookie of cookies) {
        if (cookie.startsWith(`${name}=`)) return cookie.slice(name.length + 1).split(";")[0]!;
    }
    return null;
}

async function loginCsrf(app: App): Promise<{ cookie: string; csrf: string }> {
    const response = await app.fetch(new Request(`${ORIGIN}/login`));
    const cookie = cookieValue(setCookies(response), "cp_csrf");
    const html = await response.text();
    const match = /name="csrf" value="([^"]+)"/.exec(html);
    return { cookie: cookie!, csrf: match![1]! };
}

function postLogin(app: App, cookie: string, csrf: string, user: string, password: string, origin: string = ORIGIN): Promise<Response> {
    return app.fetch(new Request(`${ORIGIN}/login`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin, cookie: `cp_csrf=${cookie}` },
        body: new URLSearchParams({ csrf, user, password }).toString(),
    }));
}

async function login(app: App): Promise<string> {
    const { cookie, csrf } = await loginCsrf(app);
    const response = await postLogin(app, cookie, csrf, "admin", PASSWORD);
    return cookieValue(setCookies(response), "cp_session")!;
}

function authed(app: App, path: string, session: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("cookie", `cp_session=${session}`);
    return app.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers }));
}

describe("public routes", () => {
    test("serves health and stylesheet without a session", async () => {
        const app = makeApp();
        expect((await app.fetch(new Request(`${ORIGIN}/health/live`))).status).toBe(200);
        expect((await app.fetch(new Request(`${ORIGIN}/styles.css`))).status).toBe(200);
    });

    test("serves brand assets without a session", async () => {
        const app = makeApp();
        const cases: [string, string][] = [
            ["/favicon.svg", "image/svg+xml"],
            ["/favicon.ico", "image/x-icon"],
            ["/apple-touch-icon.png", "image/png"],
            ["/icon-active-on-light.svg", "image/svg+xml"],
            ["/icon-active-on-dark.svg", "image/svg+xml"],
            ["/icon-boot-on-light.svg", "image/svg+xml"],
            ["/icon-boot-on-dark.svg", "image/svg+xml"],
        ];
        for (const [path, type] of cases) {
            const response = await app.fetch(new Request(`${ORIGIN}${path}`));
            expect(response.status).toBe(200);
            expect(response.headers.get("content-type")).toContain(type);
            expect(response.headers.get("cache-control")).toBe("no-store");
            expect((await response.text()).length).toBeGreaterThan(0);
        }
    });

    test("rejects unknown asset paths and non-GET brand requests", async () => {
        const app = makeApp();
        expect((await app.fetch(new Request(`${ORIGIN}/icon-evil.svg`))).status).toBe(302);
        const session = await login(app);
        expect((await authed(app, "/favicon.svg", session, { method: "POST" })).status).toBe(405);
    });
});

describe("host allow-list", () => {
    test("rejects an unexpected Host before routing", async () => {
        const app = makeApp();
        const response = await app.fetch(new Request("http://attacker.invalid:5081/login"));
        expect(response.status).toBe(400);
    });

    test("allows loopback hosts on the configured port", async () => {
        const app = makeApp();
        expect((await app.fetch(new Request("http://127.0.0.1:5081/login"))).status).toBe(200);
        expect((await app.fetch(new Request(`${ORIGIN}/login`))).status).toBe(200);
    });

    test("allows the configured public origin host", async () => {
        const app = makeApp({ publicOrigin: "https://panel.example" });
        expect((await app.fetch(new Request("https://panel.example/login"))).status).toBe(200);
        expect((await app.fetch(new Request("http://attacker.invalid:5081/login"))).status).toBe(400);
    });

    test("exempts the health probe from Host validation", async () => {
        const app = makeApp();
        expect((await app.fetch(new Request("http://panel.internal:5081/health/live"))).status).toBe(200);
    });
});

describe("auth gate", () => {
    test("redirects unauthenticated GET to the login page", async () => {
        const response = await makeApp().fetch(new Request(`${ORIGIN}/`));
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe("/login");
    });

    test("rejects unauthenticated stack reads", async () => {
        const response = await makeApp().fetch(new Request(`${ORIGIN}/stacks/demo`));
        expect(response.status).toBe(302);
    });

    test("rejects unauthenticated non-GET requests", async () => {
        const response = await makeApp().fetch(new Request(`${ORIGIN}/logout`, { method: "POST" }));
        expect(response.status).toBe(401);
    });

    test("login page has a CSRF token, no-store cache and form-action self", async () => {
        const response = await makeApp().fetch(new Request(`${ORIGIN}/login`));
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("content-security-policy")).toContain("form-action 'self'");
        // "no-referrer" makes browsers send `Origin: null` on the panel's own
        // form posts, which the strict Origin check then refuses (sign-in blocked).
        expect(response.headers.get("referrer-policy")).toBe("same-origin");
        expect(response.headers.get("content-security-policy")).toContain("img-src 'self'");
        expect(setCookies(response).some(cookie => cookie.startsWith("cp_csrf="))).toBe(true);
        const html = await response.text();
        expect(html).toContain('name="csrf"');
        expect(html).toContain('id="favicon-svg"');
        expect(html).toContain('href="/favicon.ico"');
        expect(html).toContain('href="/apple-touch-icon.png"');
        expect(html).toContain('srcset="/icon-boot-on-dark.svg"');
        expect(html).toContain('src="/icon-boot-on-light.svg"');
    });

    test("pages brand the header with the symbol and text", async () => {
        const app = makeApp();
        const session = await login(app);
        const html = await (await authed(app, "/", session)).text();
        expect(html).toContain('<img src="/favicon.svg" alt="" width="20" height="20">Compose Panel');
        expect(html).toContain('name="theme-color"');
    });

    test("a valid session unlocks the stack list and compose file", async () => {
        const app = makeApp();
        const session = await login(app);
        const list = await authed(app, "/", session);
        expect(list.status).toBe(200);
        expect(list.headers.get("cache-control")).toBe("no-store");
        expect(await list.text()).toContain("demo");

        const detail = await authed(app, "/stacks/demo", session);
        expect(detail.status).toBe(200);
        expect(await detail.text()).toContain("nginx:alpine");
    });

    test("does not expose a .env route", async () => {
        const app = makeApp();
        const session = await login(app);
        const response = await authed(app, "/stacks/demo/.env", session);
        expect(response.status).toBe(404);
    });

    test("rejects stack names that escape the root", async () => {
        const app = makeApp();
        const session = await login(app);
        const response = await authed(app, "/stacks/..%2Fsecret", session);
        expect(response.status).toBe(400);
    });
});

describe("login hardening", () => {
    test("redirects a mismatched Origin to the login page instead of a bare 403", async () => {
        const app = makeApp();
        const { cookie, csrf } = await loginCsrf(app);
        const response = await postLogin(app, cookie, csrf, "admin", PASSWORD, "http://evil.example");
        expect(response.status).toBe(303);
        expect(response.headers.get("location")).toBe("/login?e=blocked");
    });

    test("rejects a POST without the CSRF cookie", async () => {
        const app = makeApp();
        const response = await app.fetch(new Request(`${ORIGIN}/login`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN },
            body: new URLSearchParams({ csrf: "x", user: "admin", password: PASSWORD }).toString(),
        }));
        expect(response.status).toBe(403);
    });

    test("refuses a sandboxed/embedded context by default (Origin: null)", async () => {
        const app = makeApp();
        const { cookie, csrf } = await loginCsrf(app);
        const response = await app.fetch(new Request(`${ORIGIN}/login`, {
            method: "POST",
            headers: {
                "content-type": "application/x-www-form-urlencoded",
                origin: "null",
                "sec-fetch-site": "same-origin",
                cookie: `cp_csrf=${cookie}`,
            },
            body: new URLSearchParams({ csrf, user: "admin", password: PASSWORD }).toString(),
        }));
        // A sandboxed frame must not drive the panel even though the request
        // reaches the loopback host; refused as a redirect, not a bare 403.
        expect(response.status).toBe(303);
        expect(response.headers.get("location")).toBe("/login?e=blocked");
    });

    test("opt-in COMPOSE_PANEL_ALLOW_OPAQUE_ORIGIN permits a same-origin opaque context", async () => {
        const app = makeApp({ allowOpaqueOrigin: true });
        const { cookie, csrf } = await loginCsrf(app);
        const response = await app.fetch(new Request(`${ORIGIN}/login`, {
            method: "POST",
            headers: {
                "content-type": "application/x-www-form-urlencoded",
                origin: "null",
                "sec-fetch-site": "same-origin",
                cookie: `cp_csrf=${cookie}`,
            },
            body: new URLSearchParams({ csrf, user: "admin", password: PASSWORD }).toString(),
        }));
        expect(response.status).toBe(303);
        expect(response.headers.get("location")).toBe("/");
        expect(cookieValue(setCookies(response), "cp_session")).toBeTruthy();
    });

    test("the opt-in still refuses a cross-site opaque context", async () => {
        const app = makeApp({ allowOpaqueOrigin: true });
        const { cookie, csrf } = await loginCsrf(app);
        const response = await app.fetch(new Request(`${ORIGIN}/login`, {
            method: "POST",
            headers: {
                "content-type": "application/x-www-form-urlencoded",
                origin: "null",
                "sec-fetch-site": "cross-site",
                cookie: `cp_csrf=${cookie}`,
            },
            body: new URLSearchParams({ csrf, user: "admin", password: PASSWORD }).toString(),
        }));
        expect(response.status).toBe(303);
        expect(response.headers.get("location")).toBe("/login?e=blocked");
    });

    test("the login page explains a blocked request", async () => {
        const app = makeApp();
        const response = await app.fetch(new Request(`${ORIGIN}/login?e=blocked`));
        expect(response.status).toBe(200);
        expect(await response.text()).toContain("was blocked");
    });

    test("rejects wrong credentials without issuing a session", async () => {
        const app = makeApp();
        const { cookie, csrf } = await loginCsrf(app);
        const response = await postLogin(app, cookie, csrf, "admin", "wrong");
        expect(response.status).toBe(401);
        expect(cookieValue(setCookies(response), "cp_session")).toBeNull();
    });

    test("rejects an oversized body", async () => {
        const app = makeApp({ maxBodyBytes: 64 });
        const { cookie, csrf } = await loginCsrf(app);
        const response = await postLogin(app, cookie, csrf, "admin", "x".repeat(200));
        expect(response.status).toBe(413);
    });

    test("repeated failures never block the correct password", async () => {
        const app = makeApp();
        for (let attempt = 0; attempt < 6; attempt += 1) {
            const { cookie, csrf } = await loginCsrf(app);
            expect((await postLogin(app, cookie, csrf, "admin", "wrong")).status).toBe(401);
        }
        const { cookie, csrf } = await loginCsrf(app);
        const accepted = await postLogin(app, cookie, csrf, "admin", PASSWORD);
        expect(accepted.status).toBe(303);
        expect(cookieValue(setCookies(accepted), "cp_session")).toBeTruthy();
    });

    test("a concurrent failure burst does not lock out the real admin", async () => {
        const app = makeApp();
        const { cookie, csrf } = await loginCsrf(app);
        const responses = await Promise.all(
            Array.from({ length: 12 }, () => postLogin(app, cookie, csrf, "admin", "wrong")),
        );
        // Failures are delayed, not refused by count; only the global in-flight
        // cap may answer 429, and only transiently.
        expect(responses.every(response => response.status === 401 || response.status === 429)).toBe(true);
        const good = await loginCsrf(app);
        const accepted = await postLogin(app, good.cookie, good.csrf, "admin", PASSWORD);
        expect(accepted.status).toBe(303);
    });

    test("marks cookies Secure when configured", async () => {
        const app = makeApp({ cookieSecure: true });
        const { cookie, csrf } = await loginCsrf(app);
        const response = await postLogin(app, cookie, csrf, "admin", PASSWORD);
        const session = setCookies(response).find(value => value.startsWith("cp_session="));
        expect(session).toContain("HttpOnly");
        expect(session).toContain("SameSite=Lax");
        expect(session).toContain("Secure");
    });
});

describe("logout", () => {
    test("requires CSRF and then clears the session", async () => {
        const app = makeApp();
        const session = await login(app);

        const missing = await authed(app, "/logout", session, {
            method: "POST",
            headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ csrf: "nope" }).toString(),
        });
        expect(missing.status).toBe(403);

        const page = await authed(app, "/", session);
        const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())![1]!;
        const done = await authed(app, "/logout", session, {
            method: "POST",
            headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ csrf }).toString(),
        });
        expect(done.status).toBe(303);
        expect(done.headers.get("location")).toBe("/login");

        expect((await authed(app, "/", session)).status).toBe(302);
    });
});

describe("activity log", () => {
    test("requires a session", async () => {
        const app = makeApp();
        const response = await app.fetch(new Request(`${ORIGIN}/audit`));
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe("/login");
    });

    test("records sign-ins and renders them for the signed-in admin", async () => {
        const dir = await mkdtemp(join(tmpdir(), "compose-panel-audit-app-"));
        try {
            const audit = new AuditLog({ dir });
            const app = makeApp({}, undefined, undefined, audit);
            const session = await login(app);
            const response = await authed(app, "/audit", session);
            expect(response.status).toBe(200);
            const html = await response.text();
            expect(html).toContain("Activity log");
            expect(html).toContain("login");
            expect(html).toContain("success");
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test("never logs the typed username, which may be a mistyped password", async () => {
        const dir = await mkdtemp(join(tmpdir(), "compose-panel-audit-user-"));
        try {
            const audit = new AuditLog({ dir });
            const app = makeApp({}, undefined, undefined, audit);
            const { cookie, csrf } = await loginCsrf(app);
            expect((await postLogin(app, cookie, csrf, "Hunter2-secret", "wrong")).status).toBe(401);
            const again = await loginCsrf(app);
            expect((await postLogin(app, again.cookie, again.csrf, "admin", "wrong")).status).toBe(401);
            const raw = (await Promise.all((await readdir(dir)).map(name => readFile(join(dir, name), "utf8")))).join("");
            expect(raw).not.toContain("Hunter2-secret");
            expect(raw).toContain('"username":"unknown user"');
            expect(raw).toContain('"username":"admin account"');
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test("behind a trusted proxy, the actor is the address the proxy appended", async () => {
        const dir = await mkdtemp(join(tmpdir(), "compose-panel-audit-xff-"));
        try {
            const audit = new AuditLog({ dir });
            const app = makeApp({ trustProxy: true }, undefined, undefined, audit);
            const { cookie, csrf } = await loginCsrf(app);
            // The first entry is client-controlled; only the last one comes from our proxy.
            const response = await app.fetch(new Request(`${ORIGIN}/login`, {
                method: "POST",
                headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie: `cp_csrf=${cookie}`, "x-forwarded-for": "203.0.113.66, 198.51.100.7" },
                body: new URLSearchParams({ csrf, user: "admin", password: "wrong" }).toString(),
            }));
            expect(response.status).toBe(401);
            const raw = (await Promise.all((await readdir(dir)).map(name => readFile(join(dir, name), "utf8")))).join("");
            expect(raw).toContain('"actor":"198.51.100.7"');
            expect(raw).not.toContain("203.0.113.66");
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test("records the final outcome of an action", async () => {
        const dir = await mkdtemp(join(tmpdir(), "compose-panel-audit-op-"));
        try {
            const audit = new AuditLog({ dir });
            const runner: DockerRunner = async args => {
                if (args.includes("ls")) return { code: 0, stdout: "[]", stderr: "", timedOut: false, truncated: false };
                if (args.includes("config")) return { code: 0, stdout: '{"name":"demo-proj"}', stderr: "", timedOut: false, truncated: false };
                if (args.includes("up")) return { code: 1, stdout: "", stderr: "boom", timedOut: false, truncated: false };
                return { code: 0, stdout: "", stderr: "", timedOut: false, truncated: false };
            };
            const app = makeApp({}, runner, undefined, audit);
            const session = await login(app);
            const page = await (await authed(app, "/", session)).text();
            const csrf = /name="csrf" value="([^"]+)"/.exec(page)![1]!;
            await authed(app, "/stacks/demo/operations", session, {
                method: "POST",
                headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({ csrf, action: "up" }).toString(),
            });
            for (let i = 0; i < 200 && app.operations.activeCount() > 0; i += 1) await new Promise(resolve => setTimeout(resolve, 1));
            await new Promise(resolve => setTimeout(resolve, 20));
            const raw = (await Promise.all((await readdir(dir)).map(name => readFile(join(dir, name), "utf8")))).join("");
            expect(raw).toContain('"event":"operation","result":"started"');
            expect(raw).toContain('"event":"operation","result":"failed","stack":"demo","action":"up","detail":"exit code 1"');
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test("escapes entry fields and ignores an unknown period", async () => {
        const dir = await mkdtemp(join(tmpdir(), "compose-panel-audit-esc-"));
        try {
            await writeFile(
                join(dir, "2024-01-01.log"),
                `${JSON.stringify({ ts: "2024-01-01T00:00:00.000Z", event: "login", result: "failure", detail: "<script>alert(1)</script>" })}\n`,
            );
            const audit = new AuditLog({ dir });
            const app = makeApp({}, undefined, undefined, audit);
            const session = await login(app);
            const response = await authed(app, "/audit?period=2024-01-01", session);
            expect(response.status).toBe(200);
            const html = await response.text();
            expect(html).toContain("&lt;script&gt;");
            expect(html).not.toContain("<script>alert(1)</script>");

            const unknown = await authed(app, "/audit?period=../etc/passwd", session);
            expect(unknown.status).toBe(200);
            expect(await unknown.text()).not.toContain("root:");
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});

describe("docker status rendering", () => {
    function composeFile(): string {
        return join(root, "demo", "compose.yaml");
    }

    function fakeRunner(lsStatus: string, ps?: string): DockerRunner {
        return async args => {
            if (args[0] === "compose" && args[1] === "ls") {
                return {
                    code: 0,
                    stdout: JSON.stringify([{ Name: "demo-proj", Status: lsStatus, ConfigFiles: composeFile() }]),
                    stderr: "",
                    timedOut: false,
                    truncated: false,
                };
            }
            return { code: 0, stdout: ps ?? "", stderr: "", timedOut: false, truncated: false };
        };
    }

    test("shows the real project name and running state", async () => {
        const app = makeApp({}, fakeRunner("running(1)"));
        const session = await login(app);
        const html = await (await authed(app, "/", session)).text();
        expect(html).toContain("demo-proj");
        expect(html).toContain("state-running");
    });

    test("does not attribute a project and does not leak stderr", async () => {
        const app = makeApp({}, async () => ({ code: 1, stdout: "", stderr: "secret-token-in-stderr", timedOut: false, truncated: false }));
        const session = await login(app);
        const html = await (await authed(app, "/", session)).text();
        expect(html).toContain("state-unknown");
        expect(html).toContain("Docker is not reachable");
        expect(html).not.toContain("secret-token-in-stderr");
    });

    test("lists services on the detail page and ignores the init exit 0", async () => {
        const app = makeApp({}, fakeRunner("running(2)", JSON.stringify([
            { Service: "init", State: "exited", ExitCode: 0 },
            { Service: "app", State: "running" },
        ])));
        const session = await login(app);
        const html = await (await authed(app, "/stacks/demo", session)).text();
        expect(html).toContain("<td>init</td>");
        expect(html).toContain("<td>app</td>");
        expect(html).toContain("state-running");
    });

    test("reports a never-deployed stack as not created", async () => {
        const app = makeApp({}, async () => ({ code: 0, stdout: "[]", stderr: "", timedOut: false, truncated: false }));
        const session = await login(app);
        const html = await (await authed(app, "/", session)).text();
        expect(html).toContain("state-not-created");
    });
});

describe("editor routes", () => {
    const original = "services:\n  app:\n    image: nginx:alpine\n";
    const okRunner: DockerRunner = async () => ({ code: 0, stdout: "", stderr: "", timedOut: false, truncated: false });

    beforeEach(async () => {
        await writeFile(join(root, "demo", "compose.yaml"), original);
        await rm(join(root, "demo", ".env"), { force: true });
    });

    async function editForm(app: App, session: string) {
        const html = await (await authed(app, "/stacks/demo/edit", session)).text();
        return {
            csrf: /name="csrf" value="([^"]+)"/.exec(html)![1]!,
            composeHash: /name="composeHash" value="([^"]+)"/.exec(html)![1]!,
            envHash: /name="envHash" value="([^"]+)"/.exec(html)![1]!,
            envExists: /name="envExists" value="([^"]+)"/.exec(html)![1]!,
        };
    }

    function postSave(app: App, session: string, fields: Record<string, string>) {
        return authed(app, "/stacks/demo/edit", session, {
            method: "POST",
            headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams(fields).toString(),
        });
    }

    test("renders the raw editor with version tokens", async () => {
        const app = makeApp({}, okRunner);
        const session = await login(app);
        const response = await authed(app, "/stacks/demo/edit", session);
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain('name="compose"');
        expect(html).toContain("nginx:alpine");
        expect(html).toContain('name="composeHash"');
    });

    test("rejects a save without a valid CSRF token", async () => {
        const app = makeApp({}, okRunner);
        const session = await login(app);
        const form = await editForm(app, session);
        const response = await postSave(app, session, { ...form, csrf: "wrong", compose: original });
        expect(response.status).toBe(403);
    });

    test("saves a valid change and redirects", async () => {
        const app = makeApp({}, okRunner);
        const session = await login(app);
        const form = await editForm(app, session);
        const response = await postSave(app, session, { ...form, compose: "services:\n  app:\n    image: nginx:1.27\n" });
        expect(response.status).toBe(303);
        expect(response.headers.get("location")).toBe("/stacks/demo?saved=1");
        expect(await readFile(join(root, "demo", "compose.yaml"), "utf8")).toContain("nginx:1.27");
    });

    test("returns a conflict when the file changed underneath", async () => {
        const app = makeApp({}, okRunner);
        const session = await login(app);
        const form = await editForm(app, session);
        await writeFile(join(root, "demo", "compose.yaml"), "services: {}\n");
        const response = await postSave(app, session, { ...form, compose: "services:\n  app:\n    image: x\n" });
        expect(response.status).toBe(409);
        expect(await readFile(join(root, "demo", "compose.yaml"), "utf8")).toBe("services: {}\n");
    });

    test("keeps the draft on a validation error", async () => {
        const failing: DockerRunner = async () => ({ code: 1, stdout: "", stderr: "bad config", timedOut: false, truncated: false });
        const app = makeApp({}, failing);
        const session = await login(app);
        const form = await editForm(app, session);
        const response = await postSave(app, session, { ...form, compose: "services:\n  broken: true\n" });
        expect(response.status).toBe(400);
        expect(await response.text()).toContain("services:");
    });

    test("a kept draft keeps its original version tokens so a concurrent change still conflicts", async () => {
        // The file changes on disk while the (failing) validation runs. The
        // re-rendered form must not adopt the new hash, or the next save
        // would silently overwrite that change.
        const racing: DockerRunner = async () => {
            await writeFile(join(root, "demo", "compose.yaml"), "services: {}\n# changed elsewhere\n");
            return { code: 1, stdout: "", stderr: "bad config", timedOut: false, truncated: false };
        };
        const app = makeApp({}, racing);
        const session = await login(app);
        const form = await editForm(app, session);
        const response = await postSave(app, session, { ...form, compose: "services:\n  broken: true\n" });
        expect(response.status).toBe(400);
        const html = await response.text();
        expect(/name="composeHash" value="([^"]+)"/.exec(html)![1]).toBe(form.composeHash);
        const retry = await postSave(app, session, { ...form, compose: "services:\n  app:\n    image: x\n" });
        expect(retry.status).toBe(409);
        expect(await readFile(join(root, "demo", "compose.yaml"), "utf8")).toContain("# changed elsewhere");
    });

    test("shows a fixed confirmation after saving and never reflects the query", async () => {
        const app = makeApp({}, okRunner);
        const session = await login(app);
        expect(await (await authed(app, "/stacks/demo?saved=1", session)).text()).toContain("Saved.");
        const other = await (await authed(app, "/stacks/demo?saved=%3Cscript%3E", session)).text();
        expect(other).not.toContain("<script>");
        expect(other).not.toContain("Saved.");
    });
});

describe("operations routes", () => {
    const okResult: CommandResult = { code: 0, stdout: "upped", stderr: "", timedOut: false, truncated: false };

    beforeEach(async () => {
        await writeFile(join(root, "demo", "compose.yaml"), "services:\n  app:\n    image: nginx:alpine\n");
        await rm(join(root, "demo", ".env"), { force: true });
    });

    function dispatch(onUp: () => Promise<CommandResult>): DockerRunner {
        return async args => {
            if (args.includes("ls")) return { code: 0, stdout: "[]", stderr: "", timedOut: false, truncated: false };
            if (args.includes("up")) return onUp();
            if (args.includes("config")) return { code: 0, stdout: '{"name":"demo-proj"}', stderr: "", timedOut: false, truncated: false };
            return { code: 0, stdout: "", stderr: "", timedOut: false, truncated: false };
        };
    }

    async function csrfOf(app: App, session: string): Promise<string> {
        const html = await (await authed(app, "/", session)).text();
        return /name="csrf" value="([^"]+)"/.exec(html)![1]!;
    }

    function postOperation(app: App, session: string, csrf: string, action: string) {
        return authed(app, "/stacks/demo/operations", session, {
            method: "POST",
            headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ csrf, action }).toString(),
        });
    }

    async function waitIdle(app: App): Promise<void> {
        for (let i = 0; i < 200 && app.operations.activeCount() > 0; i += 1) {
            await new Promise(resolve => setTimeout(resolve, 1));
        }
    }

    test("locks actions that need a deployment on an undeployed stack", async () => {
        const app = makeApp({}, dispatch(async () => okResult));
        const session = await login(app);
        const html = await (await authed(app, "/stacks/demo", session)).text();
        expect(html).toMatch(/value="down"><button type="submit" class="btn btn-danger" disabled/);
        expect(html).toMatch(/value="up"><button type="submit" class="btn btn-primary" data-op-button/);
    });

    test("puts Down behind an explicit confirmation on a deployed stack", async () => {
        const deployed: DockerRunner = async args => {
            if (args.includes("ls")) return { code: 0, stdout: JSON.stringify([{ Name: "demo-proj", Status: "running(1)", ConfigFiles: join(root, "demo", "compose.yaml") }]), stderr: "", timedOut: false, truncated: false };
            if (args.includes("ps")) return { code: 0, stdout: JSON.stringify({ Service: "app", State: "running", Health: "", ExitCode: 0 }), stderr: "", timedOut: false, truncated: false };
            return { code: 0, stdout: "", stderr: "", timedOut: false, truncated: false };
        };
        const app = makeApp({}, deployed);
        const session = await login(app);
        const html = await (await authed(app, "/stacks/demo", session)).text();
        const confirm = /<details class="op-confirm">[\s\S]*?<\/details>/.exec(html)?.[0] ?? "";
        expect(confirm).toContain('value="down">');
        expect(confirm).toContain("Yes, remove the containers");
        // The only form that submits "down" is the one inside the disclosure.
        expect(html.split('value="down"').length - 1).toBe(1);
    });

    test("explains an expired session instead of a bare 401", async () => {
        const app = makeApp({}, dispatch(async () => okResult));
        const response = await app.fetch(new Request(`${ORIGIN}/stacks/demo/operations`, {
            method: "POST",
            headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ action: "up" }).toString(),
        }));
        expect(response.status).toBe(401);
        expect(response.headers.get("content-type")).toContain("text/html");
        expect(await response.text()).toContain("nothing was done");
    });

    test("rejects an operation without a valid CSRF token", async () => {
        const app = makeApp({}, dispatch(async () => okResult));
        const session = await login(app);
        expect((await postOperation(app, session, "wrong", "up")).status).toBe(403);
    });

    test("rejects an action outside the allow-list", async () => {
        const app = makeApp({}, dispatch(async () => okResult));
        const session = await login(app);
        const csrf = await csrfOf(app, session);
        expect((await postOperation(app, session, csrf, "exec")).status).toBe(400);
    });

    test("starts an operation and reports success on reload", async () => {
        const app = makeApp({}, dispatch(async () => okResult));
        const session = await login(app);
        const csrf = await csrfOf(app, session);
        const response = await postOperation(app, session, csrf, "up");
        expect(response.status).toBe(303);
        expect(response.headers.get("location")).toBe("/stacks/demo");
        await waitIdle(app);
        const html = await (await authed(app, "/stacks/demo", session)).text();
        expect(html).toContain("succeeded");
        expect(html).toContain("upped");
    });

    test("rejects a concurrent operation on the same stack", async () => {
        let release!: (result: CommandResult) => void;
        const gate = new Promise<CommandResult>(resolve => { release = resolve; });
        const app = makeApp({}, dispatch(() => gate));
        const session = await login(app);
        const csrf = await csrfOf(app, session);

        expect((await postOperation(app, session, csrf, "up")).status).toBe(303);
        expect((await postOperation(app, session, csrf, "stop")).status).toBe(409);

        release(okResult);
        await waitIdle(app);
    });
});

describe("event streams", () => {
    const okResult: CommandResult = { code: 0, stdout: "upped", stderr: "", timedOut: false, truncated: false };

    beforeEach(async () => {
        await writeFile(join(root, "demo", "compose.yaml"), "services:\n  app:\n    image: nginx:alpine\n");
        await rm(join(root, "demo", ".env"), { force: true });
    });

    async function csrfOf(app: App, session: string): Promise<string> {
        const html = await (await authed(app, "/", session)).text();
        return /name="csrf" value="([^"]+)"/.exec(html)![1]!;
    }

    test("rejects unauthenticated event streams without a login redirect", async () => {
        const app = makeApp();
        for (const path of ["/stacks/demo/operations/events", "/stacks/demo/logs/events"]) {
            const response = await app.fetch(new Request(`${ORIGIN}${path}`));
            expect(response.status).toBe(401);
        }
    });

    test("rejects invalid and unknown stack names", async () => {
        const app = makeApp();
        const session = await login(app);
        expect((await authed(app, "/stacks/..%2Fsecret/operations/events", session)).status).toBe(400);
        expect((await authed(app, "/stacks/a%0A/operations/events", session)).status).toBe(400);
        expect((await authed(app, "/stacks/a%00/logs/events", session)).status).toBe(400);
        expect((await authed(app, "/stacks/nope/operations/events", session)).status).toBe(404);
        expect((await authed(app, "/stacks/nope/logs/events", session)).status).toBe(404);
    });

    test("rejects non-GET methods on event streams", async () => {
        const app = makeApp();
        const session = await login(app);
        const response = await authed(app, "/stacks/demo/operations/events", session, { method: "POST" });
        expect(response.status).toBe(405);
    });

    test("streams a snapshot of the finished operation", async () => {
        const runner: DockerRunner = async args => {
            if (args.includes("ls")) return { code: 0, stdout: "[]", stderr: "", timedOut: false, truncated: false };
            if (args.includes("up")) return okResult;
            if (args.includes("config")) return { ...okResult, stdout: '{"name":"demo-proj"}' };
            return { code: 0, stdout: "", stderr: "", timedOut: false, truncated: false };
        };
        const app = makeApp();
        const appWithRunner = makeApp({}, runner);
        const session = await login(appWithRunner);
        const csrf = await csrfOf(appWithRunner, session);
        await authed(appWithRunner, "/stacks/demo/operations", session, {
            method: "POST",
            headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ csrf, action: "up" }).toString(),
        });
        for (let i = 0; i < 200 && appWithRunner.operations.activeCount() > 0; i += 1) {
            await new Promise(resolve => setTimeout(resolve, 1));
        }
        const stream = await authed(appWithRunner, "/stacks/demo/operations/events", session);
        expect(stream.status).toBe(200);
        expect(stream.headers.get("content-type")).toContain("text/event-stream");
        expect(stream.headers.get("cache-control")).toBe("no-store");
        const reader = sseReader(stream);
        try {
            const text = await readSseUntil(reader, "event: snapshot");
            expect(text).toContain("event: snapshot");
            expect(text).toContain("succeeded");
            expect(text).toContain("upped");
        } finally {
            await reader.cancel();
        }
        expect(app).toBeDefined();
    });

    test("streams live output and a done event without cancelling on disconnect", async () => {
        let release!: (result: CommandResult) => void;
        const gate = new Promise<CommandResult>(resolve => { release = resolve; });
        const runner: DockerRunner = async args => {
            if (args.includes("ls")) return { code: 0, stdout: "[]", stderr: "", timedOut: false, truncated: false };
            if (args.includes("up")) return gate;
            if (args.includes("config")) return { ...okResult, stdout: '{"name":"demo-proj"}' };
            return { code: 0, stdout: "", stderr: "", timedOut: false, truncated: false };
        };
        const app = makeApp({}, runner);
        const session = await login(app);
        const csrf = await csrfOf(app, session);
        expect((await authed(app, "/stacks/demo/operations", session, {
            method: "POST",
            headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ csrf, action: "up" }).toString(),
        })).status).toBe(303);

        const stream = await authed(app, "/stacks/demo/operations/events", session);
        expect(stream.status).toBe(200);
        const reader = sseReader(stream);
        try {
            const first = await readSseUntil(reader, "event: snapshot");
            expect(first).toContain("running");
            release(okResult);
            const rest = await readSseUntil(reader, "event: done");
            expect(rest).toContain("event: done");
            expect(rest).toContain("succeeded");
        } finally {
            await reader.cancel();
        }
        // Disconnecting the reader did not cancel the operation: it succeeded.
        for (let i = 0; i < 200 && app.operations.activeCount() > 0; i += 1) {
            await new Promise(resolve => setTimeout(resolve, 1));
        }
        expect(app.operations.forStack("demo")!.status).toBe("succeeded");
    });

    test("refuses streams past the subscriber limit", async () => {
        const app = makeApp({ sseMaxSubscribers: 1 });
        const session = await login(app);
        const first = await authed(app, "/stacks/demo/operations/events", session);
        expect(first.status).toBe(200);
        expect(app.sseSubscriptions()).toBe(1);
        expect((await authed(app, "/stacks/demo/logs/events", session)).status).toBe(503);
        await first.body!.cancel();
        for (let i = 0; i < 200 && app.sseSubscriptions() > 0; i += 1) {
            await new Promise(resolve => setTimeout(resolve, 1));
        }
        expect(app.sseSubscriptions()).toBe(0);
    });

    test("follows logs with replay, live chunks, and stops the follow on disconnect", async () => {
        const { provider, calls } = controllableProvider();
        const app = makeApp({}, undefined, provider);
        const session = await login(app);
        const stream = await authed(app, "/stacks/demo/logs/events", session);
        expect(stream.status).toBe(200);
        expect(stream.headers.get("content-type")).toContain("text/event-stream");
        expect(calls.length).toBe(1);
        const reader = sseReader(stream);
        try {
            const replay = await readSseUntil(reader, "event: replay");
            expect(replay).toContain("event: replay");
            calls[0]!.onChunk("web-1 | hello\n");
            const chunk = await readSseUntil(reader, "event: chunk");
            expect(chunk).toContain("event: chunk");
            expect(chunk).toContain("hello");
        } finally {
            await reader.cancel();
        }
        // The last reader left, so the follow subprocess is aborted.
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(calls[0]!.signal.aborted).toBe(true);
        expect(app.logs.isActive("demo")).toBe(false);
    });

    test("logout closes streams opened with that session", async () => {
        const { provider } = controllableProvider();
        const app = makeApp({}, undefined, provider);
        const session = await login(app);
        const stream = await authed(app, "/stacks/demo/logs/events", session);
        expect(stream.status).toBe(200);
        const reader = sseReader(stream);
        await readSseUntil(reader, "event: replay");
        expect(app.sseSubscriptions()).toBe(1);

        const csrf = await csrfOf(app, session);
        const out = await authed(app, "/logout", session, {
            method: "POST",
            headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ csrf }).toString(),
        });
        expect(out.status).toBe(303);

        const finished = await Promise.race([
            reader.read().then(result => (result.done ? "closed" : "data")),
            new Promise<string>(resolve => setTimeout(() => resolve("timeout"), 1000)),
        ]);
        expect(finished).toBe("closed");
        expect(app.logs.isActive("demo")).toBe(false);
    });

    test("refuses a stream when the session is revoked during discovery", async () => {
        let release!: (result: CommandResult) => void;
        const gate = new Promise<CommandResult>(resolve => { release = resolve; });
        let gated = false;
        const base = controllableProvider().provider;
        const provider: ComposeProvider = { ...base, listProjects: () => (gated ? gate : base.listProjects()) };
        const app = makeApp({}, undefined, provider);
        const session = await login(app);
        const csrf = await csrfOf(app, session);

        // Start discovery (now gated), then revoke the session before it resolves.
        gated = true;
        const pending = authed(app, "/stacks/demo/logs/events", session);
        await new Promise(resolve => setTimeout(resolve, 0));
        const out = await authed(app, "/logout", session, {
            method: "POST",
            headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ csrf }).toString(),
        });
        expect(out.status).toBe(303);

        release({ code: 0, stdout: JSON.stringify([{ Name: "demo-proj", Status: "running(1)", ConfigFiles: join(root, "demo", "compose.yaml") }]), stderr: "", timedOut: false, truncated: false });
        const response = await pending;
        expect(response.status).toBe(401);
        await response.body?.cancel();
    });

    test("detail page wires live streams and CSP allows same-origin scripts", async () => {
        const { provider } = controllableProvider();
        const app = makeApp({}, undefined, provider);
        const session = await login(app);
        const detail = await authed(app, "/stacks/demo", session);
        expect(detail.status).toBe(200);
        const html = await detail.text();
        expect(html).toContain('data-logs-stream="/stacks/demo/logs/events"');
        expect(html).toContain('<script src="/app.js" defer></script>');
        expect(detail.headers.get("content-security-policy")).toContain("script-src 'self'");
        expect(detail.headers.get("content-security-policy")).toContain("connect-src 'self'");
        const script = await app.fetch(new Request(`${ORIGIN}/app.js`));
        expect(script.status).toBe(200);
        expect(await script.text()).toContain("EventSource");
    });
});

describe("verified project context", () => {    const okResult: CommandResult = { code: 0, stdout: "", stderr: "", timedOut: false, truncated: false };
    const lsOf = (projects: unknown): CommandResult => ({ code: 0, stdout: JSON.stringify(projects), stderr: "", timedOut: false, truncated: false });

    interface Spy { mutations: string[][]; validates: string[][]; }

    function spyRunner(lsResult: CommandResult, spy: Spy): DockerRunner {
        return async args => {
            if (args[1] === "ls") return lsResult;
            if (args.includes("config")) {
                if (args.includes("json")) return { ...okResult, stdout: '{"name":"demo-proj"}' };
                spy.validates.push(args);
                return okResult;
            }
            if (["pull", "up", "stop", "restart", "down"].some(action => args.includes(action))) {
                spy.mutations.push(args);
                return okResult;
            }
            return { code: 0, stdout: "[]", stderr: "", timedOut: false, truncated: false };
        };
    }

    function projectEntry(name: string, files: string): { Name: string; Status: string; ConfigFiles: string } {
        return { Name: name, Status: "running(1)", ConfigFiles: files };
    }

    beforeEach(async () => {
        await writeFile(join(root, "demo", "compose.yaml"), "services:\n  app:\n    image: nginx:alpine\n");
        await rm(join(root, "demo", ".env"), { force: true });
    });

    async function csrfOf(app: App, session: string): Promise<string> {
        const html = await (await authed(app, "/", session)).text();
        return /name="csrf" value="([^"]+)"/.exec(html)![1]!;
    }

    function postOperation(app: App, session: string, csrf: string, action: string) {
        return authed(app, "/stacks/demo/operations", session, {
            method: "POST",
            headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ csrf, action }).toString(),
        });
    }

    test("refuses down on an ambiguous project without calling Docker", async () => {
        const file = join(root, "demo", "compose.yaml");
        const spy: Spy = { mutations: [], validates: [] };
        const app = makeApp({}, spyRunner(lsOf([projectEntry("one", file), projectEntry("two", file)]), spy));
        const session = await login(app);
        const response = await postOperation(app, session, await csrfOf(app, session), "down");
        expect(response.status).toBe(409);
        expect(await response.text()).toContain("It will not guess");
        expect(spy.mutations).toEqual([]);
    });

    test("refuses log follow on an ambiguous project", async () => {
        const file = join(root, "demo", "compose.yaml");
        const spy: Spy = { mutations: [], validates: [] };
        const app = makeApp({}, spyRunner(lsOf([projectEntry("one", file), projectEntry("two", file)]), spy));
        const session = await login(app);
        const stream = await authed(app, "/stacks/demo/logs/events", session);
        expect(stream.status).toBe(409);
        await stream.body!.cancel();
    });

    test("refuses mutations when Docker discovery fails", async () => {
        const spy: Spy = { mutations: [], validates: [] };
        const failing: CommandResult = { code: 1, stdout: "", stderr: "daemon down", timedOut: false, truncated: false };
        const app = makeApp({}, spyRunner(failing, spy));
        const session = await login(app);
        const response = await postOperation(app, session, await csrfOf(app, session), "up");
        expect(response.status).toBe(503);
        expect(spy.mutations).toEqual([]);
    });

    test("a multi-file project match is ambiguous too", async () => {
        const file = join(root, "demo", "compose.yaml");
        const spy: Spy = { mutations: [], validates: [] };
        const app = makeApp({}, spyRunner(lsOf([projectEntry("wide", `${file},/elsewhere/other.yaml`)]), spy));
        const session = await login(app);
        const response = await postOperation(app, session, await csrfOf(app, session), "stop");
        expect(response.status).toBe(409);
        expect(spy.mutations).toEqual([]);
    });

    test("an undeployed stack pins its effective name for up and refuses down", async () => {
        const spy: Spy = { mutations: [], validates: [] };
        const app = makeApp({}, spyRunner(lsOf([]), spy));
        const session = await login(app);
        const csrf = await csrfOf(app, session);
        const refused = await postOperation(app, session, csrf, "down");
        expect(refused.status).toBe(409);
        expect(spy.mutations).toEqual([]);
        const created = await postOperation(app, session, csrf, "up");
        expect(created.status).toBe(303);
        expect(spy.mutations.length).toBe(1);
        expect(spy.mutations[0]![spy.mutations[0]!.indexOf("-p") + 1]).toBe("demo-proj");
    });

    test("a resolved project is passed as explicit -p", async () => {
        const file = join(root, "demo", "compose.yaml");
        const spy: Spy = { mutations: [], validates: [] };
        const app = makeApp({}, spyRunner(lsOf([projectEntry("demo-proj", file)]), spy));
        const session = await login(app);
        const response = await postOperation(app, session, await csrfOf(app, session), "down");
        expect(response.status).toBe(303);
        expect(spy.mutations.length).toBe(1);
        const position = spy.mutations[0]!.indexOf("-p");
        expect(position).toBeGreaterThan(-1);
        expect(spy.mutations[0]![position + 1]).toBe("demo-proj");
    });

    test("refuses creation when the effective name belongs to another file", async () => {
        const spy: Spy = { mutations: [], validates: [] };
        const app = makeApp({}, spyRunner(lsOf([projectEntry("demo-proj", "/elsewhere/compose.yaml")]), spy));
        const session = await login(app);
        const csrf = await csrfOf(app, session);
        for (const action of ["up", "pull-up"]) {
            expect((await postOperation(app, session, csrf, action)).status).toBe(409);
        }
        expect(spy.mutations).toEqual([]);
    });

    test("passes the verified .env explicitly and omits it when absent", async () => {
        const file = join(root, "demo", "compose.yaml");
        const envPath = join(root, "demo", ".env");
        const spy: Spy = { mutations: [], validates: [] };
        const app = makeApp({}, spyRunner(lsOf([projectEntry("demo-proj", file)]), spy));
        const session = await login(app);

        expect((await postOperation(app, session, await csrfOf(app, session), "down")).status).toBe(303);
        expect(spy.mutations[0]!.includes("--env-file")).toBe(false);

        await writeFile(envPath, "FOO=bar\n");
        expect((await postOperation(app, session, await csrfOf(app, session), "down")).status).toBe(303);
        const args = spy.mutations[1]!;
        const position = args.indexOf("--env-file");
        expect(position).toBeGreaterThan(-1);
        expect(args[position + 1]).toBe(envPath);
        await rm(envPath, { force: true });
    });

    test.skipIf(process.platform === "win32")("refuses a symlinked .env for mutations and log follows", async () => {
        const file = join(root, "demo", "compose.yaml");
        const secret = join(root, "demo", "outside.env");
        await writeFile(secret, "TOKEN=secret\n");
        await symlink(secret, join(root, "demo", ".env"));
        const spy: Spy = { mutations: [], validates: [] };
        const app = makeApp({}, spyRunner(lsOf([projectEntry("demo-proj", file)]), spy));
        const session = await login(app);

        expect((await postOperation(app, session, await csrfOf(app, session), "down")).status).toBe(409);
        expect(spy.mutations).toEqual([]);
        const stream = await authed(app, "/stacks/demo/logs/events", session);
        expect(stream.status).toBe(409);
        await stream.body!.cancel();

        await rm(join(root, "demo", ".env"), { force: true });
        await rm(secret, { force: true });
    });

    test("rechecks name collisions after effective identity resolution", async () => {
        const spy: Spy = { mutations: [], validates: [] };
        let resolved = false;
        const runner = spyRunner(lsOf([]), spy);
        const app = makeApp({}, async (args, options) => {
            if (args.includes("config")) resolved = true;
            if (resolved && args.includes("ls")) return lsOf([projectEntry("demo-proj", "/elsewhere/compose.yaml")]);
            return runner(args, options);
        });
        const session = await login(app);
        expect((await postOperation(app, session, await csrfOf(app, session), "up")).status).toBe(409);
        expect(spy.mutations).toEqual([]);
    });

    test("refuses creation if name resolution fails without exposing config secrets", async () => {
        const spy: Spy = { mutations: [], validates: [] };
        const runner = spyRunner(lsOf([]), spy);
        const app = makeApp({}, (args, options) => args.includes("config")
            ? Promise.resolve({ ...okResult, code: 1, stderr: "private-secret" }) : runner(args, options));
        const session = await login(app);
        const response = await postOperation(app, session, await csrfOf(app, session), "up");
        expect(response.status).toBe(503);
        expect(await response.text()).not.toContain("private-secret");
        expect(spy.mutations).toEqual([]);
    });

    test("absent stack logs end without spawning any follow", async () => {
        const { provider, calls } = controllableProvider();
        provider.listProjects = async () => lsOf([]);
        const app = makeApp({}, undefined, provider);
        const session = await login(app);
        const response = await authed(app, "/stacks/demo/logs/events", session);
        expect(response.status).toBe(200);
        expect(await response.text()).toContain("event: end");
        expect(calls).toHaveLength(0);
        expect(app.sseSubscriptions()).toBe(0);
    });

    test("validation uses the resolved project identity", async () => {
        const file = join(root, "demo", "compose.yaml");
        const spy: Spy = { mutations: [], validates: [] };
        const app = makeApp({}, spyRunner(lsOf([projectEntry("demo-proj", file)]), spy));
        const session = await login(app);
        const html = await (await authed(app, "/stacks/demo/edit", session)).text();
        const form = {
            csrf: /name="csrf" value="([^"]+)"/.exec(html)![1]!,
            composeHash: /name="composeHash" value="([^"]+)"/.exec(html)![1]!,
            envHash: /name="envHash" value="([^"]+)"/.exec(html)![1]!,
            envExists: /name="envExists" value="([^"]+)"/.exec(html)![1]!,
        };
        const response = await authed(app, "/stacks/demo/edit", session, {
            method: "POST",
            headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ ...form, compose: "services:\n  app:\n    image: nginx:1.27\n" }).toString(),
        });
        expect(response.status).toBe(303);
        expect(spy.validates.length).toBe(1);
        const position = spy.validates[0]!.indexOf("-p");
        expect(position).toBeGreaterThan(-1);
        expect(spy.validates[0]![position + 1]).toBe("demo-proj");
    });
});

describe("shutdown policy", () => {
    beforeEach(async () => {
        await writeFile(join(root, "demo", "compose.yaml"), "services:\n  app:\n    image: nginx:alpine\n");
        await rm(join(root, "demo", ".env"), { force: true });
    });

    async function shutdownApp(): Promise<{ app: App; session: string; csrf: string }> {
        const { provider } = controllableProvider();
        const app = makeApp({}, undefined, provider);
        const session = await login(app);
        const html = await (await authed(app, "/", session)).text();
        const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
        await app.beginShutdown(50);
        return { app, session, csrf };
    }

    async function pendingSave() {
        const { provider } = controllableProvider();
        let entered!: () => void;
        let finish!: () => void;
        const started = new Promise<void>(resolve => { entered = resolve; });
        const gate = new Promise<void>(resolve => { finish = resolve; });
        provider.validateConfig = async () => { entered(); await gate; return { code: 0, stdout: "", stderr: "", timedOut: false, truncated: false }; };
        const app = makeApp({}, undefined, provider);
        const session = await login(app);
        const html = await (await authed(app, "/stacks/demo/edit", session)).text();
        const values: Record<string, string> = {};
        for (const name of ["csrf", "composeHash", "envHash", "envExists"]) values[name] = new RegExp(`name="${name}" value="([^"]+)"`).exec(html)![1]!;
        const saved = authed(app, "/stacks/demo/edit", session, {
            method: "POST", headers: { origin: ORIGIN },
            body: new URLSearchParams({ ...values, compose: "services:\n  app:\n    image: nginx:alpine\n# drained\n", env: "" }).toString(),
        });
        await started;
        return { app, finish, saved };
    }

    test("drains a save accepted before shutdown until it finishes", async () => {
        const { app, finish, saved } = await pendingSave();
        let drained = false;
        const shutdown = app.beginShutdown(1000).then(() => { drained = true; });
        try {
            await new Promise(resolve => setTimeout(resolve, 20));
            expect(drained).toBe(false);
        } finally { finish(); }
        expect((await saved).status).toBe(303);
        await shutdown;
        expect(await readFile(join(root, "demo", "compose.yaml"), "utf8")).toContain("# drained");
    });

    test("a stuck save cannot exceed the shared shutdown deadline", async () => {
        const { app, finish, saved } = await pendingSave();
        const started = Date.now();
        try {
            await app.beginShutdown(30);
            expect(Date.now() - started).toBeLessThan(1000);
        } finally { finish(); }
        await saved;
    });

    test("refuses saves, operations and new follows once shutdown started", async () => {
        const { app, session, csrf } = await shutdownApp();

        const editHtml = await (await authed(app, "/stacks/demo/edit", session)).text();
        const save = await authed(app, "/stacks/demo/edit", session, {
            method: "POST",
            headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                csrf,
                compose: "services:\n  app:\n    image: nginx:alpine\n",
                env: "",
                composeHash: /name="composeHash" value="([^"]+)"/.exec(editHtml)![1]!,
                envHash: /name="envHash" value="([^"]+)"/.exec(editHtml)![1]!,
                envExists: /name="envExists" value="([^"]+)"/.exec(editHtml)![1]!,
            }).toString(),
        });
        expect(save.status).toBe(409);
        expect(await save.text()).toContain("shutting down");

        const operation = await authed(app, "/stacks/demo/operations", session, {
            method: "POST",
            headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ csrf, action: "up" }).toString(),
        });
        expect(operation.status).toBe(409);

        const follow = await authed(app, "/stacks/demo/logs/events", session);
        expect(follow.status).toBe(503);
        await follow.body!.cancel();

        expect(await readFile(join(root, "demo", "compose.yaml"), "utf8")).toContain("nginx:alpine");
    });
});
