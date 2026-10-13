import { afterAll, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { createActionRunner, type ActionRunner } from "../src/action-runner.ts";
import { createDockerRunner } from "../src/docker.ts";
import { buildCatalog, buildRunnerArgv, type ToolboxSource } from "../src/toolbox.ts";

// Opt-in integration check of the application-toolbox Docker boundary
// (`docker cp` read + `docker exec` launch) against a REAL but DISPOSABLE
// Docker Engine. It creates and removes one container, so it refuses to run
// unless every guard below proves the daemon is the lab one. Never run it on a
// host or production daemon, never in unattended CI. Use
// scripts/docker-lab/run.sh, which starts the lab daemon and sets:
//   COMPOSE_PANEL_TEST_DOCKER_LAB=1
//   DOCKER_HOST=unix:///<lab dir>/socket/docker.sock
// The lab dockerd carries the engine label `compose-panel-lab=1`. Linux only.
const LAB_LABEL = "compose-panel-lab=1";
const enabled = process.env.COMPOSE_PANEL_TEST_DOCKER_LAB === "1";
const CONTAINER = "cp-qa-toolbox";
const IMAGE = "node:22-alpine";
const MANIFEST = JSON.stringify({
    name: "lab",
    scripts: { hello: "echo toolbox-ok" },
    "compose-panel": { version: 1, actions: { hello: { label: "Say hello" } } },
});

interface Run { code: number; stdout: string; stderr: string }

async function docker(args: string[], timeoutMs = 120_000): Promise<Run> {
    const proc = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: timeoutMs });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, stdout, stderr };
}

async function dockerOk(args: string[], timeoutMs?: number): Promise<string> {
    const result = await docker(args, timeoutMs);
    if (result.code !== 0) throw new Error(`docker ${args.join(" ")} failed (${result.code}): ${result.stderr.trim()}`);
    return result.stdout;
}

async function assertLabDaemon(): Promise<void> {
    if (process.platform !== "linux") throw new Error("The Docker lab test runs on Linux only.");
    const host = process.env.DOCKER_HOST ?? "";
    if (!host.startsWith("unix://")) throw new Error("DOCKER_HOST must point to the lab Unix socket (unix://...).");
    const socket = host.slice("unix://".length);
    let real: string;
    try { real = realpathSync(socket); }
    catch { throw new Error(`Lab socket ${socket} does not exist.`); }
    if (["/var/run/docker.sock", "/run/docker.sock"].includes(real) || real.startsWith("/run/user/")) {
        throw new Error(`DOCKER_HOST resolves to a default daemon socket (${real}); refusing.`);
    }
    for (const name of ["DOCKER_CONTEXT", "COMPOSE_PROJECT_NAME", "COMPOSE_FILE", "COMPOSE_ENV_FILES", "COMPOSE_PROFILES"]) {
        if (process.env[name]) throw new Error(`Unset ${name} before running the lab test.`);
    }
    const labels = JSON.parse(await dockerOk(["info", "--format", "{{json .Labels}}"])) as string[] | null;
    if (!labels?.includes(LAB_LABEL)) throw new Error(`The daemon behind DOCKER_HOST lacks the engine label ${LAB_LABEL}; refusing.`);
    // The lifecycle suite shares this daemon; only require that our own
    // disposable container name is free, and clean it up if a run was aborted.
    await docker(["rm", "-f", CONTAINER]);
}

const SOURCE: ToolboxSource = { id: "lab", service: "app", runner: "npm", workdir: "/app", user: null, manifestFile: "package.json" };

// Set up lazily, awaited by each test with an explicit timeout: the `docker run`
// below pulls the image, so it must not run inside a default (5 s) test hook.
let containerId = "";
let actionRunner: ActionRunner;
let setup: Promise<void> | null = null;

function ready(): Promise<void> {
    if (!setup) {
        setup = (async () => {
            await assertLabDaemon();
            const command = `mkdir -p /app && printf %s '${Buffer.from(MANIFEST, "utf8").toString("base64")}' | base64 -d > /app/package.json && sleep 3600`;
            await dockerOk(["run", "-d", "--name", CONTAINER, IMAGE, "sh", "-c", command], 300_000);
            containerId = (await dockerOk(["inspect", "--format", "{{.Id}}", CONTAINER])).trim();
            actionRunner = createActionRunner({ runner: createDockerRunner() });
        })();
    }
    return setup;
}

describe.skipIf(!enabled)("Application toolbox on a disposable lab daemon", () => {
    afterAll(async () => {
        // Only remove after the setup ran, and only our own container: never
        // touch anything on a daemon that refused the guards.
        if (containerId) await docker(["rm", "-f", CONTAINER], 30_000);
    });

    test("reads the manifest out of the container and builds a catalog", async () => {
        await ready();
        const file = await actionRunner.readFile(containerId, "/app/package.json", { timeoutMs: 30_000, maxBytes: 256 * 1024 });
        expect(file.kind).toBe("ok");
        if (file.kind !== "ok") return;
        const catalog = buildCatalog(SOURCE, file.content, { containerId, imageId: "sha256:" + "0".repeat(64) }, { maxActions: 50, maxTimeoutMs: 900_000 });
        expect(catalog.ok).toBe(true);
        if (!catalog.ok) return;
        expect(catalog.value.actions.map(action => action.name)).toEqual(["hello"]);
    }, 300_000);

    test("runs the declared script non-interactively and returns its output", async () => {
        await ready();
        const result = await actionRunner.exec({
            id: containerId,
            argv: buildRunnerArgv("npm", "hello"),
            workdir: "/app",
            timeoutMs: 60_000,
            maxBytes: 64 * 1024,
        });
        expect(result.code).toBe(0);
        expect(result.stdout).toContain("toolbox-ok");
    }, 120_000);

    test("refuses a manifest path that is a directory", async () => {
        await ready();
        const result = await actionRunner.readFile(containerId, "/app", { timeoutMs: 30_000, maxBytes: 256 * 1024 });
        expect(result.kind).toBe("not-file");
    }, 60_000);

    test("refuses symlinks and oversized manifests without copying to disk", async () => {
        await ready();
        // Fixed fixture setup on the guarded disposable daemon only.
        await dockerOk(["exec", containerId, "ln", "-s", "/app/package.json", "/app/link.json"]);
        await dockerOk(["exec", containerId, "truncate", "-s", "2097152", "/app/huge.json"]);
        expect((await actionRunner.readFile(containerId, "/app/link.json", { timeoutMs: 30_000, maxBytes: 1024 })).kind).toBe("not-file");
        expect((await actionRunner.readFile(containerId, "/app/huge.json", { timeoutMs: 30_000, maxBytes: 1024 })).kind).toBe("too-large");
    }, 60_000);
});
