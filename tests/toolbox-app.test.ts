import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp, type App } from "../src/app.ts";
import type { AppConfig } from "../src/config.ts";
import type { CommandResult, DockerRunner } from "../src/docker.ts";
import type { ComposeCapabilities, ComposeProvider, ComposeTarget } from "../src/compose-provider.ts";
import type { ContainerInspector } from "../src/containers.ts";
import type { ActionRunner } from "../src/action-runner.ts";
import { resolveRoot } from "../src/stacks.ts";

const PASSWORD = "correct horse battery staple";
const ORIGIN = "http://localhost";
const ID = "df48a7b63a0a611b2a1b7050ac56f05338b4eaf24ee1ef83c456fa56beecc10d";
const IMAGE = "sha256:" + "a".repeat(64);
const COMPOSE = `x-compose-panel:
  toolbox:
    sources:
      - id: backend
        service: app
        runner: composer
        workdir: /app
services:
  app:
    image: my-app:latest
`;

let root: string;
let passwordHash: string;

beforeAll(async () => {
    root = await resolveRoot(await mkdtemp(join(tmpdir(), "compose-panel-toolbox-")));
    await mkdir(join(root, "demo"));
    await writeFile(join(root, "demo", "compose.yaml"), COMPOSE);
    passwordHash = await Bun.password.hash(PASSWORD);
});

afterAll(async () => {
    await rm(root, { recursive: true, force: true });
});

const ok: CommandResult = { code: 0, stdout: "", stderr: "", timedOut: false, truncated: false };
const caps: ComposeCapabilities = { engine: "fake", available: true, operations: { ls: true, ps: true, config: true, logs: true } };

function manifest(scripts: Record<string, string>, actions: Record<string, unknown>): string {
    return JSON.stringify({ scripts, extra: { "compose-panel": { version: 1, actions } } });
}

interface Harness {
    app: App;
    execCalls: string[][];
    setRunning(ids: string[] | null): void;
    setManifest(raw: string): void;
    /** Runs once, on the next container resolution (the POST pre-check). */
    armOnResolve(fn: () => Promise<void>): void;
}

async function harness(options: { audit?: boolean } = {}): Promise<Harness> {
    let running: string[] | null = [ID];
    let manifestRaw = manifest({ "cache:clear": "php bin/console cache:clear" }, { "cache:clear": { label: "Clear cache" } });
    const execCalls: string[][] = [];
    let onResolve: (() => Promise<void>) | null = null;

    const provider: ComposeProvider = {
        engine: "fake",
        capabilities: () => caps,
        detect: async () => caps,
        listProjects: async () => ({ ...ok, stdout: JSON.stringify([{ Name: "demo-proj", Status: "running(1)", ConfigFiles: join(root, "demo", "compose.yaml") }]) }),
        projectName: async () => "demo-proj",
        projectServices: async () => ok,
        projectImages: async () => ok,
        stackMetadata: async () => ({}),
        inspectImages: async () => ok,
        inspectContainers: async () => ok,
        validateConfig: async () => ok,
        listServices: async () => [],
        runningContainerIds: async () => {
            if (onResolve) { const fn = onResolve; onResolve = null; await fn(); }
            return running;
        },
        readLogs: async () => ok,
        pull: async () => ok,
        up: async () => ok,
        stop: async () => ok,
        start: async () => ok,
        restart: async () => ok,
        down: async () => ok,
        serviceImage: async () => null,
        recreateService: async () => ok,
        followLogs: async (_target: ComposeTarget & { tailLines?: number }) => ({ code: 0, timedOut: false }),
    } as ComposeProvider;

    const inspector: ContainerInspector = {
        engine: "fake",
        list: async () => ok,
        inspect: async () => ({ ...ok, stdout: JSON.stringify([{ Id: ID, Image: IMAGE, Config: { WorkingDir: "/app" } }]) }),
        logs: async () => ok,
        info: async () => ok,
        stats: async () => ok,
        diskUsage: async () => ok,
    };

    const actionRunner: ActionRunner = {
        engine: "fake",
        readFile: async () => ({ kind: "ok", content: manifestRaw }),
        exec: async target => { execCalls.push(target.argv); target.onOutput?.("done\n"); return ok; },
    };

    const config: AppConfig = {
        stacksDir: root,
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
        audit: { enabled: options.audit === true, dir: null, rotation: "day", retainFiles: 31, maxReadLines: 2000, maxFileBytes: 10 * 1024 * 1024 },
        maxBodyBytes: 8192,
        maxEditBytes: 1024 * 1024,
        backupRetain: 10,
        dockerPath: "docker",
        composeEngine: "docker",
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
    };
    const runner: DockerRunner = async () => ok;
    const app = createApp({ config, stacksRoot: root, runner, provider, inspector, actionRunner });
    return { app, execCalls, setRunning: ids => { running = ids; }, setManifest: raw => { manifestRaw = raw; }, armOnResolve: fn => { onResolve = fn; } };
}

function setCookies(response: Response): string[] {
    const headers = response.headers as unknown as { getSetCookie?: () => string[] };
    if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
    const single = response.headers.get("set-cookie");
    return single ? [single] : [];
}

function cookieValue(cookies: string[], name: string): string | null {
    for (const cookie of cookies) if (cookie.startsWith(`${name}=`)) return cookie.slice(name.length + 1).split(";")[0]!;
    return null;
}

async function login(app: App): Promise<string> {
    const page = await app.fetch(new Request(`${ORIGIN}/login`));
    const csrfCookie = cookieValue(setCookies(page), "cp_csrf")!;
    const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())![1]!;
    const response = await app.fetch(new Request(`${ORIGIN}/login`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie: `cp_csrf=${csrfCookie}` },
        body: new URLSearchParams({ csrf, user: "admin", password: PASSWORD }).toString(),
    }));
    return cookieValue(setCookies(response), "cp_session")!;
}

async function post(app: App, session: string, body: Record<string, string>, init: { origin?: string | null; csrf?: string } = {}): Promise<Response> {
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", cookie: `cp_session=${session}` };
    if (init.origin !== null) headers["origin"] = init.origin ?? ORIGIN;
    return app.fetch(new Request(`${ORIGIN}/stacks/demo/actions`, { method: "POST", headers, body: new URLSearchParams(body).toString() }));
}

function revisionFrom(html: string): string {
    return /name="revision" value="([0-9a-f]+)"/.exec(html)?.[1] ?? "";
}

async function settle(app: App): Promise<void> {
    for (let i = 0; i < 200 && app.operations.activeCount() > 0; i += 1) await new Promise(resolve => setTimeout(resolve, 1));
}

describe("application toolbox routes", () => {
    test("requires a session for the actions page", async () => {
        const { app } = await harness();
        const response = await app.fetch(new Request(`${ORIGIN}/stacks/demo/actions`));
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe("/login");
    });

    test("renders the declared action and its revision", async () => {
        const { app } = await harness();
        const session = await login(app);
        const response = await app.fetch(new Request(`${ORIGIN}/stacks/demo/actions`, { headers: { cookie: `cp_session=${session}` } }));
        const html = await response.text();
        expect(response.status).toBe(200);
        expect(html).toContain("Clear cache");
        expect(revisionFrom(html)).toMatch(/^[0-9a-f]{64}$/);
    });

    test("refuses a POST without CSRF", async () => {
        const { app } = await harness();
        const session = await login(app);
        const response = await post(app, session, { source: "backend", action: "cache:clear", revision: "x", csrf: "wrong" });
        expect(response.status).toBe(403);
    });

    test("runs a declared action with the fixed runner argv", async () => {
        const { app, execCalls } = await harness();
        const session = await login(app);
        const page = await app.fetch(new Request(`${ORIGIN}/stacks/demo/actions`, { headers: { cookie: `cp_session=${session}` } }));
        const revision = revisionFrom(await page.text());
        const csrf = await sessionCsrf(app, session);
        const response = await post(app, session, { source: "backend", action: "cache:clear", revision, csrf });
        expect(response.status).toBe(303);
        await settle(app);
        expect(execCalls).toEqual([["composer", "--no-interaction", "run-script", "cache:clear"]]);
        expect(app.operations.forStack("demo")!.status).toBe("succeeded");
    });

    test("refuses an undeclared action name", async () => {
        const { app, execCalls } = await harness();
        const session = await login(app);
        const csrf = await sessionCsrf(app, session);
        const response = await post(app, session, { source: "backend", action: "rm:all", revision: await pageRevision(app, session), csrf });
        expect(response.status).toBe(409);
        await settle(app);
        expect(execCalls).toHaveLength(0);
    });

    test("refuses an option-like action name before any Docker call", async () => {
        const { app, execCalls } = await harness();
        const session = await login(app);
        const csrf = await sessionCsrf(app, session);
        const response = await post(app, session, { source: "backend", action: "-rf", revision: "", csrf });
        expect(response.status).toBe(400);
        expect(execCalls).toHaveLength(0);
    });

    test("refuses an unknown source", async () => {
        const { app } = await harness();
        const session = await login(app);
        const csrf = await sessionCsrf(app, session);
        const response = await post(app, session, { source: "nope", action: "cache:clear", revision: "", csrf });
        expect(response.status).toBe(404);
    });

    test("refuses when the manifest changed since the page was loaded", async () => {
        const { app, execCalls, setManifest } = await harness();
        const session = await login(app);
        const csrf = await sessionCsrf(app, session);
        setManifest(manifest({ "cache:clear": "rm -rf / && php bin/console cache:clear" }, { "cache:clear": { label: "Clear cache" } }));
        const response = await post(app, session, { source: "backend", action: "cache:clear", revision: "0".repeat(64), csrf });
        expect(response.status).toBe(409);
        await settle(app);
        expect(execCalls).toHaveLength(0);
    });

    test("revalidates the declaration under the lock: a source removed mid-flight is refused", async () => {
        const { app, execCalls, armOnResolve } = await harness({ audit: true });
        const session = await login(app);
        const revision = await pageRevision(app, session);
        const csrf = await sessionCsrf(app, session);
        // Simulate a save that removes the source between the POST pre-check and
        // the locked revalidation: the action must not run with the stale source.
        armOnResolve(async () => {
            await writeFile(join(root, "demo", "compose.yaml"), "services:\n  app:\n    image: my-app:latest\n");
        });
        try {
            const response = await post(app, session, { source: "backend", action: "cache:clear", revision, csrf });
            expect(response.status).toBe(303);
            await settle(app);
            // Under-lock revalidation refusal: nothing ran, distinct from a failed run.
            expect(app.operations.forStack("demo")!.status).toBe("refused");
            expect(execCalls).toHaveLength(0);
            // The activity log says "refused", never "failure".
            const line = await auditLogLine('"result":"refused"');
            expect(line).toContain('"event":"toolbox"');
        } finally {
            await writeFile(join(root, "demo", "compose.yaml"), COMPOSE);
        }
    });

    test("reports a stopped service as unavailable and refuses to run", async () => {
        const { app, execCalls, setRunning } = await harness();
        const session = await login(app);
        const csrf = await sessionCsrf(app, session);
        const revision = await pageRevision(app, session);
        setRunning([]);
        const response = await post(app, session, { source: "backend", action: "cache:clear", revision, csrf });
        expect(response.status).toBe(409);
        expect(execCalls).toHaveLength(0);
    });

    test("refuses a service that has several running containers (replicas)", async () => {
        const { app, execCalls, setRunning } = await harness();
        const session = await login(app);
        const csrf = await sessionCsrf(app, session);
        const revision = await pageRevision(app, session);
        setRunning([ID, "e".repeat(64)]);
        const response = await post(app, session, { source: "backend", action: "cache:clear", revision, csrf });
        expect(response.status).toBe(409);
        expect(execCalls).toHaveLength(0);
    });

    test("records the executed identity in the activity log", async () => {
        const { app } = await harness({ audit: true });
        const session = await login(app);
        const revision = await pageRevision(app, session);
        const csrf = await sessionCsrf(app, session);
        const response = await post(app, session, { source: "backend", action: "cache:clear", revision, csrf });
        expect(response.status).toBe(303);
        await settle(app);
        const line = await auditLogLine();
        expect(line).toContain('"event":"toolbox"');
        expect(line).toContain(ID);
        expect(line).toContain(IMAGE);
        expect(line).toContain(revision);
    });
});

/** Poll the day's audit file until a toolbox line containing `needle` is written. */
async function auditLogLine(needle: string = ID): Promise<string> {
    const dir = join(root, ".compose-panel", "audit");
    for (let i = 0; i < 400; i += 1) {
        try {
            const files = (await readdir(dir)).filter(name => name.endsWith(".log")).sort();
            if (files.length > 0) {
                const text = await readFile(join(dir, files[files.length - 1]!), "utf8");
                if (text.includes('"event":"toolbox"') && text.includes(needle)) return text;
            }
        } catch { /* the audit file is not created yet */ }
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error("The audit line was not written in time.");
}

/** The per-session CSRF token is on the authenticated pages; read it from the stack page. */
async function sessionCsrf(app: App, session: string): Promise<string> {
    const response = await app.fetch(new Request(`${ORIGIN}/stacks/demo/actions`, { headers: { cookie: `cp_session=${session}` } }));
    const html = await response.text();
    return /name="csrf" value="([^"]+)"/.exec(html)![1]!;
}

/** The catalog revision rendered into the action forms. */
async function pageRevision(app: App, session: string): Promise<string> {
    const response = await app.fetch(new Request(`${ORIGIN}/stacks/demo/actions`, { headers: { cookie: `cp_session=${session}` } }));
    return revisionFrom(await response.text());
}
