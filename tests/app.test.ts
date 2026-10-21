import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp, type App } from "../src/app.ts";
import { buildSiteFile, parseSiteFile } from "../src/caddy.ts";
import { createComposeProvider } from "../src/compose-provider.ts";
import { AuditLog } from "../src/audit.ts";
import type { AppConfig } from "../src/config.ts";
import type { CommandResult, DockerRunner } from "../src/docker.ts";
import type { ComposeCapabilities, ComposeProvider, ComposeTarget } from "../src/compose-provider.ts";
import type { ContainerInspector } from "../src/containers.ts";
import { resolveRoot } from "../src/stacks.ts";
import type { SelfUpdater } from "../src/self-update.ts";
import { IMAGE_REF, MOUNTINFO, NEW_DIGEST, NEW_IMAGE, fakeDocker, fakeReleases, fakeSelfUpdater, releaseJson, type FakeReleases } from "./helpers/self-update.ts";

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

function makeApp(overrides: Partial<AppConfig> = {}, runner?: DockerRunner, provider?: ComposeProvider, audit?: AuditLog, stacksRoot: string = root, inspector?: ContainerInspector, selfUpdater?: SelfUpdater): App {
    const config: AppConfig = {
        stacksDir: stacksRoot,
        port: 5081,
        adminUser: "admin",
        adminPasswordHash: passwordHash,
        cookieSecure: false,
        proxyOrigins: [],
        allowLoopback: false,
        allowOpaqueOrigin: false,
        devMode: false,
        sessionTtlMs: 3_600_000,
        sessionIdleMs: 3_600_000,
        loginRateLimit: { windowMs: 60_000, maxAttempts: 5, backoffMaxMs: 1 },
        audit: { enabled: true, dir: null, rotation: "day", retainFiles: 31, maxReadLines: 2000, maxFileBytes: 10 * 1024 * 1024 },
        maxBodyBytes: 8192,
        maxEditBytes: 1024 * 1024,
        backupRetain: 10,
        dockerPath: "docker",
        composeEngine: "docker",
        databaseExplorerUrl: null,
        caddyEnabled: false,
        caddySocketPath: null,
        hostStacksPathAliases: [],
        timeZone: "",
        dockerTimeoutMs: 5000,
        dockerMaxBytes: 1024 * 1024,
        insightsTimeoutMs: 10_000,
        diskUsageTtlMs: 300_000,
        operationTimeoutMs: 60_000,
        shutdownGraceMs: 5_000,
        sseHeartbeatMs: 15_000,
        sseTimeoutMs: 1_800_000,
        sseMaxSubscribers: 100,
        logTailLines: 200,
        logMaxBytes: 262_144,
        logTimeoutMs: 1_800_000,
        toolboxMaxManifestBytes: 262_144,
        toolboxMaxActions: 50,
        toolboxMaxTimeoutMs: 900_000,
        ...overrides,
    };
    return createApp({ config, stacksRoot, runner, provider, audit, inspector, selfUpdater });
}

interface FollowCall {
    target: ComposeTarget & { tailLines?: number };
    onChunk: (chunk: string) => void;
    signal: AbortSignal;
}

/** Provider with a controllable `logs --follow` for SSE tests. No subprocess. */
function controllableProvider(): { provider: ComposeProvider; calls: FollowCall[] } {
    const calls: FollowCall[] = [];
    const caps: ComposeCapabilities = { engine: "fake", available: true, operations: { ls: true, ps: true, config: true, logs: true }, configHashes: false };
    const empty: CommandResult = { code: 0, stdout: "[]", stderr: "", timedOut: false, truncated: false };
    const provider: ComposeProvider = {
        engine: "fake",
        capabilities: () => caps,
        detect: async () => caps,
        listProjects: async () => ({ ...empty, stdout: JSON.stringify([{ Name: "demo-proj", Status: "running(1)", ConfigFiles: join(root, "demo", "compose.yaml") }]) }),
        projectName: async () => "demo-proj",
        projectServices: async () => empty,
        projectImages: async () => empty,
        stackMetadata: async () => ({}),
        inspectImages: async () => empty,
        inspectContainers: async () => empty,
        serviceConfigHashes: async () => null,
        validateConfig: async () => empty,
        listServices: async () => [],
        runningContainerIds: async () => [],
        readLogs: async () => empty,
        pull: async () => empty,
        up: async () => empty,
        stop: async () => empty,
        start: async () => empty,
        restart: async () => empty,
        down: async () => empty,
        serviceImage: async () => null,
        recreateService: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false, truncated: false }),
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

async function loginCsrfAt(app: App, base: string): Promise<{ cookie: string; csrf: string }> {
    const response = await app.fetch(new Request(`${base}/login`));
    const cookie = cookieValue(setCookies(response), "cp_csrf");
    const html = await response.text();
    const match = /name="csrf" value="([^"]+)"/.exec(html);
    return { cookie: cookie!, csrf: match![1]! };
}

async function loginCsrf(app: App): Promise<{ cookie: string; csrf: string }> {
    return loginCsrfAt(app, ORIGIN);
}

function postLoginAt(app: App, base: string, cookie: string, csrf: string, user: string, password: string, origin: string): Promise<Response> {
    return app.fetch(new Request(`${base}/login`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin, cookie: `cp_csrf=${cookie}` },
        body: new URLSearchParams({ csrf, user, password }).toString(),
    }));
}

function postLogin(app: App, cookie: string, csrf: string, user: string, password: string, origin: string = ORIGIN): Promise<Response> {
    return postLoginAt(app, ORIGIN, cookie, csrf, user, password, origin);
}

async function login(app: App): Promise<string> {
    const { cookie, csrf } = await loginCsrf(app);
    const response = await postLogin(app, cookie, csrf, "admin", PASSWORD);
    return cookieValue(setCookies(response), "cp_session")!;
}

describe("controlled stack creation", () => {
    async function fixture(work: (app: App, dir: string, calls: string[][]) => Promise<void>, overrides: Partial<AppConfig> = {}, custom?: (args: string[]) => Promise<CommandResult>) {
        const dir = await resolveRoot(await mkdtemp(join(tmpdir(), "cp-create-route-")));
        const calls: string[][] = [];
        const runner: DockerRunner = async args => {
            calls.push(args);
            if (custom) return custom(args);
            return { code: 0, stdout: args.includes("ls") || args.includes("images") || args.includes("ps") ? "[]" : args.includes("--quiet") ? "" : '{"name":"fresh-project","services":{}}', stderr: "", timedOut: false, truncated: false };
        };
        const app = makeApp({ audit: { enabled: false, dir: null, rotation: "day", retainFiles: 1, maxReadLines: 10, maxFileBytes: 10000 }, ...overrides }, runner, undefined, undefined, dir);
        try { await work(app, dir, calls); }
        finally { await app.beginShutdown(100); await rm(dir, { recursive: true, force: true }); }
    }
    const compose = "# keep this\nservices:\n  app:\n    image: busybox\n";
    async function form(app: App, session: string) {
        const response = await authed(app, "/new-stack", session);
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        const html = await response.text();
        expect(html).toContain('method="post"');
        expect(html).toContain('action="/new-stack"');
        return /name="csrf" value="([^"]+)"/.exec(html)![1]!;
    }
    const post = (app: App, session: string, fields: Record<string, string>, origin = ORIGIN) => authed(app, "/new-stack", session, {
        method: "POST", headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString(),
    });

    test("requires authentication, CSRF and same origin before any creation or Docker call", async () => fixture(async (app, dir, calls) => {
        expect((await app.fetch(new Request(`${ORIGIN}/new-stack`))).status).toBe(302);
        expect((await app.fetch(new Request(`${ORIGIN}/new-stack`, { method: "POST" }))).status).toBe(401);
        const session = await login(app);
        const csrf = await form(app, session);
        for (const [token, origin] of [["wrong", ORIGIN], [csrf, "https://evil.example"]]) {
            expect((await post(app, session, { csrf: token!, name: "fresh", compose }, origin)).status).toBe(403);
        }
        expect(calls).toEqual([]);
        expect(await readdir(dir)).toEqual([]);
    }));

    test("creates raw files and redirects without running a Docker mutation", async () => fixture(async (app, dir, calls) => {
        const session = await login(app);
        const csrf = await form(app, session);
        const env = "TOKEN='private-value'\n";
        const response = await post(app, session, { csrf, name: "fresh", compose, env });
        expect(response.status).toBe(303);
        expect(response.headers.get("location")).toBe("/stacks/fresh?created=1");
        expect(await readFile(join(dir, "fresh/compose.yaml"), "utf8")).toBe(compose);
        expect(await readFile(join(dir, "fresh/.env"), "utf8")).toBe(env);
        expect(calls.every(args => args.includes("config") || args.includes("ls"))).toBe(true);
        expect(calls.some(args => args.includes("up") || args.includes("pull"))).toBe(false);
    }));

    test("keeps escaped drafts on validation failure without exposing provider errors", async () => fixture(async (app, dir) => {
        const session = await login(app);
        const csrf = await form(app, session);
        const response = await post(app, session, { csrf, name: "fresh", compose: `${compose}# </textarea><script>bad</script>`, env: "SECRET=private-value" });
        expect(response.status).toBe(400);
        const html = await response.text();
        expect(html).toContain("&lt;/textarea&gt;&lt;script&gt;bad&lt;/script&gt;");
        expect(html).not.toContain("<script>bad</script>");
        expect(html).toContain("fixture-invalid-yaml");
        expect(html).not.toContain("<script>diagnostic</script>");
        expect(html).toContain("&lt;script&gt;diagnostic&lt;/script&gt;");
        expect(html.match(/private-value/g)).toHaveLength(1); // Only in the retained draft.
        // The supplied secret stays only in its authenticated draft textarea.
        expect(html).toContain('data-sensitive');
        expect(await readdir(dir)).toEqual([]);
    }, {}, async () => ({ code: 1, stdout: "", stderr: "fixture-invalid-yaml: private-value <script>diagnostic</script>", timedOut: false, truncated: false })));

    test("incomplete cleanup logs only the stack and stage while keeping the redacted cause visible", async () => {
        const logged: unknown[][] = [];
        const original = console.error;
        console.error = (...args: unknown[]) => { logged.push(args); };
        try {
            await fixture(async (app, dir) => {
                const session = await login(app);
                const csrf = await form(app, session);
                const response = await post(app, session, { csrf, name: "fresh", compose, env: "SECRET=private-value" });
                expect(response.status).toBe(500);
                const html = await response.text();
                expect(html).toContain("fixture-validation-cause");
                expect(html.match(/private-value/g)).toHaveLength(1);
                expect(await readFile(join(dir, "fresh/foreign"), "utf8")).toBe("untouched");
            }, {}, async args => {
                const file = args[args.indexOf("-f") + 1]!;
                await writeFile(join(file, "..", "foreign"), "untouched");
                return { code: 1, stdout: "", stderr: "fixture-validation-cause private-value", timedOut: false, truncated: false };
            });
        } finally { console.error = original; }
        expect(JSON.stringify(logged)).not.toContain("private-value");
        expect(JSON.stringify(logged)).not.toContain("fixture-validation-cause");
        expect(logged).toEqual([["Stack creation cleanup incomplete", { stack: "fresh", stage: "validation" }]]);
    });

    test("invalid names and oversized bodies never reach Docker", async () => fixture(async (app, dir, calls) => {
        const session = await login(app);
        const csrf = await form(app, session);
        expect((await post(app, session, { csrf, name: "../bad", compose })).status).toBe(400);
        expect((await post(app, session, { csrf, name: "fresh", compose: "x".repeat(300) })).status).toBe(413);
        expect(calls).toEqual([]);
        expect(await readdir(dir)).toEqual([]);
    }, { maxEditBytes: 200 }));

    test("shutdown refuses creation", async () => fixture(async (app, dir, calls) => {
        const session = await login(app);
        const csrf = await form(app, session);
        await app.beginShutdown(0);
        expect((await post(app, session, { csrf, name: "fresh", compose })).status).toBe(409);
        expect(calls).toEqual([]);
        expect(await readdir(dir)).toEqual([]);
    }));

    test("revoked authorization during validation removes the unpublished stack", async () => fixture(async (app, dir) => {
        const session = await login(app);
        const csrf = await form(app, session);
        const original = createComposeProvider({ runner: async args => ({ code: 0, stdout: args.includes("ls") ? "[]" : '{"name":"fresh-project"}', stderr: "", timedOut: false, truncated: false }) });
        // A separate app with the same filesystem exercises the production
        // session check after an awaited validation call.
        let current!: App;
        let currentSession = "";
        let token = "";
        original.validateConfig = async () => {
            await authed(current, "/logout", currentSession, { method: "POST", headers: { origin: ORIGIN }, body: new URLSearchParams({ csrf: token }).toString() });
            return { code: 0, stdout: "", stderr: "", timedOut: false, truncated: false };
        };
        current = makeApp({}, undefined, original, undefined, dir);
        currentSession = await login(current);
        token = await form(current, currentSession);
        expect((await post(current, currentSession, { csrf: token, name: "fresh", compose })).status).toBe(401);
        expect((await readdir(dir)).includes("fresh")).toBe(false);
        await current.beginShutdown(100);
    }));
});

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
            ["/brand-mark.svg", "image/svg+xml"],
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

    test("allows each configured proxy origin host", async () => {
        const app = makeApp({ proxyOrigins: ["https://panel.example", "https://other-machine.example.ts.net"] });
        expect((await app.fetch(new Request("https://panel.example/login"))).status).toBe(200);
        expect((await app.fetch(new Request("https://other-machine.example.ts.net/login"))).status).toBe(200);
        expect((await app.fetch(new Request("http://attacker.invalid:5081/login"))).status).toBe(400);
    });

    test("refuses loopback when proxy origins are configured and loopback is not allowed", async () => {
        const app = makeApp({ proxyOrigins: ["https://panel.example"] });
        expect((await app.fetch(new Request("http://127.0.0.1:5081/login"))).status).toBe(400);
    });

    test("allows loopback alongside proxy origins when opted in", async () => {
        const app = makeApp({ proxyOrigins: ["https://panel.example"], allowLoopback: true });
        expect((await app.fetch(new Request("http://127.0.0.1:5081/login"))).status).toBe(200);
        expect((await app.fetch(new Request("https://panel.example/login"))).status).toBe(200);
    });

    test("exempts the health probe from Host validation", async () => {
        const app = makeApp();
        expect((await app.fetch(new Request("http://panel.internal:5081/health/live"))).status).toBe(200);
    });
});

describe("access paths", () => {
    const PROXY = "https://panel.example";
    const OTHER = "https://other-machine.example.ts.net";
    const FORM = "application/x-www-form-urlencoded";

    test("a proxy Host with its matching Origin signs in with a Secure cookie", async () => {
        const app = makeApp({ proxyOrigins: [PROXY] });
        const { cookie, csrf } = await loginCsrfAt(app, PROXY);
        const response = await postLoginAt(app, PROXY, cookie, csrf, "admin", PASSWORD, PROXY);
        expect(response.status).toBe(303);
        expect(response.headers.get("location")).toBe("/");
        expect(setCookies(response).find(v => v.startsWith("cp_session="))).toContain("Secure");
    });

    test("a proxy Host with a loopback Origin is refused", async () => {
        const app = makeApp({ proxyOrigins: [PROXY] });
        const { cookie, csrf } = await loginCsrfAt(app, PROXY);
        const response = await postLoginAt(app, PROXY, cookie, csrf, "admin", PASSWORD, ORIGIN);
        expect(response.status).toBe(303);
        expect(response.headers.get("location")).toBe("/login?e=blocked");
    });

    test("a loopback Host with a proxy Origin is refused", async () => {
        const app = makeApp({ proxyOrigins: [PROXY], allowLoopback: true });
        const { cookie, csrf } = await loginCsrf(app);
        const response = await postLogin(app, cookie, csrf, "admin", PASSWORD, PROXY);
        expect(response.status).toBe(303);
        expect(response.headers.get("location")).toBe("/login?e=blocked");
    });

    test("cookies are not Secure on the loopback path", async () => {
        const app = makeApp({ proxyOrigins: [PROXY], allowLoopback: true });
        const { cookie, csrf } = await loginCsrf(app);
        const response = await postLogin(app, cookie, csrf, "admin", PASSWORD);
        const session = setCookies(response).find(v => v.startsWith("cp_session="));
        expect(session).toBeTruthy();
        expect(session).not.toContain("Secure");
    });

    test("two proxy origins are each usable, and their Origins do not cross", async () => {
        const app = makeApp({ proxyOrigins: [PROXY, OTHER] });
        for (const base of [PROXY, OTHER]) {
            const { cookie, csrf } = await loginCsrfAt(app, base);
            const response = await postLoginAt(app, base, cookie, csrf, "admin", PASSWORD, base);
            expect(response.status).toBe(303);
            expect(response.headers.get("location")).toBe("/");
            expect(setCookies(response).find(v => v.startsWith("cp_session="))).toContain("Secure");
        }
        const { cookie, csrf } = await loginCsrfAt(app, PROXY);
        const crossed = await postLoginAt(app, PROXY, cookie, csrf, "admin", PASSWORD, OTHER);
        expect(crossed.headers.get("location")).toBe("/login?e=blocked");
    });

    test("a public-origin form action posted through the tunnel is refused", async () => {
        // The reverse-proxy page renders forms for the proxy origin; posting them
        // to the loopback listener (e.g. a stale tab behind the tunnel) must fail.
        const app = makeApp({ proxyOrigins: [PROXY], allowLoopback: true });
        const { cookie, csrf } = await loginCsrf(app);
        const response = await app.fetch(new Request(`${ORIGIN}/login`, {
            method: "POST",
            headers: { "content-type": FORM, origin: PROXY, cookie: `cp_csrf=${cookie}` },
            body: new URLSearchParams({ csrf, user: "admin", password: PASSWORD }).toString(),
        }));
        expect(response.headers.get("location")).toBe("/login?e=blocked");
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
        expect(html).toContain('href="/apple-touch-icon.png"');
        expect(html).toContain('srcset="/icon-boot-on-dark.svg"');
        expect(html).toContain('src="/icon-boot-on-light.svg"');
    });

    test("pages brand the header with the symbol and text", async () => {
        const app = makeApp();
        const session = await login(app);
        const html = await (await authed(app, "/", session)).text();
        expect(html).toContain('<img src="/brand-mark.svg" alt="" width="20" height="20">Compose Panel');
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

describe("external database explorer link", () => {
    const name = "explorer";
    const dir = () => join(root, name);

    async function writeStack(compose: string): Promise<void> {
        await mkdir(dir(), { recursive: true });
        await writeFile(join(dir(), "compose.yaml"), compose);
    }

    const valid = "services:\n  db:\n    image: postgres:16\nx-compose-panel:\n  database:\n    label: LibreDB\n    query:\n      connection: seed:shop-staging\n";

    test("shows the explorer link when the stack declares an extension and a URL is configured", async () => {
        await writeStack(valid);
        try {
            const app = makeApp({ databaseExplorerUrl: "https://db.example.com" });
            const session = await login(app);
            const response = await authed(app, `/stacks/${name}`, session);
            expect(response.status).toBe(200);
            const html = await response.text();
            expect(html).toContain('class="card database"');
            expect(html).toContain('href="https://db.example.com/?connection=seed%3Ashop-staging"');
            expect(html).toContain('rel="noopener noreferrer"');
        } finally {
            await rm(dir(), { recursive: true, force: true });
        }
    });

    test("shows no link without a configured explorer URL", async () => {
        await writeStack(valid);
        try {
            const app = makeApp();
            const session = await login(app);
            const html = await (await authed(app, `/stacks/${name}`, session)).text();
            expect(html).not.toContain('class="card database"');
        } finally {
            await rm(dir(), { recursive: true, force: true });
        }
    });

    test("reports an invalid declaration as a warning without an explorer link", async () => {
        await writeStack("services:\n  db:\n    image: postgres:16\nx-compose-panel:\n  database:\n    query: not-a-map\n");
        try {
            const app = makeApp({ databaseExplorerUrl: "https://db.example.com" });
            const session = await login(app);
            const response = await authed(app, `/stacks/${name}`, session);
            expect(response.status).toBe(200);
            const html = await response.text();
            const card = /<section class="card database">[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
            expect(card).toContain('class="note note-warn"');
            expect(card).not.toContain("<a ");
        } finally {
            await rm(dir(), { recursive: true, force: true });
        }
    });
});

describe("caddy domains preview", () => {
    test("shows no domains section when the integration is disabled", async () => {
        const app = makeApp();
        const session = await login(app);
        const html = await (await authed(app, "/stacks/demo", session)).text();
        expect(html).not.toContain('class="card domains"');
    });

    test("shows the preview form when enabled, without writing anything", async () => {
        const app = makeApp({ caddyEnabled: true });
        const session = await login(app);
        const html = await (await authed(app, "/stacks/demo", session)).text();
        expect(html).toContain('class="card domains"');
        expect(html).toContain('name="caddyDomain"');
    });

    test("previews the managed file for valid input", async () => {
        const { provider } = controllableProvider();
        const withService: ComposeProvider = {
            ...provider,
            projectServices: async () => ({ code: 0, stdout: JSON.stringify([{ Service: "web", State: "running" }]), stderr: "", timedOut: false, truncated: false }),
        };
        const app = makeApp({ caddyEnabled: true }, undefined, withService);
        const session = await login(app);
        const response = await authed(app, "/stacks/demo?caddyDomain=app.example.com&caddyService=web&caddyPort=8080", session);
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("app.example.com");
        expect(html).toContain("reverse_proxy 127.0.0.1:8080");
    });

    test("reports invalid input as a warning without failing the page", async () => {
        const app = makeApp({ caddyEnabled: true });
        const session = await login(app);
        const response = await authed(app, "/stacks/demo?caddyDomain=not_a_domain&caddyService=web&caddyPort=8080", session);
        expect(response.status).toBe(200);
        const html = await response.text();
        const card = /<section class="card domains">[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
        expect(card).toContain('class="note note-warn"');
        expect(card).not.toContain("<pre");
    });
});

describe("caddy domain attach and detach", () => {
    async function csrfOf(app: App, session: string): Promise<string> {
        const html = await (await authed(app, "/", session)).text();
        return /name="csrf" value="([^"]+)"/.exec(html)![1]!;
    }

    function postDomains(app: App, session: string, csrf: string, path: string, fields: Record<string, string>) {
        return authed(app, path, session, {
            method: "POST",
            headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ csrf, ...fields }).toString(),
        });
    }

    test("refuses attach and detach when the integration is disabled", async () => {
        const app = makeApp();
        const session = await login(app);
        const csrf = await csrfOf(app, session);
        const fields = { domain: "app.example.com", service: "web", port: "8080" };
        expect((await postDomains(app, session, csrf, "/stacks/demo/domains/attach", fields)).status).toBe(404);
        expect((await postDomains(app, session, csrf, "/stacks/demo/domains/detach", { domain: "app.example.com" })).status).toBe(404);
    });

    test("refuses attach when enabled without a helper socket", async () => {
        const app = makeApp({ caddyEnabled: true });
        const session = await login(app);
        const csrf = await csrfOf(app, session);
        expect((await postDomains(app, session, csrf, "/stacks/demo/domains/attach", { domain: "app.example.com", service: "web", port: "8080" })).status).toBe(404);
    });

    test("refuses invalid attach and detach input without touching Docker", async () => {
        const app = makeApp({ caddyEnabled: true, caddySocketPath: "/nonexistent-dir/helper.sock" });
        const session = await login(app);
        const csrf = await csrfOf(app, session);
        const attach = await postDomains(app, session, csrf, "/stacks/demo/domains/attach", { domain: "not_a_domain", service: "web", port: "8080" });
        expect(attach.status).toBe(400);
        const detach = await postDomains(app, session, csrf, "/stacks/demo/domains/detach", { domain: "not_a_domain" });
        expect(detach.status).toBe(400);
    });

    test("refuses attach with a wrong CSRF token", async () => {
        const app = makeApp({ caddyEnabled: true, caddySocketPath: "/nonexistent-dir/helper.sock" });
        const session = await login(app);
        const response = await postDomains(app, session, "wrong", "/stacks/demo/domains/attach", { domain: "app.example.com", service: "web", port: "8080" });
        expect(response.status).not.toBe(303);
    });

    test("refuses attach when the stack is managed externally", async () => {
        const { provider } = controllableProvider();
        provider.stackMetadata = async () => ({ web: { "stack.managed-by": "external-deployer" } });
        const app = makeApp({ caddyEnabled: true, caddySocketPath: "/nonexistent-dir/helper.sock" }, undefined, provider);
        const session = await login(app);
        const response = await postDomains(app, session, await csrfOf(app, session), "/stacks/demo/domains/attach", { domain: "app.example.com", service: "web", port: "8080" });
        expect(response.status).toBe(409);
        expect(await response.text()).toContain("managed externally");
    });
});

// Full attach/detach flow against an in-process fake helper over a real Unix
// socket, with stubbed Docker reads. Linux only. The fake helper writes real
// canonical files to a temp directory (honest file coverage) but performs no
// Caddy call: validate/adapt/reload are covered in tests/caddy-helper.test.ts.
describe.skipIf(process.platform !== "linux")("caddy domain management flow", () => {
    let helperCounter = 0;

    async function startFakeHelper(managedDir: string): Promise<{ socketPath: string; close: () => void }> {
        const socketPath = join(await mkdtemp(join(tmpdir(), "compose-panel-caddy-flow-")), `helper-${process.pid}-${helperCounter++}.sock`);
        await rm(socketPath, { force: true });
        const pending = new Map<object, number[]>();
        const server = Bun.listen({
            unix: socketPath,
            socket: {
                open(socket) { pending.set(socket, []); },
                data(socket, data) {
                    const seen = pending.get(socket) ?? [];
                    for (const byte of data) seen.push(byte);
                    pending.set(socket, seen);
                    const text = Buffer.from(seen).toString("utf8");
                    if (!text.includes("\n")) return;
                    pending.delete(socket);
                    void answer(socket, text.slice(0, text.indexOf("\n")));
                },
                close(socket) { pending.delete(socket); },
                error(socket) { try { socket.end(); } catch { /* already gone */ } pending.delete(socket); },
            },
        });
        async function answer(socket: { write: (data: string) => void; end: () => void }, line: string): Promise<void> {
            let response: unknown;
            try {
                const request = JSON.parse(line) as { action: string; domain?: string; stack?: string; service?: string; port?: number };
                if (request.action === "status") {
                    const sites = [];
                    for (const entry of await readdir(managedDir).catch(() => [] as string[])) {
                        if (!entry.endsWith(".caddy")) continue;
                        const parsed = parseSiteFile(await readFile(join(managedDir, entry), "utf8").catch(() => ""));
                        if (parsed.ok) sites.push(parsed.value);
                    }
                    response = { ok: true, action: "status", sites, unparseable: [], importConfigured: true };
                } else if (request.action === "attach" && request.domain && request.stack && request.service && request.port) {
                    const file = buildSiteFile({ domain: request.domain, stack: request.stack, service: request.service, port: request.port });
                    await writeFile(join(managedDir, `${request.domain}.caddy`), file);
                    response = { ok: true, action: "attach", unchanged: false };
                } else if (request.action === "detach" && request.domain) {
                    await rm(join(managedDir, `${request.domain}.caddy`), { force: true });
                    response = { ok: true, action: "detach" };
                } else {
                    response = { ok: false, error: "Unknown helper action.", code: "invalid" };
                }
            } catch {
                response = { ok: false, error: "The fake helper failed.", code: "failed" };
            }
            try {
                socket.write(`${JSON.stringify(response)}\n`);
                socket.end();
            } catch { /* the client may have gone */ }
        }
        return { socketPath, close: () => server.stop() };
    }

    const containerId = "a".repeat(64);

    function lsLine(): string {
        const fields = [
            containerId, "demo-web-1", "nginx:alpine", "running", "Up 2 hours", "",
            "2026-10-01 10:00:00", "2 hours", "127.0.0.1:8080->80/tcp",
            "demo-proj", "web", join(root, "demo", "compose.yaml"), "",
        ];
        return fields.map(field => JSON.stringify(field)).join("\t");
    }

    function fakeInspector(bindings: Record<string, Array<{ HostIp: string; HostPort: string }>> = { "80/tcp": [{ HostIp: "127.0.0.1", HostPort: "8080" }]}): ContainerInspector {
        const ok = { code: 0, stdout: "[]", stderr: "", timedOut: false, truncated: false };
        const inspect = JSON.stringify([{
            Id: containerId,
            Name: "/demo-web-1",
            Config: { Image: "nginx:alpine" },
            Image: "sha256:0",
            Created: "2026-10-01T10:00:00Z",
            State: { Status: "running", Running: true, ExitCode: 0 },
            HostConfig: { RestartPolicy: { Name: "unless-stopped" } },
            NetworkSettings: { Ports: bindings },
            Mounts: [],
        }]);
        return {
            engine: "fake",
            list: async () => ({ ...ok, stdout: lsLine() }),
            inspect: async () => ({ ...ok, stdout: inspect }),
            logs: async () => ok,
            info: async () => ok,
            stats: async () => ok,
            diskUsage: async () => ok,
        };
    }

    async function csrfOf(app: App, session: string): Promise<string> {
        const html = await (await authed(app, "/", session)).text();
        return /name="csrf" value="([^"]+)"/.exec(html)![1]!;
    }

    function postDomains(app: App, session: string, csrf: string, path: string, fields: Record<string, string>) {
        return authed(app, path, session, {
            method: "POST",
            headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ csrf, ...fields }).toString(),
        });
    }

    test("attaches, lists with an application link, then detaches in two steps", async () => {
        await writeFile(join(root, "demo", "compose.yaml"), "services:\n  web:\n    image: nginx:alpine\n");
        await rm(join(root, "demo", ".env"), { force: true });
        const managedDir = await mkdtemp(join(tmpdir(), "compose-panel-caddy-sites-"));
        const helper = await startFakeHelper(managedDir);
        try {
            const { provider } = controllableProvider();
            provider.projectServices = async () => ({ code: 0, stdout: JSON.stringify([{ Service: "web", State: "running" }]), stderr: "", timedOut: false, truncated: false });
            provider.listServices = async () => ["web"];
            const app = makeApp({ caddyEnabled: true, caddySocketPath: helper.socketPath }, undefined, provider, undefined, root, fakeInspector());
            const session = await login(app);
            const csrf = await csrfOf(app, session);

            const attached = await postDomains(app, session, csrf, "/stacks/demo/domains/attach", { domain: "app.example.com", service: "web", port: "8080" });
            expect(attached.status).toBe(303);
            expect(attached.headers.get("location")).toBe("/stacks/demo?attached=1");
            expect(await readFile(join(managedDir, "app.example.com.caddy"), "utf8"))
                .toBe(buildSiteFile({ domain: "app.example.com", stack: "demo", service: "web", port: 8080 }));

            const page = await (await authed(app, "/stacks/demo", session)).text();
            expect(page).toContain('href="https://app.example.com"');
            expect(page).toContain('action="/stacks/demo/domains/detach"');

            const confirm = await postDomains(app, session, csrf, "/stacks/demo/domains/detach", { domain: "app.example.com" });
            expect(confirm.status).toBe(200);
            expect(await confirm.text()).toContain("Confirm detach");

            const detached = await postDomains(app, session, csrf, "/stacks/demo/domains/detach", { domain: "app.example.com", confirm: "1" });
            expect(detached.status).toBe(303);
            expect(detached.headers.get("location")).toBe("/stacks/demo?detached=1");
            expect(await readdir(managedDir)).toEqual([]);
            expect(await (await authed(app, "/stacks/demo", session)).text()).toContain("No domains attached.");
        } finally {
            helper.close();
            await rm(managedDir, { recursive: true, force: true });
            await writeFile(join(root, "demo", "compose.yaml"), "services:\n  app:\n    image: nginx:alpine\n");
        }
    }, 30_000);

    async function providerWithService(): Promise<ComposeProvider> {
        const { provider } = controllableProvider();
        provider.projectServices = async () => ({ code: 0, stdout: JSON.stringify([{ Service: "web", State: "running" }]), stderr: "", timedOut: false, truncated: false });
        provider.listServices = async () => ["web"];
        return provider;
    }

    async function prepareDemo(): Promise<void> {
        await writeFile(join(root, "demo", "compose.yaml"), "services:\n  web:\n    image: nginx:alpine\n");
        await rm(join(root, "demo", ".env"), { force: true });
    }

    test("refuses a port that is not exactly the generated upstream", async () => {
        await prepareDemo();
        const cases: Array<Record<string, Array<{ HostIp: string; HostPort: string }>>> = [
            { "53/udp": [{ HostIp: "127.0.0.1", HostPort: "8080" }] },
            { "80/tcp": [{ HostIp: "::1", HostPort: "8080" }] },
            { "80/tcp": [{ HostIp: "0.0.0.0", HostPort: "8080" }] },
        ];
        for (const bindings of cases) {
            const managedDir = await mkdtemp(join(tmpdir(), "compose-panel-caddy-sites-"));
            const helper = await startFakeHelper(managedDir);
            try {
                const app = makeApp({ caddyEnabled: true, caddySocketPath: helper.socketPath }, undefined, await providerWithService(), undefined, root, fakeInspector(bindings));
                const session = await login(app);
                const response = await postDomains(app, session, await csrfOf(app, session), "/stacks/demo/domains/attach", { domain: "app.example.com", service: "web", port: "8080" });
                expect(response.status).toBe(409);
                expect(await response.text()).toContain("127.0.0.1 (TCP)");
                expect(await readdir(managedDir)).toEqual([]);
            } finally {
                helper.close();
                await rm(managedDir, { recursive: true, force: true });
            }
        }
        await writeFile(join(root, "demo", "compose.yaml"), "services:\n  app:\n    image: nginx:alpine\n");
    }, 30_000);

    test("refuses detach when the stack is managed externally, before and under the lock", async () => {
        await prepareDemo();
        const managedDir = await mkdtemp(join(tmpdir(), "compose-panel-caddy-sites-"));
        const helper = await startFakeHelper(managedDir);
        try {
            await writeFile(join(managedDir, "app.example.com.caddy"), buildSiteFile({ domain: "app.example.com", stack: "demo", service: "web", port: 8080 }));
            // Pre-check refusal: the owner is already known.
            const owned = await providerWithService();
            owned.stackMetadata = async () => ({ web: { "stack.managed-by": "external-deployer" } });
            const refused = makeApp({ caddyEnabled: true, caddySocketPath: helper.socketPath }, undefined, owned, undefined, root, fakeInspector());
            const refusedSession = await login(refused);
            const early = await postDomains(refused, refusedSession, await csrfOf(refused, refusedSession), "/stacks/demo/domains/detach", { domain: "app.example.com", confirm: "1" });
            expect(early.status).toBe(409);
            expect(await early.text()).toContain("managed externally");
            // In-lock refusal: the confirmation is offered while the stack has
            // no owner, then the owner appears before the confirmed POST,
            // covering the confirmation-to-mutation window.
            let ownerDeclared = false;
            const racing = await providerWithService();
            const unowned: Record<string, Record<string, string>> = {};
            racing.stackMetadata = async () => (ownerDeclared ? { web: { "stack.managed-by": "external-deployer" } } : unowned);
            const app = makeApp({ caddyEnabled: true, caddySocketPath: helper.socketPath }, undefined, racing, undefined, root, fakeInspector());
            const session = await login(app);
            const csrf = await csrfOf(app, session);
            const confirmation = await postDomains(app, session, csrf, "/stacks/demo/domains/detach", { domain: "app.example.com" });
            expect(confirmation.status).toBe(200);
            ownerDeclared = true;
            const late = await postDomains(app, session, csrf, "/stacks/demo/domains/detach", { domain: "app.example.com", confirm: "1" });
            expect(late.status).toBe(409);
            expect(await late.text()).toContain("managed externally");
            expect(await readdir(managedDir)).toEqual(["app.example.com.caddy"]);
        } finally {
            helper.close();
            await rm(managedDir, { recursive: true, force: true });
            await writeFile(join(root, "demo", "compose.yaml"), "services:\n  app:\n    image: nginx:alpine\n");
        }
    }, 30_000);

    test("shutdown waits for a running Caddy mutation", async () => {
        await prepareDemo();
        const managedDir = await mkdtemp(join(tmpdir(), "compose-panel-caddy-sites-"));
        const socketPath = join(managedDir, "slow.sock");
        const server = Bun.listen({
            unix: socketPath,
            socket: {
                open() {},
                data(socket, data) {
                    if (!Buffer.from(data).toString("utf8").includes("\n")) return;
                    setTimeout(() => {
                        try {
                            socket.write(`${JSON.stringify({ ok: true, action: "attach", unchanged: false })}\n`);
                            socket.end();
                        } catch { /* the client may have gone */ }
                    }, 1500);
                },
                close() {},
                error(socket) { try { socket.end(); } catch { /* already gone */ } },
            },
        });
        try {
            const app = makeApp({ caddyEnabled: true, caddySocketPath: socketPath }, undefined, await providerWithService(), undefined, root, fakeInspector());
            const session = await login(app);
            const pending = postDomains(app, session, await csrfOf(app, session), "/stacks/demo/domains/attach", { domain: "app.example.com", service: "web", port: "8080" });
            await Bun.sleep(400);
            const started = Date.now();
            await app.beginShutdown(5000);
            // The drain waited for the helper answer instead of ending at once.
            expect(Date.now() - started).toBeGreaterThanOrEqual(800);
            const response = await pending;
            expect(response.status).toBe(303);
        } finally {
            server.stop();
            await rm(managedDir, { recursive: true, force: true });
            await writeFile(join(root, "demo", "compose.yaml"), "services:\n  app:\n    image: nginx:alpine\n");
        }
    }, 30_000);
});

describe("access diagnostics", () => {
    test("requires a session", async () => {
        const response = await makeApp().fetch(new Request(`${ORIGIN}/access`));
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe("/login");
    });

    test("loopback-only: listener verified, tunnel not verifiable", async () => {
        const app = makeApp();
        const session = await login(app);
        const response = await authed(app, "/access", session);
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        const html = await response.text();
        expect(html).toContain("Binds 127.0.0.1:5081");
        expect(html).toContain("Arrived through <strong>loopback (127.0.0.1:5081)</strong>");
        // The tunnel row exists but is never verified: status class without -done.
        expect(html).toContain('<td>SSH tunnel (loopback)</td><td><span class="state">');
        expect(html).toContain('<span class="state state-done">');
        expect(html).toContain("note-info");
    });

    test("proxy origins are listed as configured, never as verified", async () => {
        const app = makeApp({ proxyOrigins: ["https://panel.example", "https://oracle.example.ts.net"], allowLoopback: true });
        const session = await login(app);
        const html = await (await authed(app, "/access", session)).text();
        // Each origin row binds its area to the configured status (no -done class).
        expect(html).toContain('<td>Proxy origin https://panel.example</td><td><span class="state">');
        expect(html).toContain('<td>Proxy origin https://oracle.example.ts.net</td><td><span class="state">');
        // Exactly the three panel-controlled rows are verified; origins never are.
        expect(html.match(/<span class="state state-done">/g)).toHaveLength(3);
    });

    test("reports the access point the current request arrived on", async () => {
        const PROXY = "https://panel.example";
        const app = makeApp({ proxyOrigins: [PROXY] });
        const { cookie, csrf } = await loginCsrfAt(app, PROXY);
        const login1 = await postLoginAt(app, PROXY, cookie, csrf, "admin", PASSWORD, PROXY);
        const session = cookieValue(setCookies(login1), "cp_session")!;
        const response = await app.fetch(new Request(`${PROXY}/access`, { headers: { cookie: `cp_session=${session}` } }));
        const html = await response.text();
        expect(html).toContain(`Arrived through <strong>proxy origin ${PROXY}</strong>`);
    });

    test("surfaces development and plain-HTTP warnings", async () => {
        const app = makeApp({ devMode: true });
        const session = await login(app);
        const html = await (await authed(app, "/access", session)).text();
        expect(html).toContain("COMPOSE_PANEL_DEV=true");

        const httpApp = makeApp({ proxyOrigins: ["http://panel.localhost:8080"], allowLoopback: true, devMode: true });
        const httpSession = await login(httpApp);
        const httpHtml = await (await authed(httpApp, "/access", httpSession)).text();
        expect(httpHtml).toContain("uses plain HTTP");
    });

    test("the navigation links to it from authenticated pages", async () => {
        const app = makeApp();
        const session = await login(app);
        const html = await (await authed(app, "/", session)).text();
        expect(html).toContain('<a href="/access">Access</a>');
    });
});

describe("navigation sidebar", () => {
    test("shows the section links and the stack list on authenticated pages", async () => {
        const app = makeApp();
        const session = await login(app);
        const html = await (await authed(app, "/", session)).text();
        expect(html).toContain('<nav class="nav-sections"');
        expect(html).toContain('<a href="/stacks/demo">demo</a>');
    });

    test("marks the current stack on its own page", async () => {
        const app = makeApp();
        const session = await login(app);
        const html = await (await authed(app, "/stacks/demo", session)).text();
        expect(html).toContain('<a href="/stacks/demo" aria-current="page">demo</a>');
    });

    test("the sign-in page has no navigation", async () => {
        const app = makeApp();
        const html = await (await app.fetch(new Request(`${ORIGIN}/login`))).text();
        expect(html).not.toContain("nav-sections");
    });

    test("the stack list comes from the stacks folder alone, never Docker", async () => {
        const dead: ComposeProvider = {
            engine: "fake",
            capabilities: () => { throw new Error("must not be called"); },
            detect: async () => { throw new Error("must not be called"); },
            listProjects: async () => { throw new Error("Docker is down"); },
        } as unknown as ComposeProvider;
        const app = makeApp({}, undefined, dead);
        const session = await login(app);
        // /access otherwise runs no Docker call: a 200 with the stack list
        // proves the sidebar never consults Docker (no status, no counter).
        const response = await authed(app, "/access", session);
        expect(response.status).toBe(200);
        expect(await response.text()).toContain('<a href="/stacks/demo">demo</a>');
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
            expect(html).toContain("<table");
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

    test("on a proxy origin, the actor is the address the proxy appended", async () => {
        const dir = await mkdtemp(join(tmpdir(), "compose-panel-audit-xff-"));
        const PROXY = "https://panel.example";
        try {
            const audit = new AuditLog({ dir });
            const app = makeApp({ proxyOrigins: [PROXY] }, undefined, undefined, audit);
            const { cookie, csrf } = await loginCsrfAt(app, PROXY);
            // The first entry is client-controlled; only the last one comes from our proxy.
            const response = await app.fetch(new Request(`${PROXY}/login`, {
                method: "POST",
                headers: { "content-type": "application/x-www-form-urlencoded", origin: PROXY, cookie: `cp_csrf=${cookie}`, "x-forwarded-for": "203.0.113.66, 198.51.100.7" },
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

    test("a vendor identity header (CF-Connecting-IP) is ignored", async () => {
        // The panel never authorizes on an identity-proxy header, and it reads
        // the client address from X-Forwarded-For only (ADR 0012).
        const dir = await mkdtemp(join(tmpdir(), "compose-panel-audit-cf-"));
        const PROXY = "https://panel.example";
        try {
            const audit = new AuditLog({ dir });
            const app = makeApp({ proxyOrigins: [PROXY] }, undefined, undefined, audit);
            const { cookie, csrf } = await loginCsrfAt(app, PROXY);
            const response = await app.fetch(new Request(`${PROXY}/login`, {
                method: "POST",
                headers: {
                    "content-type": "application/x-www-form-urlencoded",
                    origin: PROXY,
                    cookie: `cp_csrf=${cookie}`,
                    "x-forwarded-for": "198.51.100.7",
                    "cf-connecting-ip": "9.9.9.9",
                },
                body: new URLSearchParams({ csrf, user: "admin", password: "wrong" }).toString(),
            }));
            expect(response.status).toBe(401);
            const raw = (await Promise.all((await readdir(dir)).map(name => readFile(join(dir, name), "utf8")))).join("");
            expect(raw).toContain('"actor":"198.51.100.7"');
            expect(raw).not.toContain("9.9.9.9");
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test("on the loopback path, X-Forwarded-For is ignored (actor is direct)", async () => {
        const dir = await mkdtemp(join(tmpdir(), "compose-panel-audit-loopback-xff-"));
        const PROXY = "https://panel.example";
        try {
            const audit = new AuditLog({ dir });
            const app = makeApp({ proxyOrigins: [PROXY], allowLoopback: true }, undefined, undefined, audit);
            const { cookie, csrf } = await loginCsrf(app);
            const response = await app.fetch(new Request(`${ORIGIN}/login`, {
                method: "POST",
                headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie: `cp_csrf=${cookie}`, "x-forwarded-for": "6.6.6.6" },
                body: new URLSearchParams({ csrf, user: "admin", password: "wrong" }).toString(),
            }));
            expect(response.status).toBe(401);
            const raw = (await Promise.all((await readdir(dir)).map(name => readFile(join(dir, name), "utf8")))).join("");
            expect(raw).toContain('"actor":"direct"');
            expect(raw).not.toContain("6.6.6.6");
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test("documented limit: a client able to reach the listener can forge a proxy Host and X-Forwarded-For", async () => {
        // Host selects the access point but does not authenticate the proxy
        // (ADR 0012). A local client presenting a proxy-origin Host is treated
        // as arriving through the proxy, so its X-Forwarded-For is trusted. Auth
        // and CSRF are unaffected; only the throttle key and audit actor can be
        // misattributed. This test pins that known limitation.
        const dir = await mkdtemp(join(tmpdir(), "compose-panel-audit-forged-host-"));
        const PROXY = "https://panel.example";
        try {
            const audit = new AuditLog({ dir });
            const app = makeApp({ proxyOrigins: [PROXY], allowLoopback: true }, undefined, undefined, audit);
            const { cookie, csrf } = await loginCsrfAt(app, PROXY);
            const response = await app.fetch(new Request(`http://127.0.0.1:5081/login`, {
                method: "POST",
                headers: {
                    "content-type": "application/x-www-form-urlencoded",
                    host: "panel.example",
                    origin: PROXY,
                    cookie: `cp_csrf=${cookie}`,
                    "x-forwarded-for": "9.9.9.9",
                },
                body: new URLSearchParams({ csrf, user: "admin", password: "wrong" }).toString(),
            }));
            expect(response.status).toBe(401);
            const raw = (await Promise.all((await readdir(dir)).map(name => readFile(join(dir, name), "utf8")))).join("");
            expect(raw).toContain('"actor":"9.9.9.9"');
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
        expect(await (await authed(app, "/stacks/demo?saved=1", session)).text()).toContain("note-success");
        const other = await (await authed(app, "/stacks/demo?saved=%3Cscript%3E", session)).text();
        expect(other).not.toContain("<script>");
        expect(other).not.toContain("note-success");
    });
});

describe("stack backups", () => {
    const okRunner: DockerRunner = async () => ({ code: 0, stdout: "", stderr: "", timedOut: false, truncated: false });
    const backupDir = () => join(root, ".compose-panel", "backups", "demo");
    const PLANTED = "compose.yaml.2026-10-11T08-00-00-000Z.aaaaaaaaaaaaaaaaaa";

    beforeEach(async () => {
        await writeFile(join(root, "demo", "compose.yaml"), "services:\n  app:\n    image: nginx:alpine\n");
        await rm(join(root, "demo", ".env"), { force: true });
        await rm(backupDir(), { recursive: true, force: true });
    });

    async function save(app: App, session: string, compose: string): Promise<Response> {
        const html = await (await authed(app, "/stacks/demo/edit", session)).text();
        const field = (name: string) => new RegExp(`name="${name}" value="([^"]+)"`).exec(html)![1]!;
        return authed(app, "/stacks/demo/edit", session, {
            method: "POST",
            headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ csrf: field("csrf"), composeHash: field("composeHash"), envHash: field("envHash"), envExists: field("envExists"), compose, env: "" }).toString(),
        });
    }

    async function purge(app: App, session: string, csrf?: string): Promise<Response> {
        const token = csrf ?? /name="csrf" value="([^"]+)"/.exec(await (await authed(app, "/stacks/demo/edit", session)).text())![1]!;
        return authed(app, "/stacks/demo/backups/purge", session, {
            method: "POST",
            headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ csrf: token }).toString(),
        });
    }

    async function plantBackup(): Promise<void> {
        await mkdir(backupDir(), { recursive: true });
        await writeFile(join(backupDir(), PLANTED), "old\n");
    }

    test("a save deletes backups beyond the retention count", async () => {
        const app = makeApp({ backupRetain: 2 }, okRunner);
        const session = await login(app);
        for (const tag of ["1", "2", "3"]) expect((await save(app, session, `services:\n  app:\n    image: nginx:${tag}\n`)).status).toBe(303);
        const left = await readdir(backupDir());
        expect(left).toHaveLength(2);
        // The oldest backup held the original file; the two newest are kept.
        const contents = await Promise.all(left.map(name => readFile(join(backupDir(), name), "utf8")));
        expect(contents.sort()).toEqual(["services:\n  app:\n    image: nginx:1\n", "services:\n  app:\n    image: nginx:2\n"]);
    });

    test("purges every backup of the stack and records it", async () => {
        const dir = await mkdtemp(join(tmpdir(), "compose-panel-audit-purge-"));
        try {
            const app = makeApp({}, okRunner, undefined, new AuditLog({ dir }));
            const session = await login(app);
            await plantBackup();
            await writeFile(join(backupDir(), "notes.txt"), "kept by hand");
            const response = await purge(app, session);
            expect(response.status).toBe(303);
            expect(response.headers.get("location")).toBe("/stacks/demo/edit?purged=1");
            expect(await readdir(backupDir())).toEqual(["notes.txt"]);
            const raw = (await Promise.all((await readdir(dir)).map(name => readFile(join(dir, name), "utf8")))).join("");
            expect(raw).toContain('"event":"backup-purge"');
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test("refuses a purge without a valid CSRF token or from a foreign origin", async () => {
        const app = makeApp({}, okRunner);
        const session = await login(app);
        await plantBackup();
        expect((await purge(app, session, "wrong")).status).toBe(403);
        const foreign = await authed(app, "/stacks/demo/backups/purge", session, {
            method: "POST",
            headers: { origin: "http://evil.example", "content-type": "application/x-www-form-urlencoded" },
            body: "csrf=x",
        });
        expect(foreign.status).toBe(403);
        expect(await readdir(backupDir())).toEqual([PLANTED]);
    });

    test("only accepts POST and an existing stack", async () => {
        const app = makeApp({}, okRunner);
        const session = await login(app);
        expect((await authed(app, "/stacks/demo/backups/purge", session)).status).toBe(405);
        const csrf = /name="csrf" value="([^"]+)"/.exec(await (await authed(app, "/stacks/demo/edit", session)).text())![1]!;
        const missing = await authed(app, "/stacks/nope/backups/purge", session, {
            method: "POST",
            headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ csrf }).toString(),
        });
        expect(missing.status).toBe(404);
    });

    test("refuses a purge while a save holds the stack lock", async () => {
        let entered!: () => void;
        const inside = new Promise<void>(resolve => { entered = resolve; });
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const gated: DockerRunner = async () => {
            entered();
            await gate;
            return { code: 0, stdout: "", stderr: "", timedOut: false, truncated: false };
        };
        const app = makeApp({}, gated);
        const session = await login(app);
        await plantBackup();
        const csrf = /name="csrf" value="([^"]+)"/.exec(await (await authed(app, "/stacks/demo/edit", session)).text())![1]!;
        const pending = save(app, session, "services:\n  app:\n    image: nginx:9\n");
        await inside;
        expect((await purge(app, session, csrf)).status).toBe(409);
        expect(await readdir(backupDir())).toContain(PLANTED);
        release();
        expect((await pending).status).toBe(303);
    });

    test("shows a purge control only when backups exist", async () => {
        const app = makeApp({}, okRunner);
        const session = await login(app);
        expect(await (await authed(app, "/stacks/demo/edit", session)).text()).not.toContain("/stacks/demo/backups/purge");
        await plantBackup();
        expect(await (await authed(app, "/stacks/demo/edit", session)).text()).toContain('action="/stacks/demo/backups/purge"');
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

    function postScopedOperation(app: App, session: string, csrf: string, action: string, service: string) {
        return authed(app, "/stacks/demo/operations", session, {
            method: "POST",
            headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ csrf, action, service }).toString(),
        });
    }

    function deployedRunner(calls: string[][]): DockerRunner {
        return async args => {
            calls.push(args);
            if (args.includes("ls")) return { code: 0, stdout: JSON.stringify([{ Name: "demo-proj", Status: "running(1)", ConfigFiles: join(root, "demo", "compose.yaml") }]), stderr: "", timedOut: false, truncated: false };
            if (args.includes("ps")) return { code: 0, stdout: JSON.stringify([{ Service: "web", State: "running", Health: "", ExitCode: 0 }]), stderr: "", timedOut: false, truncated: false };
            if (args[0] === "compose" && args.includes("config") && args.includes("--services")) {
                return { code: 0, stdout: "web\ndb\n", stderr: "", timedOut: false, truncated: false };
            }
            return { code: 0, stdout: "", stderr: "", timedOut: false, truncated: false };
        };
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

    test("offers no action while the stack state is unknown", async () => {
        const unreachable: DockerRunner = async () => ({ code: 1, stdout: "", stderr: "daemon down", timedOut: false, truncated: false });
        const app = makeApp({}, unreachable);
        const session = await login(app);
        const html = await (await authed(app, "/stacks/demo", session)).text();
        for (const action of ["up", "pull", "pull-up", "restart", "start", "stop", "down"]) {
            expect(html).toMatch(new RegExp(`value="${action}"><button[^>]* disabled[^>]* data-state-locked[^>]* data-op-button`));
        }
        expect(html).not.toContain("op-confirm");
    });

    test("Pull runs on an undeployed stack without creating anything", async () => {
        const calls: string[][] = [];
        const runner: DockerRunner = async args => {
            calls.push(args);
            if (args.includes("ls")) return { code: 0, stdout: "[]", stderr: "", timedOut: false, truncated: false };
            if (args.includes("config")) return { code: 0, stdout: '{"name":"demo-proj"}', stderr: "", timedOut: false, truncated: false };
            return { code: 0, stdout: "", stderr: "", timedOut: false, truncated: false };
        };
        const app = makeApp({}, runner);
        const session = await login(app);
        const csrf = await csrfOf(app, session);
        expect((await postOperation(app, session, csrf, "pull")).status).toBe(303);
        await waitIdle(app);
        const pull = calls.find(args => args.includes("pull"))!;
        expect(pull).toEqual(expect.arrayContaining(["-p", "demo-proj", "pull"]));
        expect(calls.some(args => args.includes("up"))).toBe(false);
    });

    test("shows which services have an update ready, from → to, with a link", async () => {
        const oldId = `sha256:${"a".repeat(64)}`;
        const newId = `sha256:${"b".repeat(64)}`;
        const runner: DockerRunner = async args => {
            const reply = (stdout: string) => ({ code: 0, stdout, stderr: "", timedOut: false, truncated: false });
            if (args.includes("ls")) return reply(JSON.stringify([{ Name: "demo-proj", Status: "running(1)", ConfigFiles: join(root, "demo", "compose.yaml") }]));
            if (args.includes("ps")) return reply(JSON.stringify({ Service: "app", Name: "demo-proj-app-1", Image: "nginx:alpine", State: "running", Health: "", ExitCode: 0 }));
            if (args.includes("images")) return reply(JSON.stringify([{ ContainerName: "demo-proj-app-1", ID: oldId }]));
            if (args[0] === "image" && args[1] === "inspect") {
                return reply(JSON.stringify([
                    { Id: newId, RepoTags: ["nginx:alpine"], Created: "2026-10-05T00:00:00Z", Config: { Labels: { "org.opencontainers.image.version": "1.27.2" } } },
                    { Id: oldId, RepoTags: [], Created: "2026-09-01T00:00:00Z", Config: { Labels: { "org.opencontainers.image.version": "1.27.1" } } },
                ]));
            }
            return reply("");
        };
        const app = makeApp({}, runner);
        const session = await login(app);
        const html = await (await authed(app, "/stacks/demo", session)).text();
        expect(html).toContain("state-update");
        expect(html).toContain(`<span class="version">1.27.1</span> → <span class="version">1.27.2</span>`);
        expect(html).toContain('href="https://hub.docker.com/_/nginx"');
        expect(html).toContain("note-info");
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

    test("Start runs compose start on a stopped stack and never creates one", async () => {
        const calls: string[][] = [];
        const runner: DockerRunner = async args => {
            calls.push(args);
            if (args.includes("ls")) return { code: 0, stdout: JSON.stringify([{ Name: "demo-proj", Status: "exited(1)", ConfigFiles: join(root, "demo", "compose.yaml") }]), stderr: "", timedOut: false, truncated: false };
            if (args.includes("ps")) return { code: 0, stdout: JSON.stringify([{ Service: "app", State: "exited", Health: "", ExitCode: 0 }]), stderr: "", timedOut: false, truncated: false };
            return { code: 0, stdout: "", stderr: "", timedOut: false, truncated: false };
        };
        const app = makeApp({}, runner);
        const session = await login(app);
        const csrf = await csrfOf(app, session);
        expect(await (await authed(app, "/stacks/demo", session)).text()).toMatch(/value="start"><button[^>]*data-op-button/);
        expect((await postOperation(app, session, csrf, "start")).status).toBe(303);
        await waitIdle(app);
        expect(calls.find(args => args.includes("start"))).toEqual(expect.arrayContaining(["start"]));
        expect(calls.some(args => args.includes("up"))).toBe(false);
    });

    test("Start is refused on a stack that was never deployed", async () => {
        const app = makeApp({}, dispatch(async () => okResult));
        const session = await login(app);
        expect((await postOperation(app, session, await csrfOf(app, session), "start")).status).toBe(409);
    });

    test("Restart runs scoped to one service without touching dependents", async () => {
        const calls: string[][] = [];
        const dir = await mkdtemp(join(tmpdir(), "compose-panel-audit-scoped-"));
        try {
            const audit = new AuditLog({ dir });
            const app = makeApp({}, deployedRunner(calls), undefined, audit);
            const session = await login(app);
            const csrf = await csrfOf(app, session);
            const page = await (await authed(app, "/stacks/demo", session)).text();
            expect(page).toContain('name="service" value="web"');
            expect((await postScopedOperation(app, session, csrf, "restart", "web")).status).toBe(303);
            await waitIdle(app);
            expect(calls.find(args => args.includes("restart"))).toEqual(
                expect.arrayContaining(["restart", "--no-deps", "--", "web"]),
            );
            expect(app.operations.forStack("demo")?.service).toBe("web");
            await new Promise(resolve => setTimeout(resolve, 20));
            const raw = (await Promise.all((await readdir(dir)).map(name => readFile(join(dir, name), "utf8")))).join("");
            expect(raw).toContain('"event":"operation","result":"started"');
            expect(raw).toContain('"action":"restart","service":"web"');
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test("scoped Up needs a deployed stack and never creates one", async () => {
        const calls: string[][] = [];
        const runner: DockerRunner = async args => {
            calls.push(args);
            if (args.includes("ls")) return { code: 0, stdout: "[]", stderr: "", timedOut: false, truncated: false };
            if (args.includes("config")) return { code: 0, stdout: '{"name":"demo-proj"}', stderr: "", timedOut: false, truncated: false };
            return { code: 0, stdout: "", stderr: "", timedOut: false, truncated: false };
        };
        const app = makeApp({}, runner);
        const session = await login(app);
        expect((await postScopedOperation(app, session, await csrfOf(app, session), "up", "web")).status).toBe(409);
        expect(calls.some(args => args.includes("up"))).toBe(false);
    });

    test("a service field on other actions is refused, never ignored", async () => {
        const calls: string[][] = [];
        const app = makeApp({}, deployedRunner(calls));
        const session = await login(app);
        const csrf = await csrfOf(app, session);
        for (const action of ["down", "pull", "start", "pull-up"]) {
            expect((await postScopedOperation(app, session, csrf, action, "web")).status).toBe(400);
        }
        expect((await postScopedOperation(app, session, csrf, "restart", "--privileged")).status).toBe(400);
        expect((await postScopedOperation(app, session, csrf, "restart", "missing")).status).toBe(409);
        expect(calls.some(args => ["down", "pull", "start", "restart", "up"].some(verb => args.includes(verb)))).toBe(false);
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

    test("serves a bounded log snapshot over an authenticated GET without following", async () => {
        const { provider, calls } = controllableProvider();
        provider.readLogs = async () => ({ code: 0, stdout: "2026-10-10T10:00:00Z app-1  | hello\n", stderr: "", timedOut: false, truncated: false });
        const app = makeApp({}, undefined, provider);
        const session = await login(app);
        const response = await authed(app, "/stacks/demo/logs", session);
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("text/plain");
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(await response.text()).toContain("hello");
        expect(calls).toHaveLength(0);
        expect(app.logs.isActive("demo")).toBe(false);
    });

    test("requires a session for the log snapshot", async () => {
        const { provider } = controllableProvider();
        const app = makeApp({}, undefined, provider);
        expect((await app.fetch(new Request(`${ORIGIN}/stacks/demo/logs`))).status).toBe(302);
        expect((await authed(app, "/stacks/a%00/logs", await login(app))).status).toBe(400);
    });

    test("never echoes Docker stderr in the log snapshot", async () => {
        const { provider } = controllableProvider();
        provider.readLogs = async () => ({ code: 1, stdout: "", stderr: "secret-token", timedOut: false, truncated: false });
        const app = makeApp({}, undefined, provider);
        const session = await login(app);
        const response = await authed(app, "/stacks/demo/logs", session);
        expect(response.status).toBe(502);
        expect(await response.text()).not.toContain("secret-token");
    });

    test("an absent stack has no log snapshot and runs no Docker read", async () => {
        const { provider } = controllableProvider();
        provider.listProjects = async () => lsOf([]);
        let reads = 0;
        provider.readLogs = async () => { reads += 1; return { code: 0, stdout: "x", stderr: "", timedOut: false, truncated: false }; };
        const app = makeApp({}, undefined, provider);
        const session = await login(app);
        const response = await authed(app, "/stacks/demo/logs", session);
        expect(response.status).toBe(200);
        expect(await response.text()).toContain("not deployed");
        expect(reads).toBe(0);
    });

    test("filters the log snapshot by service and tail after discovery", async () => {
        const { provider } = controllableProvider();
        provider.listServices = async () => ["web", "db"];
        let seen: { service?: string; tailLines?: number } | undefined;
        provider.readLogs = async target => {
            seen = { service: target.service, tailLines: (target as { tailLines?: number }).tailLines };
            return { code: 0, stdout: "web line\n", stderr: "", timedOut: false, truncated: false };
        };
        const app = makeApp({}, undefined, provider);
        const session = await login(app);
        const response = await authed(app, "/stacks/demo/logs?service=web&tail=500", session);
        expect(response.status).toBe(200);
        expect(await response.text()).toContain("web line");
        expect(seen).toEqual({ service: "web", tailLines: 500 });
    });

    test("falls back to the configured tail when the requested count is not offered", async () => {
        const { provider } = controllableProvider();
        provider.listServices = async () => ["web"];
        let tail: number | undefined;
        provider.readLogs = async target => {
            tail = (target as { tailLines?: number }).tailLines;
            return { code: 0, stdout: "x\n", stderr: "", timedOut: false, truncated: false };
        };
        const app = makeApp({}, undefined, provider);
        const session = await login(app);
        expect((await authed(app, "/stacks/demo/logs?tail=12345", session)).status).toBe(200);
        expect(tail).toBe(200);
        expect((await authed(app, "/stacks/demo/logs?tail=many", session)).status).toBe(200);
        expect(tail).toBe(200);
    });

    test("refuses an unknown service without spawning a log read", async () => {
        const { provider } = controllableProvider();
        provider.listServices = async () => ["web"];
        let reads = 0;
        let discoveries = 0;
        const base = provider.listServices;
        provider.listServices = async target => { discoveries += 1; return base(target); };
        provider.readLogs = async () => { reads += 1; return { code: 0, stdout: "x", stderr: "", timedOut: false, truncated: false }; };
        const app = makeApp({}, undefined, provider);
        const session = await login(app);
        expect((await authed(app, "/stacks/demo/logs?service=db", session)).status).toBe(409);
        expect((await authed(app, "/stacks/demo/logs?service=--privileged", session)).status).toBe(400);
        expect((await authed(app, "/stacks/demo/logs/events?service=db", session)).status).toBe(409);
        expect(reads).toBe(0);
        // The discovery call itself is expected; only the log read must not run.
        expect(discoveries).toBeGreaterThan(0);
    });

    test("refuses the log snapshot for an unknown or ambiguous stack", async () => {
        const { provider } = controllableProvider();
        provider.listProjects = async () => lsOf([
            projectEntry("demo-proj", join(root, "demo", "compose.yaml")),
            projectEntry("other", join(root, "demo", "compose.yaml")),
        ]);
        const app = makeApp({}, undefined, provider);
        const session = await login(app);
        const unknown = await authed(app, "/stacks/nope/logs", session);
        expect(unknown.status).toBe(404);
        // A text/plain endpoint never answers an HTML error page.
        expect(unknown.headers.get("content-type")).toContain("text/plain");
        expect(await unknown.text()).not.toContain("<html");
        expect((await authed(app, "/stacks/demo/logs", session)).status).toBe(409);
    });

    test("answers HEAD on data endpoints with headers only, no body", async () => {
        const { provider } = controllableProvider();
        provider.readLogs = async () => ({ code: 0, stdout: "2026-10-10T10:00:00Z app-1  | hello\n", stderr: "", timedOut: false, truncated: false });
        const app = makeApp({}, undefined, provider, undefined, root, detailedInspector({
            list: containerFixture(),
            logs: { code: 0, stdout: "hello\n", stderr: "", timedOut: false, truncated: false },
        }));
        const session = await login(app);
        for (const [path, contentType] of [
            ["/stacks/demo/logs", "text/plain"],
            ["/containers/bbbbbbbbbbbb/logs", "text/plain"],
            ["/server/stats", "application/json"],
        ] as const) {
            const head = await authed(app, path, session, { method: "HEAD" });
            expect(head.status).toBe(200);
            expect(head.headers.get("content-type")).toContain(contentType);
            expect(await head.text()).toBe("");
            const get = await authed(app, path, session);
            expect(get.status).toBe(200);
            expect(get.headers.get("content-type")).toContain(contentType);
            expect((await get.text()).length).toBeGreaterThan(0);
        }
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

describe("session revocation during a pending mutation", () => {
    const ok: CommandResult = { code: 0, stdout: "", stderr: "", timedOut: false, truncated: false };
    const compose = "services:\n  app:\n    image: nginx:alpine\n";

    beforeEach(async () => {
        await writeFile(join(root, "demo", "compose.yaml"), compose);
        await rm(join(root, "demo", ".env"), { force: true });
    });

    async function csrfOf(app: App, session: string): Promise<string> {
        const html = await (await authed(app, "/", session)).text();
        return /name="csrf" value="([^"]+)"/.exec(html)![1]!;
    }

    function logout(app: App, session: string, csrf: string): Promise<Response> {
        return authed(app, "/logout", session, {
            method: "POST",
            headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ csrf }).toString(),
        });
    }

    /** A request whose body arrives only when `finish` is called. */
    function pendingPost(app: App, path: string, session: string): { response: Promise<Response>; finish: (fields: Record<string, string>) => void } {
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
        const response = authed(app, path, session, {
            method: "POST",
            headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
            body,
        });
        return {
            response,
            finish: fields => {
                controller.enqueue(new TextEncoder().encode(new URLSearchParams(fields).toString()));
                controller.close();
            },
        };
    }

    /**
     * Runner that records mutations. Once `armed`, calls matching `gated`
     * wait until `release` is called.
     */
    function gatedRunner(gated: (args: string[]) => boolean) {
        const mutations: string[] = [];
        let armed = false;
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const runner: DockerRunner = async args => {
            if (armed && gated(args)) await gate;
            if (args.includes("ls")) return { ...ok, stdout: "[]" };
            if (args.includes("config") && !args.includes("--quiet")) return { ...ok, stdout: '{"name":"demo"}' };
            if (["up", "stop", "restart", "down", "pull"].some(action => args.includes(action))) mutations.push(args.join(" "));
            return ok;
        };
        return { runner, mutations, arm: () => { armed = true; }, release: () => release() };
    }

    test("a body that arrives after logout runs nothing", async () => {
        const { runner, mutations } = gatedRunner(() => false);
        const app = makeApp({}, runner);
        const session = await login(app);
        const csrf = await csrfOf(app, session);
        const pending = pendingPost(app, "/stacks/demo/operations", session);
        await Bun.sleep(5);
        expect((await logout(app, session, csrf)).status).toBe(303);
        pending.finish({ csrf, action: "up" });
        const response = await pending.response;
        expect(response.status).toBe(401);
        expect(await response.text()).toContain("nothing was done");
        expect(mutations).toEqual([]);
        expect(app.operations.activeCount()).toBe(0);
    });

    test("a body that arrives after idle expiry runs nothing", async () => {
        const { runner, mutations } = gatedRunner(() => false);
        const app = makeApp({ sessionIdleMs: 300 }, runner);
        const session = await login(app);
        const csrf = await csrfOf(app, session);
        const pending = pendingPost(app, "/stacks/demo/operations", session);
        await Bun.sleep(400);
        pending.finish({ csrf, action: "up" });
        expect((await pending.response).status).toBe(401);
        expect(mutations).toEqual([]);
    });

    test("a logout during project discovery runs nothing", async () => {
        const gated = gatedRunner(args => args.includes("ls"));
        const app = makeApp({}, gated.runner);
        const session = await login(app);
        const csrf = await csrfOf(app, session);
        gated.arm();
        const response = authed(app, "/stacks/demo/operations", session, {
            method: "POST",
            headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ csrf, action: "up" }).toString(),
        });
        await Bun.sleep(5);
        expect((await logout(app, session, csrf)).status).toBe(303);
        gated.release();
        expect((await response).status).toBe(401);
        expect(gated.mutations).toEqual([]);
        expect(app.operations.activeCount()).toBe(0);
    });

    test("a logout during save validation writes nothing", async () => {
        const gated = gatedRunner(args => args.includes("--quiet"));
        const app = makeApp({}, gated.runner);
        const session = await login(app);
        const html = await (await authed(app, "/stacks/demo/edit", session)).text();
        const field = (name: string) => new RegExp(`name="${name}" value="([^"]+)"`).exec(html)![1]!;
        const csrf = field("csrf");
        gated.arm();
        const response = authed(app, "/stacks/demo/edit", session, {
            method: "POST",
            headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                csrf,
                compose: "services:\n  app:\n    image: nginx:1.27\n",
                env: "",
                composeHash: field("composeHash"),
                envHash: field("envHash"),
                envExists: field("envExists"),
            }).toString(),
        });
        await Bun.sleep(20);
        expect((await logout(app, session, csrf)).status).toBe(303);
        gated.release();
        expect((await response).status).toBe(401);
        expect(await readFile(join(root, "demo", "compose.yaml"), "utf8")).toBe(compose);
    });
});

describe("default activity log layout", () => {
    test("a symlinked .compose-panel cannot redirect the log", async () => {
        const stacks = await resolveRoot(await mkdtemp(join(tmpdir(), "compose-panel-app-audit-")));
        const outside = await mkdtemp(join(tmpdir(), "compose-panel-app-outside-"));
        try {
            try {
                await symlink(outside, join(stacks, ".compose-panel"), "junction");
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "EPERM") return;
                throw error;
            }
            const app = makeApp({}, undefined, undefined, undefined, stacks);
            const session = await login(app);
            expect(session).toBeTruthy();
            expect(await readdir(outside)).toEqual([]);
            const html = await (await authed(app, "/audit", session)).text();
            expect(html).not.toContain('"event"');
        } finally {
            await rm(stacks, { recursive: true, force: true });
            await rm(outside, { recursive: true, force: true });
        }
    });
});

type ContainerFields = {
    id: string;
    name: string;
    image: string;
    state: string;
    status: string;
    health: string;
    project: string | null;
    service: string | null;
    configFiles: string | null;
    workingDir: string | null;
};

function containerLine(fields: ContainerFields): string {
    return [
        JSON.stringify(fields.id), JSON.stringify(fields.name), JSON.stringify(fields.image),
        JSON.stringify(fields.state), JSON.stringify(fields.status), JSON.stringify(fields.health),
        JSON.stringify("2026-10-05 08:31:11 +0200 CEST"), JSON.stringify("5 days ago"),
        JSON.stringify("0.0.0.0:8080->80/tcp"), JSON.stringify(fields.project ?? ""),
        JSON.stringify(fields.service ?? ""), JSON.stringify(fields.configFiles ?? ""),
        JSON.stringify(fields.workingDir ?? ""),
    ].join("\t");
}

function fakeInspector(stdout: string, result: Partial<CommandResult> = {}): ContainerInspector {
    const value: CommandResult = { code: 0, stdout, stderr: "", timedOut: false, truncated: false, ...result };
    return { engine: "docker", list: async () => value, inspect: async () => value, logs: async () => value, info: async () => value, stats: async () => value, diskUsage: async () => value };
}

function detailedInspector(outputs: { list: string; inspect?: CommandResult; logs?: CommandResult }): ContainerInspector {
    const base: CommandResult = { code: 0, stdout: "", stderr: "", timedOut: false, truncated: false };
    return {
        engine: "docker",
        list: async () => ({ ...base, stdout: outputs.list }),
        inspect: async () => outputs.inspect ?? base,
        logs: async () => outputs.logs ?? base,
        info: async () => base,
        stats: async () => base,
        diskUsage: async () => base,
    };
}

function inspectJson(id: string, name: string): string {
    return JSON.stringify([{
        Id: id,
        Name: `/${name}`,
        Created: "2026-10-05T08:31:11Z",
        Image: `sha256:${"a".repeat(64)}`,
        Config: { Image: "nginx:1.27", Env: ["SECRET=hidden"] },
        State: { Status: "running", Running: true, ExitCode: 0, StartedAt: "2026-10-05T08:31:12Z", FinishedAt: "0001-01-01T00:00:00Z", Health: { Status: "healthy" } },
        HostConfig: { RestartPolicy: { Name: "unless-stopped" } },
        NetworkSettings: { Ports: { "80/tcp": [{ HostIp: "0.0.0.0", HostPort: "8080" }] } },
        Mounts: [{ Type: "bind", Source: "/host/data", Destination: "/data", Mode: "ro", RW: false }],
    }]);
}

/**
 * One managed stack (demo) plus a running standalone, a running external Compose
 * container, an external container mid-restart, and an exited external job.
 */
function containerFixture(): string {
    const managedFile = join(root, "demo", "compose.yaml");
    return [
        containerLine({ id: "aaaaaaaaaaaa", name: "demo-app-1", image: "nginx:1.27", state: "running", status: "Up 2 hours (healthy)", health: "healthy", project: "demo", service: "app", configFiles: managedFile, workingDir: join(root, "demo") }),
        containerLine({ id: "bbbbbbbbbbbb", name: "watchtower", image: "containrrr/watchtower", state: "running", status: "Up 3 days", health: "none", project: "watchtower", service: "watchtower", configFiles: null, workingDir: null }),
        containerLine({ id: "cccccccccccc", name: "legacy", image: "redis:7", state: "running", status: "Up 5 minutes", health: "none", project: null, service: null, configFiles: null, workingDir: null }),
        containerLine({ id: "dddddddddddd", name: "edge", image: "traefik:v3", state: "restarting", status: "Restarting (1) 4 seconds ago", health: "starting", project: "edge", service: "proxy", configFiles: null, workingDir: null }),
        containerLine({ id: "eeeeeeeeeeee", name: "old-job", image: "alpine:3", state: "exited", status: "Exited (0) 2 days ago", health: "none", project: "ci", service: "job", configFiles: null, workingDir: null }),
    ].join("\n");
}

describe("containers page", () => {
    test("requires a session", async () => {
        const app = makeApp({}, undefined, undefined, undefined, root, fakeInspector(containerFixture()));
        const response = await app.fetch(new Request(`${ORIGIN}/containers`));
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe("/login");
    });

    test("lists all categories and filters by state", async () => {
        const app = makeApp({}, undefined, undefined, undefined, root, fakeInspector(containerFixture()));
        const session = await login(app);
        const running = await (await authed(app, "/containers", session)).text();
        expect(running).toContain("Managed");
        expect(running).toContain("External Compose");
        expect(running).toContain("Standalone");
        expect(running).toContain("demo-app-1");
        expect(running).toContain("watchtower");
        expect(running).toContain("legacy");
        // A restarting container is still "running".
        expect(running).toContain("edge");
        // The exited job is not in the default view.
        expect(running).not.toContain("old-job");
        // Container names link to the (read-only) detail page.
        expect(running).toContain("/containers/aaaaaaaaaaaa");

        const all = await (await authed(app, "/containers?state=all", session)).text();
        expect(all).toContain("old-job");

        const stopped = await (await authed(app, "/containers?state=stopped", session)).text();
        expect(stopped).toContain("old-job");
        expect(stopped).not.toContain("watchtower");

        // An unknown filter falls back to the running view.
        const bogus = await (await authed(app, "/containers?state=bogus", session)).text();
        expect(bogus).not.toContain("old-job");
    });

    test("shows docker trouble as a note, not an empty list", async () => {
        const app = makeApp({}, undefined, undefined, undefined, root, fakeInspector("", { code: 1 }));
        const session = await login(app);
        const html = await (await authed(app, "/containers", session)).text();
        expect(html).toContain("Docker is not reachable");
    });
});

describe("home other-containers section", () => {
    test("shares one compose discovery between the stacks table and the containers", async () => {
        let listCalls = 0;
        const empty: CommandResult = { code: 0, stdout: "[]", stderr: "", timedOut: false, truncated: false };
        const provider = {
            engine: "fake",
            listProjects: async () => { listCalls += 1; return empty; },
        } as unknown as ComposeProvider;
        const app = makeApp({}, undefined, provider, undefined, root, fakeInspector(containerFixture()));
        const session = await login(app);
        await authed(app, "/", session);
        expect(listCalls).toBe(1);
    });

    test("shows non-managed containers only and links to the full list", async () => {
        const app = makeApp({}, undefined, undefined, undefined, root, fakeInspector(containerFixture()));
        const session = await login(app);
        const html = await (await authed(app, "/", session)).text();
        expect(html).toContain("Other containers");
        expect(html).toContain("watchtower");
        expect(html).toContain("legacy");
        // Managed containers stay on the stacks view, not here.
        expect(html).not.toContain("demo-app-1");
        expect(html).toContain("/containers");
    });

    test("reports Docker trouble without a misleading empty list", async () => {
        const app = makeApp({}, undefined, undefined, undefined, root, fakeInspector("", { code: 1 }));
        const session = await login(app);
        const html = await (await authed(app, "/", session)).text();
        expect(html).toContain("Other containers");
        expect(html).toContain("Docker is not reachable");
    });
});

describe("container detail and logs", () => {
    test("renders a read-only detail page with ports and mounts", async () => {
        const app = makeApp({}, undefined, undefined, undefined, root, detailedInspector({
            list: containerFixture(),
            inspect: { code: 0, stdout: inspectJson("bbbbbbbbbbbb", "watchtower"), stderr: "", timedOut: false, truncated: false },
        }));
        const session = await login(app);
        const html = await (await authed(app, "/containers/bbbbbbbbbbbb", session)).text();
        expect(html).toContain("watchtower");
        expect(html).toContain("Restart policy");
        expect(html).toContain("unless-stopped");
        expect(html).toContain("All interfaces");
        expect(html).toContain("Mounts (1)");
        expect(html).toContain("Logs");
        // The whitelist never exposes the container environment.
        expect(html).not.toContain("SECRET=hidden");
    });

    test("a managed container links back to its stack", async () => {
        const app = makeApp({}, undefined, undefined, undefined, root, detailedInspector({
            list: containerFixture(),
            inspect: { code: 0, stdout: inspectJson("aaaaaaaaaaaa", "demo-app-1"), stderr: "", timedOut: false, truncated: false },
        }));
        const session = await login(app);
        const html = await (await authed(app, "/containers/aaaaaaaaaaaa", session)).text();
        expect(html).toContain("/stacks/demo");
    });

    test("rejects a malformed reference and 404s an unknown one", async () => {
        const app = makeApp({}, undefined, undefined, undefined, root, fakeInspector(containerFixture()));
        const session = await login(app);
        expect((await authed(app, "/containers/not-hex", session)).status).toBe(400);
        expect((await authed(app, "/containers/ffffffffffff", session)).status).toBe(404);
    });

    test("answers 503, not 404, when the container list is unreadable", async () => {
        const app = makeApp({}, undefined, undefined, undefined, root, fakeInspector("", { code: 1 }));
        const session = await login(app);
        const response = await authed(app, "/containers/aaaaaaaaaaaa", session);
        expect(response.status).toBe(503);
        const html = await response.text();
        expect(html).toContain("Docker is not reachable");
        expect(html).not.toContain("may have been removed");
    });

    test("serves a bounded log snapshot with ANSI stripped", async () => {
        const app = makeApp({}, undefined, undefined, undefined, root, detailedInspector({
            list: containerFixture(),
            logs: { code: 0, stdout: "\u001b[31mhello logs\u001b[0m\n", stderr: "secret-stderr", timedOut: false, truncated: false },
        }));
        const session = await login(app);
        const response = await authed(app, "/containers/bbbbbbbbbbbb/logs?tail=500", session);
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("text/plain");
        expect(response.headers.get("cache-control")).toBe("no-store");
        const text = await response.text();
        expect(text).toContain("hello logs");
        expect(text).not.toContain("\u001b");
        expect(text).not.toContain("secret-stderr");
    });

    test("rejects a malformed container id on the logs endpoint", async () => {
        const app = makeApp({}, undefined, undefined, undefined, root, fakeInspector(containerFixture()));
        const session = await login(app);
        expect((await authed(app, "/containers/not-hex/logs", session)).status).toBe(400);
    });

    test("bounds the container log snapshot: allow-listed tail, fixed errors, no-store", async () => {
        const seen: (number | undefined)[] = [];
        const base: CommandResult = { code: 0, stdout: "line\n", stderr: "", timedOut: false, truncated: false };
        const inspector: ContainerInspector = {
            engine: "docker",
            list: async () => ({ ...base, stdout: containerFixture() }),
            inspect: async () => base,
            logs: async target => { seen.push(target.tailLines); return { ...base }; },
            info: async () => base,
            stats: async () => base,
            diskUsage: async () => base,
        };
        const app = makeApp({}, undefined, undefined, undefined, root, inspector);
        const session = await login(app);
        const ok = await authed(app, "/containers/bbbbbbbbbbbb/logs?tail=99999", session);
        expect(ok.status).toBe(200);
        expect(ok.headers.get("content-type")).toContain("text/plain");
        expect(ok.headers.get("cache-control")).toBe("no-store");
        // 99999 is not allow-listed, so the bounded default applies.
        expect(seen).toEqual([200]);

        const failing: ContainerInspector = { ...inspector, logs: async () => ({ ...base, code: 1, stderr: "secret-token" }) };
        const failingApp = makeApp({}, undefined, undefined, undefined, root, failing);
        const failingSession = await login(failingApp);
        const denied = await authed(failingApp, "/containers/bbbbbbbbbbbb/logs", failingSession);
        expect(denied.status).toBe(502);
        expect(denied.headers.get("cache-control")).toBe("no-store");
        expect(await denied.text()).not.toContain("secret-token");
    });
});

function serverProvider(): ComposeProvider {
    const empty: CommandResult = { code: 0, stdout: "[]", stderr: "", timedOut: false, truncated: false };
    return {
        engine: "fake",
        listProjects: async () => ({ ...empty, stdout: JSON.stringify([{ Name: "demo", Status: "running(5)", ConfigFiles: join(root, "demo", "compose.yaml") }]) }),
    } as unknown as ComposeProvider;
}

function serverInspector(outputs: { list?: string; info?: CommandResult; stats?: CommandResult; diskUsage?: CommandResult }): ContainerInspector {
    const base: CommandResult = { code: 0, stdout: "", stderr: "", timedOut: false, truncated: false };
    return {
        engine: "docker",
        list: async () => ({ ...base, stdout: outputs.list ?? "" }),
        inspect: async () => base,
        logs: async () => base,
        info: async () => outputs.info ?? base,
        stats: async () => outputs.stats ?? base,
        diskUsage: async () => outputs.diskUsage ?? base,
    };
}

const SERVER_INFO: CommandResult = {
    code: 0,
    stdout: JSON.stringify({
        OperatingSystem: "Ubuntu 22.04.5 LTS", OSType: "linux", Architecture: "x86_64",
        KernelVersion: "5.15.0-107-generic", ServerVersion: "27.3.1", NCPU: 4,
        MemTotal: 16 * 1024 ** 3, Containers: 5, ContainersRunning: 3, Images: 9, Driver: "overlay2",
        RegistryConfig: { secret: "leak" }, HttpProxy: "http://internal",
    }),
    stderr: "", timedOut: false, truncated: false,
};

const SERVER_STATS: CommandResult = {
    code: 0,
    stdout: JSON.stringify({
        Container: "demo-app-1", Name: "demo-app-1", ID: "aaaaaaaaaaaa", CPUPerc: "12.50%",
        MemUsage: "100MiB / 1GiB", MemPerc: "9.77%", NetIO: "1MB / 2MB", BlockIO: "0B / 0B", PIDs: "5",
    }),
    stderr: "", timedOut: false, truncated: false,
};

const SERVER_DF: CommandResult = {
    code: 0,
    stdout: JSON.stringify({ Type: "Images", TotalCount: "9", Active: "4", Size: "8.2GB", Reclaimable: "3.1GB (37%)" }),
    stderr: "", timedOut: false, truncated: false,
};

describe("server page", () => {
    test("requires a session", async () => {
        const app = makeApp({}, undefined, serverProvider(), undefined, root, serverInspector({ list: containerFixture() }));
        const response = await app.fetch(new Request(`${ORIGIN}/server`));
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe("/login");
    });

    test("renders engine facts and container usage without leaking raw info", async () => {
        const app = makeApp({}, undefined, serverProvider(), undefined, root, serverInspector({
            list: containerFixture(), info: SERVER_INFO, stats: SERVER_STATS,
        }));
        const session = await login(app);
        const response = await authed(app, "/server", session);
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("text/html");
        const html = await response.text();
        expect(html).toContain("Ubuntu 22.04.5 LTS");
        expect(html).toContain("demo-app-1");
        expect(html).not.toContain("leak");
        expect(html).not.toContain("http://internal");
    });

    test("names containers from the container list, in the page and in Live, even when stats only give an ID", async () => {
        const idOnly: CommandResult = {
            ...SERVER_STATS,
            stdout: JSON.stringify({ Container: "aaaaaaaaaaaa", ID: "aaaaaaaaaaaa", CPUPerc: "12.50%", MemUsage: "100MiB / 1GiB", MemPerc: "9.77%", NetIO: "1MB / 2MB", BlockIO: "0B / 0B", PIDs: "5" }),
        };
        const app = makeApp({}, undefined, serverProvider(), undefined, root, serverInspector({ list: containerFixture(), info: SERVER_INFO, stats: idOnly }));
        const session = await login(app);
        const html = await (await authed(app, "/server", session)).text();
        expect(html).toContain(">demo-app-1</a>");
        expect(html).not.toContain(">aaaaaaaaaaaa</a>");
        const payload = await (await authed(app, "/server/stats", session)).json() as { stats: { name: string }[] };
        expect(payload.stats[0]!.name).toBe("demo-app-1");
    });

    test("reads disk usage only on demand and caches it", async () => {
        let calls = 0;
        const inspector = serverInspector({ list: containerFixture(), diskUsage: undefined });
        inspector.diskUsage = async () => { calls += 1; return SERVER_DF; };
        const app = makeApp({}, undefined, serverProvider(), undefined, root, inspector);
        const session = await login(app);

        const plain = await (await authed(app, "/server", session)).text();
        expect(calls).toBe(0);
        expect(plain).not.toContain("8.2GB");

        const withDisk = await (await authed(app, "/server?disk=1", session)).text();
        expect(calls).toBe(1);
        expect(withDisk).toContain("8.2GB");

        // A second request within the TTL is served from the cache.
        await authed(app, "/server?disk=1", session);
        expect(calls).toBe(1);
    });

    test("still renders with a note when Docker diagnostics fail", async () => {
        const failure: CommandResult = { code: 1, stdout: "", stderr: "boom", timedOut: false, truncated: false };
        const app = makeApp({}, undefined, serverProvider(), undefined, root, serverInspector({
            list: containerFixture(), info: failure, stats: failure,
        }));
        const session = await login(app);
        const response = await authed(app, "/server", session);
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("note-warn");
    });
});

interface ServerStatsPayload {
    readAt: number;
    runningContainers: number | null;
    stats: { id: string; stack: string | null; category: string | null }[] | null;
    stacks: unknown[] | null;
    attention: unknown[] | null;
    notes: string[];
}

describe("server stats endpoint", () => {
    test("requires a session", async () => {
        const app = makeApp({}, undefined, serverProvider(), undefined, root, serverInspector({ list: containerFixture() }));
        const response = await app.fetch(new Request(`${ORIGIN}/server/stats`));
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe("/login");
    });

    test("returns the dynamic contract and never reads disk usage or info", async () => {
        let diskCalls = 0;
        let infoCalls = 0;
        const inspector = serverInspector({ list: containerFixture(), stats: SERVER_STATS });
        inspector.diskUsage = async () => { diskCalls += 1; return SERVER_DF; };
        inspector.info = async () => { infoCalls += 1; return SERVER_INFO; };
        const app = makeApp({}, undefined, serverProvider(), undefined, root, inspector);
        const session = await login(app);

        const response = await authed(app, "/server/stats", session);
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("application/json");
        expect(response.headers.get("cache-control")).toBe("no-store");

        const payload = await response.json() as ServerStatsPayload;
        expect(payload.runningContainers).toBeGreaterThan(0);
        expect(payload.stats).toHaveLength(1);
        expect(payload.stats![0]!.stack).toBe("demo");
        expect(payload.stats![0]!.category).toBe("managed");
        expect(payload.notes).toEqual([]);
        expect(diskCalls).toBe(0);
        expect(infoCalls).toBe(0);
    });

    test("reports an unavailable section as null with a note, keeping the list-derived fields", async () => {
        const failure: CommandResult = { code: 1, stdout: "", stderr: "boom", timedOut: false, truncated: false };
        const app = makeApp({}, undefined, serverProvider(), undefined, root, serverInspector({ list: containerFixture(), stats: failure }));
        const session = await login(app);

        const response = await authed(app, "/server/stats", session);
        expect(response.status).toBe(200);
        const payload = await response.json() as ServerStatsPayload;
        expect(payload.stats).toBeNull();
        expect(payload.stacks).toBeNull();
        expect(payload.runningContainers).toBeGreaterThan(0);
        expect(Array.isArray(payload.attention)).toBe(true);
        expect(payload.notes.length).toBeGreaterThan(0);
    });
});

describe("self-update (ADR 0018)", () => {
    async function csrfOf(app: App, session: string): Promise<string> {
        return /name="csrf" value="([^"]+)"/.exec(await (await authed(app, "/about", session)).text())![1]!;
    }

    function post(app: App, session: string, path: string, fields: Record<string, string>, origin = ORIGIN): Promise<Response> {
        return authed(app, path, session, {
            method: "POST",
            headers: { origin, "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams(fields).toString(),
        });
    }

    function hangingProvider(): ComposeProvider {
        const { provider } = controllableProvider();
        return { ...provider, up: () => new Promise(() => {}) };
    }

    test("the About page works outside a container and offers no update", async () => {
        const docker = fakeDocker();
        const app = makeApp({}, undefined, undefined, undefined, root, undefined, fakeSelfUpdater(docker, null));
        const session = await login(app);
        const response = await authed(app, "/about", session);
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain(`href="/about" aria-current="page"`);
        expect(html).not.toContain(`action="/about/update"`);
        expect(html).not.toContain(`action="/about/check"`);
        expect(docker.calls.every(args => args[3] === "compose-panel-updater")).toBe(true);
    });

    test("check pulls the panel tag, then update starts the updater and pauses mutations", async () => {
        const docker = fakeDocker();
        const releases = fakeReleases();
        const app = makeApp({}, undefined, controllableProvider().provider, undefined, root, undefined, fakeSelfUpdater(docker, MOUNTINFO, releases));
        const session = await login(app);
        expect(await (await authed(app, "/about", session)).text()).not.toContain(`action="/about/update"`);

        const checked = await post(app, session, "/about/check", { csrf: await csrfOf(app, session) });
        expect(checked.status).toBe(303);
        expect(checked.headers.get("location")).toBe("/about?checked=1");
        expect(docker.calls).toContainEqual(["image", "pull", "--quiet", "--", IMAGE_REF]);
        expect(releases.calls).toEqual(["0.3.0"]);

        const page = await (await authed(app, "/about", session)).text();
        expect(page).toContain(`action="/about/update"`);
        expect(page).toContain(`name="target" value="${NEW_IMAGE}"`);

        const started = await post(app, session, "/about/update", { csrf: await csrfOf(app, session), target: NEW_IMAGE });
        expect(started.status).toBe(303);
        const run = docker.calls.find(args => args[0] === "container" && args[1] === "run");
        expect(run).toBeDefined();
        expect(run).toContain(NEW_IMAGE);
        expect(run!.slice(run!.indexOf("--expected-digest"), run!.indexOf("--expected-digest") + 2)).toEqual(["--expected-digest", NEW_DIGEST]);
        // Install re-reads the release instead of trusting the check.
        expect(releases.calls).toEqual(["0.3.0", "0.3.0"]);

        // While the updater runs, the page waits and no stack action may start.
        const waiting = await (await authed(app, "/about", session)).text();
        expect(waiting).toContain("data-self-update-wait");
        const csrf = await csrfOf(app, session);
        expect((await post(app, session, "/stacks/demo/operations", { csrf, action: "up" })).status).toBe(409);
        expect((await post(app, session, "/about/update", { csrf, target: NEW_IMAGE })).status).toBe(409);

        // The updater ended while this panel is still alive: mutations resume.
        docker.updater = { status: "exited", exitCode: 2 };
        docker.finishWait();
        await Bun.sleep(5);
        expect((await post(app, session, "/stacks/demo/operations", { csrf, action: "up" })).status).toBe(303);
    });

    test("update refuses a stale target, a foreign origin and a missing token", async () => {
        const docker = fakeDocker();
        docker.pulled = true;
        const app = makeApp({}, undefined, undefined, undefined, root, undefined, fakeSelfUpdater(docker));
        const session = await login(app);
        const csrf = await csrfOf(app, session);
        expect((await post(app, session, "/about/update", { csrf, target: `sha256:${"9".repeat(64)}` })).status).toBe(409);
        expect((await post(app, session, "/about/update", { csrf, target: "latest" })).status).toBe(400);
        expect((await post(app, session, "/about/update", { csrf: "wrong", target: NEW_IMAGE })).status).toBe(403);
        expect((await post(app, session, "/about/update", { csrf, target: NEW_IMAGE }, "http://evil.example")).status).toBe(403);
        expect((await post(app, session, "/about/check", { csrf: "wrong" })).status).toBe(403);
        expect((await authed(app, "/about/update", session)).status).toBe(405);
        expect(docker.calls.some(args => args[1] === "run" || args[1] === "pull")).toBe(false);
    });

    const notInstallable: [string, () => FakeReleases][] = [
        ["a release still in its waiting period", () => fakeReleases({ kind: "found", release: releaseJson({ published_at: "2026-10-11T12:00:00Z" }) })],
        ["a release whose digest does not match", () => fakeReleases({ kind: "found", release: releaseJson({ body: `compose-panel-image-digest: sha256:${"8".repeat(64)}` }) })],
        ["a prerelease", () => fakeReleases({ kind: "found", release: releaseJson({ prerelease: true }) })],
        ["GitHub being unreachable", () => fakeReleases({ kind: "unavailable" })],
    ];
    for (const [name, releasesFor] of notInstallable) {
        test(`no install is offered or accepted for ${name}`, async () => {
            const docker = fakeDocker();
            const app = makeApp({}, undefined, undefined, undefined, root, undefined, fakeSelfUpdater(docker, MOUNTINFO, releasesFor()));
            const session = await login(app);
            expect((await post(app, session, "/about/check", { csrf: await csrfOf(app, session) })).status).toBe(303);
            expect(await (await authed(app, "/about", session)).text()).not.toContain(`action="/about/update"`);
            const refused = await post(app, session, "/about/update", { csrf: await csrfOf(app, session), target: NEW_IMAGE });
            expect(refused.status).toBe(409);
            expect(docker.calls.some(args => args[1] === "run")).toBe(false);
        });
    }

    test("an updater start Docker cannot confirm keeps actions paused", async () => {
        const docker = fakeDocker();
        docker.pulled = true;
        docker.runResult = { code: -1, stdout: "", stderr: "", timedOut: true, truncated: false };
        docker.inspectFailsAfterRun = true;
        const app = makeApp({}, undefined, controllableProvider().provider, undefined, root, undefined, fakeSelfUpdater(docker));
        const session = await login(app);
        const csrf = await csrfOf(app, session);
        await post(app, session, "/about/check", { csrf });
        const response = await post(app, session, "/about/update", { csrf, target: NEW_IMAGE });
        expect(response.status).toBe(503);
        expect((await post(app, session, "/stacks/demo/operations", { csrf, action: "up" })).status).toBe(409);
    });

    test("a shutdown during the release check stops the install before the updater starts", async () => {
        const docker = fakeDocker();
        docker.pulled = true;
        let answer!: () => void;
        const releases = fakeReleases();
        const source = releases.source;
        let held = false;
        releases.source = async version => {
            // The check answers at once; the install's fresh re-check is held.
            if (releases.calls.length >= 1 && !held) {
                held = true;
                await new Promise<void>(resolve => { answer = resolve; });
            }
            return source(version);
        };
        const app = makeApp({}, undefined, undefined, undefined, root, undefined, fakeSelfUpdater(docker, MOUNTINFO, releases));
        const session = await login(app);
        const csrf = await csrfOf(app, session);
        await post(app, session, "/about/check", { csrf });
        const install = post(app, session, "/about/update", { csrf, target: NEW_IMAGE });
        while (!held) await Bun.sleep(1);
        const shutdown = app.beginShutdown(50);
        answer();
        expect((await install).status).toBe(503);
        await shutdown;
        expect(docker.calls.some(args => args[1] === "run")).toBe(false);
    });

    test("update is refused while a stack keeps a lock after an unconfirmed termination", async () => {
        const docker = fakeDocker();
        docker.pulled = true;
        const { provider } = controllableProvider();
        const unconfirmed: ComposeProvider = {
            ...provider,
            up: async () => ({ code: -1, stdout: "", stderr: "", timedOut: true, truncated: false, terminationUnconfirmed: true }),
        };
        const app = makeApp({}, undefined, unconfirmed, undefined, root, undefined, fakeSelfUpdater(docker));
        const session = await login(app);
        app.operations.start({ stack: "demo", action: "up", target: { composeFile: join(root, "demo", "compose.yaml"), cwd: join(root, "demo") } });
        while (app.operations.isRunning("demo")) await Bun.sleep(1);
        // The task ended, but the lock is kept on purpose: the stack refuses a new action.
        expect(app.operations.activeCount()).toBe(0);
        const csrf = await csrfOf(app, session);
        expect((await post(app, session, "/stacks/demo/operations", { csrf, action: "up" })).status).toBe(409);

        await post(app, session, "/about/check", { csrf });
        const response = await post(app, session, "/about/update", { csrf, target: NEW_IMAGE });
        expect(response.status).toBe(409);
        expect(docker.calls.some(args => args[1] === "run")).toBe(false);
    });

    test("update waits for running stack actions", async () => {
        const docker = fakeDocker();
        docker.pulled = true;
        const app = makeApp({}, undefined, hangingProvider(), undefined, root, undefined, fakeSelfUpdater(docker));
        const session = await login(app);
        app.operations.start({ stack: "demo", action: "up", target: { composeFile: join(root, "demo", "compose.yaml"), cwd: join(root, "demo") } });
        const response = await post(app, session, "/about/update", { csrf: await csrfOf(app, session), target: NEW_IMAGE });
        expect(response.status).toBe(409);
        expect(docker.calls.some(args => args[1] === "run")).toBe(false);
    });

    test("a failed update shows the escaped updater output", async () => {
        const docker = fakeDocker();
        docker.updater = { status: "exited", exitCode: 1 };
        const app = makeApp({}, undefined, undefined, undefined, root, undefined, fakeSelfUpdater(docker));
        const session = await login(app);
        const html = await (await authed(app, "/about", session)).text();
        expect(html).toContain("&lt;b&gt;not markup&lt;/b&gt;");
        expect(html).not.toContain("<b>not markup</b>");
        expect(html).toContain("state-failed");
    });

    test("both endpoints require a session", async () => {
        const app = makeApp({}, undefined, undefined, undefined, root, undefined, fakeSelfUpdater(fakeDocker()));
        const response = await app.fetch(new Request(`${ORIGIN}/about/update`, { method: "POST", headers: { origin: ORIGIN } }));
        expect(response.status).toBe(401);
        expect((await app.fetch(new Request(`${ORIGIN}/about`))).status).toBe(302);
    });
});
