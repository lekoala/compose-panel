import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashPassword } from "../src/auth.ts";
import { createComposeProvider } from "../src/compose-provider.ts";
import { createDockerRunner } from "../src/docker.ts";
import { UPDATER_EXIT, parseSelfInspect, updaterCommand } from "../src/self-update.ts";
import { parseUpdaterArgs, runSelfUpdate } from "../src/self-update-run.ts";

// Opt-in lifecycle check against a REAL but DISPOSABLE Docker Engine: project
// collisions by `name:` and `.env`, and SIGTERM during a deterministically
// delayed operation. It creates and removes containers, so it refuses to run
// unless every guard below proves the daemon is the lab one. Never run it on
// a host or production daemon, never in unattended CI. Use
// scripts/docker-lab/run.sh, which starts the lab daemon and sets:
//   COMPOSE_PANEL_TEST_DOCKER_LAB=1
//   DOCKER_HOST=unix:///<lab dir>/socket/docker.sock
// The lab dockerd carries the engine label `compose-panel-lab=1`; an empty
// daemon is required before the first mutation.
const LAB_LABEL = "compose-panel-lab=1";
const enabled = process.env.COMPOSE_PANEL_TEST_DOCKER_LAB === "1";
const IMAGE = "alpine:3.20";
const PASSWORD = "temporary-lab-password";
const USER = "cplaboperator";
const GRACE_MS = 15_000;
const DELAY_S = 6;
const PROJECTS = ["cp-qa-shared", "cp-qa-unique", "cp-qa-delayed", "cp-qa-self", "cp-qa-scoped", "cp-qa-pull"];
// A PID 1 that exits on SIGTERM, so `down` does not wait for the kill timeout.
const SERVICE = (name: string) => `  ${name}:\n    image: ${IMAGE}\n    command: ["sh", "-c", "trap 'exit 0' TERM; sleep 3600 & wait"]\n`;

interface Run { code: number; stdout: string; stderr: string }

async function docker(args: string[], timeoutMs = 60_000): Promise<Run> {
    const proc = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: timeoutMs });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, stdout, stderr };
}

async function dockerOk(args: string[], timeoutMs?: number): Promise<string> {
    const result = await docker(args, timeoutMs);
    if (result.code !== 0) throw new Error(`docker ${args.join(" ")} failed (${result.code}): ${result.stderr.trim()}`);
    return result.stdout;
}

/**
 * Refuse anything but the lab daemon. Runs before the first mutation and
 * throws (never skips) once the suite is opted in.
 */
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
    if ((await dockerOk(["ps", "-aq"])).trim() !== "") throw new Error("The lab daemon must start without containers; refusing.");
}

async function freePort(): Promise<number> {
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = probe.port!;
    probe.stop(true);
    return port;
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await check()) return;
        await Bun.sleep(100);
    }
    throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}.`);
}

/** Names of the services that have a container in a project, sorted. */
async function projectServices(project: string): Promise<string[]> {
    const out = await dockerOk(["ps", "-a", "--filter", `label=com.docker.compose.project=${project}`, "--format", '{{.Label "com.docker.compose.service"}}']);
    return out.split("\n").map(line => line.trim()).filter(Boolean).sort();
}

async function runningServices(project: string): Promise<string[]> {
    const out = await dockerOk(["ps", "--filter", `label=com.docker.compose.project=${project}`, "--filter", "status=running", "--format", '{{.Label "com.docker.compose.service"}}']);
    return out.split("\n").map(line => line.trim()).filter(Boolean).sort();
}

/** The real panel process (`bun src/server.ts`) with captured output. */
class Panel {
    readonly origin: string;
    output = "";
    private cookies = new Map<string, string>();
    constructor(readonly proc: Bun.Subprocess<"ignore", "pipe", "pipe">, port: number) {
        this.origin = `http://127.0.0.1:${port}`;
        for (const stream of [proc.stdout, proc.stderr]) void this.collect(stream);
    }

    private async collect(stream: ReadableStream<Uint8Array>): Promise<void> {
        const decoder = new TextDecoder();
        for await (const chunk of stream) this.output += decoder.decode(chunk, { stream: true });
    }

    private cookieHeader(): string {
        return [...this.cookies].map(([key, value]) => `${key}=${value}`).join("; ");
    }

    private keepCookies(response: Response): void {
        for (const header of response.headers.getSetCookie()) {
            const [pair] = header.split(";");
            const index = pair!.indexOf("=");
            this.cookies.set(pair!.slice(0, index), pair!.slice(index + 1));
        }
    }

    async get(path: string): Promise<Response> {
        const response = await fetch(this.origin + path, { headers: { cookie: this.cookieHeader() }, redirect: "manual" });
        this.keepCookies(response);
        return response;
    }

    async post(path: string, fields: Record<string, string>): Promise<Response> {
        const response = await fetch(this.origin + path, {
            method: "POST",
            redirect: "manual",
            headers: { "content-type": "application/x-www-form-urlencoded", origin: this.origin, cookie: this.cookieHeader() },
            body: new URLSearchParams(fields).toString(),
        });
        this.keepCookies(response);
        return response;
    }

    private static csrf(html: string): string {
        const match = /name="csrf" value="([^"]+)"/.exec(html);
        if (!match) throw new Error("No CSRF token on the page.");
        return match[1]!;
    }

    async login(): Promise<void> {
        const page = await this.get("/login");
        const response = await this.post("/login", { csrf: Panel.csrf(await page.text()), user: USER, password: PASSWORD });
        expect(response.status).toBe(303);
    }

    /** POST an action the way the stack page form does, with its CSRF token. */
    async action(stack: string, action: string, extra: Record<string, string> = {}): Promise<Response> {
        const page = await this.get(`/stacks/${stack}`);
        expect(page.status).toBe(200);
        return this.post(`/stacks/${stack}/operations`, { csrf: Panel.csrf(await page.text()), action, ...extra });
    }

    /** Follow the operation stream until it reports a final status. */
    async operationResult(stack: string, timeoutMs: number): Promise<string> {
        const response = await fetch(`${this.origin}/stacks/${stack}/operations/events`, {
            headers: { cookie: this.cookieHeader() },
            signal: AbortSignal.timeout(timeoutMs),
        });
        expect(response.status).toBe(200);
        const decoder = new TextDecoder();
        let buffer = "";
        for await (const chunk of response.body!) {
            buffer += decoder.decode(chunk, { stream: true });
            let end: number;
            while ((end = buffer.indexOf("\n\n")) !== -1) {
                const frame = buffer.slice(0, end);
                buffer = buffer.slice(end + 2);
                const event = /^event: (.+)$/m.exec(frame)?.[1];
                const data = /^data: (.+)$/m.exec(frame)?.[1];
                if ((event === "done" || event === "snapshot") && data) {
                    const status = (JSON.parse(data) as { status?: string }).status;
                    // Leaving the for-await loop cancels the stream.
                    if (status && status !== "running" && status !== "none") return status;
                }
            }
        }
        throw new Error(`The operation stream of ${stack} ended without a final status.`);
    }
}

describe.skipIf(!enabled)("Docker lifecycle on a disposable lab daemon", () => {
    let lab = "";
    let stacks = "";
    let marker = "";
    let panel: Panel | undefined;
    let guardPassed = false;

    beforeAll(async () => {
        await assertLabDaemon();
        guardPassed = true;
        lab = await mkdtemp(join(tmpdir(), "compose-panel-lab-test-"));
        stacks = join(lab, "stacks");
        marker = join(lab, "delayed-up-started");
        const files: Record<string, string> = {
            "owner/compose.yaml": `name: cp-qa-shared\nservices:\n${SERVICE("witness")}`,
            "duplicate/compose.yaml": `name: cp-qa-shared\nservices:\n${SERVICE("intruder")}`,
            "duplicate-env/compose.yaml": `services:\n${SERVICE("intruder")}`,
            "duplicate-env/.env": "COMPOSE_PROJECT_NAME=cp-qa-shared\n",
            "unique/compose.yaml": `name: cp-qa-unique\nservices:\n${SERVICE("app")}`,
            "delayed/compose.yaml": `name: cp-qa-delayed\nservices:\n${SERVICE("app")}`,
            "pullable/compose.yaml": [
                "name: cp-qa-pull",
                "services:",
                `  remote:\n    image: ${IMAGE}\n    command: ["sh", "-c", "trap 'exit 0' TERM; sleep 3600 & wait"]`,
                "  local:\n    build: .",
                "  both:\n    image: cp-qa-pull-both:local\n    build: .",
                "",
            ].join("\n"),
            "pullable/Dockerfile": `FROM ${IMAGE}\nCMD ["sh", "-c", "trap 'exit 0' TERM; sleep 3600 & wait"]\n`,
            "scoped/compose.yaml": [
                "name: cp-qa-scoped",
                "services:",
                `  db:\n    image: ${IMAGE}\n    command: ["sh", "-c", "trap 'exit 0' TERM; sleep 3600 & wait"]`,
                `  worker:\n    image: ${IMAGE}\n    depends_on: [db]\n    command: ["sh", "-c", "trap 'exit 0' TERM; sleep 3600 & wait"]`,
                `  web:\n    image: ${IMAGE}\n    depends_on: [db]\n    command: ["sh", "-c", "trap 'exit 0' TERM; sleep 3600 & wait"]`,
                "",
            ].join("\n"),
        };
        for (const [path, content] of Object.entries(files)) {
            await mkdir(join(stacks, path, ".."), { recursive: true });
            await writeFile(join(stacks, path), content);
        }

        // Clearly marked fixture: delegates every call to the real Docker CLI,
        // but holds `up` of cp-qa-delayed for a fixed time after writing a
        // marker, so SIGTERM lands during a real operation, deterministically.
        const realDocker = Bun.which("docker");
        if (!realDocker) throw new Error("docker CLI not found in PATH.");
        const wrapper = join(lab, "docker-slow");
        await writeFile(wrapper, [
            "#!/bin/sh",
            "# Lab fixture: delays `compose ... -p cp-qa-delayed ... up` only.",
            'case " $* " in',
            `  *" -p cp-qa-delayed "*" up -d "*) : > '${marker}'; sleep ${DELAY_S} ;;`,
            "esac",
            `exec '${realDocker}' "$@"`,
            "",
        ].join("\n"));
        await chmod(wrapper, 0o700);

        await dockerOk(["pull", IMAGE], 180_000);
        // The owner project exists before the panel starts, created by the CLI.
        await dockerOk(["compose", "-f", join(stacks, "owner/compose.yaml"), "up", "-d"]);

        const port = await freePort();
        const proc = Bun.spawn([process.execPath, "src/server.ts"], {
            cwd: join(import.meta.dir, ".."),
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            env: {
                ...process.env,
                STACKS_DIR: stacks,
                PORT: String(port),
                COMPOSE_PANEL_ADMIN_USER: USER,
                COMPOSE_PANEL_ADMIN_PASSWORD_HASH: await hashPassword(PASSWORD),
                COMPOSE_PANEL_DOCKER_PATH: wrapper,
                COMPOSE_PANEL_AUDIT_DIR: join(lab, "audit"),
                COMPOSE_PANEL_SHUTDOWN_GRACE_MS: String(GRACE_MS),
            },
        });
        panel = new Panel(proc, port);
        await waitFor(async () => {
            if (proc.exitCode !== null) throw new Error(`The panel exited during startup:\n${panel!.output}`);
            try { return (await fetch(`${panel!.origin}/health/live`)).ok; }
            catch { return false; }
        }, 20_000, "the panel to listen");
        await panel.login();
    }, 240_000);

    afterAll(async () => {
        if (panel && panel.proc.exitCode === null) panel.proc.kill("SIGKILL");
        // Only remove what this suite created, and only on the verified lab daemon.
        if (guardPassed) {
            for (const project of PROJECTS) await docker(["compose", "-p", project, "down", "--remove-orphans", "--timeout", "2"]);
        }
        if (lab) await rm(lab, { recursive: true, force: true });
    }, 60_000);

    test("refuses to take over an existing project by name: or .env, and creates a unique one", async () => {
        const p = panel!;
        expect(await projectServices("cp-qa-shared")).toEqual(["witness"]);

        const byName = await p.action("duplicate", "up");
        expect(byName.status).toBe(409);
        expect(await byName.text()).toContain("already used by another stack");
        const byEnv = await p.action("duplicate-env", "up");
        expect(byEnv.status).toBe(409);
        // Destructive actions on a collision stay refused too.
        expect((await p.action("duplicate", "down")).status).toBe(409);
        expect(await projectServices("cp-qa-shared")).toEqual(["witness"]);
        expect(await runningServices("cp-qa-shared")).toEqual(["witness"]);

        const unique = await p.action("unique", "up");
        expect(unique.status).toBe(303);
        expect(await p.operationResult("unique", 60_000)).toBe("succeeded");
        expect(await runningServices("cp-qa-unique")).toEqual(["app"]);
        // Still manageable by the plain CLI, without the panel or its -p.
        const cli = await dockerOk(["compose", "-f", join(stacks, "unique/compose.yaml"), "ps", "-q"]);
        expect(cli.trim()).not.toBe("");
        expect(await projectServices("cp-qa-shared")).toEqual(["witness"]);
    }, 90_000);

    test("self-update recreates only the panel service from the retagged image and verifies it (ADR 0018)", async () => {
        // Clearly marked fixture: a stand-in "panel" service with a health
        // check and the lab socket mounted like the real deployment, next to
        // another service that must not be touched. The updater logic runs
        // in this process (not in its container) against the lab daemon.
        const dir = join(lab, "self");
        await mkdir(dir, { recursive: true });
        const command = `["sh", "-c", "trap 'exit 0' TERM; sleep 3600 & wait"]`;
        await writeFile(join(dir, "compose.yaml"), [
            "name: cp-qa-self",
            "services:",
            "  panel:",
            "    image: cp-qa-self:current",
            `    command: ${command}`,
            "    volumes: [\"/lab/docker.sock:/var/run/docker.sock\"]",
            "    healthcheck: { test: [\"CMD\", \"true\"], interval: 1s, timeout: 1s, retries: 3 }",
            "  other:",
            `    image: ${IMAGE}`,
            `    command: ${command}`,
            "",
        ].join("\n"));
        await dockerOk(["tag", IMAGE, "cp-qa-self:current"]);
        await dockerOk(["compose", "-f", join(dir, "compose.yaml"), "up", "-d"]);
        const idOf = async (service: string) => (await dockerOk(["ps", "-q", "--no-trunc", "--filter", "label=com.docker.compose.project=cp-qa-self", "--filter", `label=com.docker.compose.service=${service}`])).trim();
        const oldPanel = await idOf("panel");
        const other = await idOf("other");

        // A new image behind the same tag, as after a pull.
        await dockerOk(["container", "create", "--name", "cp-qa-self-src", IMAGE]);
        await dockerOk(["commit", "--change", "LABEL org.opencontainers.image.version=9.9.9", "cp-qa-self-src", "cp-qa-self:current"]);
        await dockerOk(["container", "rm", "cp-qa-self-src"]);
        const target = JSON.parse((await dockerOk(["image", "inspect", "--format", "{{json .Id}}", "cp-qa-self:current"])).trim()) as string;

        const support = parseSelfInspect(await dockerOk(["container", "inspect", oldPanel]), oldPanel);
        if (support.kind !== "ready") throw new Error(support.reason);
        expect(support.identity.workingDir).toBe(dir);

        const runner = createDockerRunner({ timeoutMs: 60_000 });
        const deps = {
            runner,
            provider: createComposeProvider({ runner }),
            log: () => {},
            write: () => {},
            fileExists: (path: string) => Bun.file(path).exists(),
            sleep: (ms: number) => Bun.sleep(ms),
            now: () => Date.now(),
            pollMs: 500,
            readyTimeoutMs: 60_000,
        };
        // A target the tag no longer points to is refused before anything changes.
        const stale = parseUpdaterArgs(updaterCommand(support.identity, support.identity.imageId));
        expect(await runSelfUpdate(stale, deps)).toBe(UPDATER_EXIT.refused);
        expect(await idOf("panel")).toBe(oldPanel);

        expect(await runSelfUpdate(parseUpdaterArgs(updaterCommand(support.identity, target)), deps)).toBe(UPDATER_EXIT.updated);
        const newPanel = await idOf("panel");
        expect(newPanel).not.toBe(oldPanel);
        expect(JSON.parse((await dockerOk(["container", "inspect", "--format", "{{json .Image}}", newPanel])).trim())).toBe(target);
        expect(await idOf("other")).toBe(other);
    }, 120_000);

    test("scoped restart/up, start and filtered logs against real Compose (ADR 0019-0021)", async () => {
        const p = panel!;
        const compose = (args: string[]) => dockerOk(["compose", "-p", "cp-qa-scoped", ...args]);
        expect((await p.action("scoped", "up")).status).toBe(303);
        expect(await p.operationResult("scoped", 60_000)).toBe("succeeded");
        expect(await runningServices("cp-qa-scoped")).toEqual(["db", "web", "worker"]);

        // Start (ADR 0019): stopped containers come back without recreation.
        expect((await p.action("scoped", "stop")).status).toBe(303);
        expect(await p.operationResult("scoped", 60_000)).toBe("succeeded");
        expect(await runningServices("cp-qa-scoped")).toEqual([]);
        expect((await p.action("scoped", "start")).status).toBe(303);
        expect(await p.operationResult("scoped", 60_000)).toBe("succeeded");
        expect(await runningServices("cp-qa-scoped")).toEqual(["db", "web", "worker"]);

        // Scoped restart (ADR 0021): `--no-deps` leaves the dependent stopped.
        await compose(["stop", "worker"]);
        expect(await runningServices("cp-qa-scoped")).toEqual(["db", "web"]);
        expect((await p.action("scoped", "restart", { service: "db" })).status).toBe(303);
        expect(await p.operationResult("scoped", 60_000)).toBe("succeeded");
        expect(await runningServices("cp-qa-scoped")).toEqual(["db", "web"]);

        // Scoped up (ADR 0021): the dependency is not started implicitly.
        await compose(["stop", "web", "db"]);
        expect(await runningServices("cp-qa-scoped")).toEqual([]);
        expect((await p.action("scoped", "up", { service: "web" })).status).toBe(303);
        expect(await p.operationResult("scoped", 60_000)).toBe("succeeded");
        expect(await runningServices("cp-qa-scoped")).toEqual(["web"]);

        // Filtered one-shot logs (ADR 0020): the `--` separator works here.
        const logs = await p.get("/stacks/scoped/logs?service=web&tail=100");
        expect(logs.status).toBe(200);
        expect(logs.headers.get("content-type")).toContain("text/plain");

        // Discovery and refusals through the real CLI. Order is Compose's own;
        // the panel only needs exact membership.
        const runner = createDockerRunner({ timeoutMs: 60_000 });
        const provider = createComposeProvider({ runner });
        const dir = join(stacks, "scoped");
        const discovered = await provider.listServices({ project: "cp-qa-scoped", composeFile: join(dir, "compose.yaml"), cwd: dir });
        expect([...discovered ?? []].sort()).toEqual(["db", "web", "worker"]);
        expect((await p.action("scoped", "restart", { service: "missing" })).status).toBe(409);
        expect((await p.action("scoped", "down", { service: "web" })).status).toBe(400);
        expect(await runningServices("cp-qa-scoped")).toEqual(["web"]);
    }, 180_000);

    test("pull skips locally built services, including image + build (ADR 0022)", async () => {
        const p = panel!;
        expect((await p.action("pullable", "pull")).status).toBe(303);
        expect(await p.operationResult("pullable", 120_000)).toBe("succeeded");
        // The image+build service was skipped, not downloaded: its tag is
        // still absent (a plain pull would fail on it).
        expect((await docker(["image", "inspect", "cp-qa-pull-both:local"])).code).not.toBe(0);
        // Up then builds the local images and starts everything.
        expect((await p.action("pullable", "up")).status).toBe(303);
        expect(await p.operationResult("pullable", 180_000)).toBe("succeeded");
        expect(await runningServices("cp-qa-pull")).toEqual(["both", "local", "remote"]);
    }, 300_000);

    test("SIGTERM refuses new actions, drains the running one within the grace period and keeps containers", async () => {
        const p = panel!;
        const accepted = await p.action("delayed", "up");
        expect(accepted.status).toBe(303);
        await waitFor(async () => (await stat(marker).catch(() => null)) !== null, 30_000, "the delayed up to start");

        const signalled = Date.now();
        p.proc.kill("SIGTERM");
        await waitFor(() => p.output.includes("SIGTERM received"), 5_000, "the panel to log the signal");
        // A new mutation during the drain is refused before anything runs.
        const refused = await p.action("unique", "restart");
        expect(refused.status).toBe(409);
        expect(await refused.text()).toContain("shutting down");

        const code = await p.proc.exited;
        const elapsed = Date.now() - signalled;
        expect(code).toBe(0);
        // The accepted operation finished inside the grace period, not at its end.
        expect(elapsed).toBeLessThan(GRACE_MS);
        expect(elapsed).toBeGreaterThan(1_000);
        expect(await runningServices("cp-qa-delayed")).toEqual(["app"]);
        // The panel stopped; the containers it started did not.
        expect(await runningServices("cp-qa-unique")).toEqual(["app"]);
        expect(await runningServices("cp-qa-shared")).toEqual(["witness"]);
    }, 60_000);
});
