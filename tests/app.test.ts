import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp, type App } from "../src/app.ts";
import type { AppConfig } from "../src/config.ts";
import type { CommandResult, DockerRunner } from "../src/docker.ts";
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

function makeApp(overrides: Partial<AppConfig> = {}, runner?: DockerRunner): App {
    const config: AppConfig = {
        stacksDir: root,
        port: 5081,
        adminUser: "admin",
        adminPasswordHash: passwordHash,
        cookieSecure: false,
        publicOrigin: null,
        trustProxy: false,
        sessionTtlMs: 3_600_000,
        sessionIdleMs: 3_600_000,
        loginRateLimit: { windowMs: 60_000, maxAttempts: 5, blockMs: 60_000 },
        maxBodyBytes: 8192,
        maxEditBytes: 1024 * 1024,
        dockerPath: "docker",
        composeEngine: "docker",
        dockerTimeoutMs: 5000,
        dockerMaxBytes: 1024 * 1024,
        operationTimeoutMs: 60_000,
        shutdownGraceMs: 5_000,
        ...overrides,
    };
    return createApp({ config, stacksRoot: root, runner });
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
        expect(setCookies(response).some(cookie => cookie.startsWith("cp_csrf="))).toBe(true);
        expect(await response.text()).toContain('name="csrf"');
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
    test("rejects a POST with a mismatched Origin", async () => {
        const app = makeApp();
        const { cookie, csrf } = await loginCsrf(app);
        const response = await postLogin(app, cookie, csrf, "admin", PASSWORD, "http://evil.example");
        expect(response.status).toBe(403);
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

    test("locks out after repeated failures", async () => {
        const app = makeApp();
        for (let attempt = 0; attempt < 5; attempt += 1) {
            const { cookie, csrf } = await loginCsrf(app);
            expect((await postLogin(app, cookie, csrf, "admin", "wrong")).status).toBe(401);
        }
        const { cookie, csrf } = await loginCsrf(app);
        const blocked = await postLogin(app, cookie, csrf, "admin", PASSWORD);
        expect(blocked.status).toBe(429);
        expect(blocked.headers.get("retry-after")).toBeTruthy();
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
        expect(html).toContain("Docker state is unavailable.");
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
        expect(response.headers.get("location")).toBe("/stacks/demo");
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
