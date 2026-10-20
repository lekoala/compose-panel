import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createComposeProvider } from "../src/compose-provider.ts";
import { createDockerRunner } from "../src/docker.ts";
import { resolveProjectContext } from "../src/status.ts";
import { createStack } from "../src/create-stack.ts";

// Real Compose CLI, config only. Discovery is a fixture; no command is allowed
// to connect to a daemon or create/change Docker resources. Opt in explicitly.
// The test makes six sequential Compose calls, each bounded by the runner's own
// 5 s timeout, so Bun's default 5 s per-test limit is too short by design.
const TEST_TIMEOUT_MS = 40_000;
test.skipIf(process.platform !== "linux" || process.env.COMPOSE_PANEL_TEST_COMPOSE_CONFIG !== "1")("production deployment preserves hashes and mounts without publishing ports or building", async () => {
    const root = await mkdtemp(join(tmpdir(), "cp-prod-config-"));
    const hash = "$argon2id$v=19$m=65536,t=3,p=1$c2FsdA$aGFzaA";
    try {
        const file = join(root, "compose.prod.yaml");
        await writeFile(file, await Bun.file(new URL("../deploy/compose.prod.yaml", import.meta.url)).text());
        await writeFile(join(root, "compose-panel.env"), `COMPOSE_PANEL_ADMIN_USER=operator42\nCOMPOSE_PANEL_ADMIN_PASSWORD_HASH='${hash}'\n`);
        // Config does not contact Docker; an invalid host also prevents accidental access.
        const proc = Bun.spawn(["docker", "compose", "-p", "compose-panel", "--project-directory", root,
            "-f", file, "config", "--format", "json"], {
            env: { PATH: process.env.PATH, HOME: process.env.HOME,
                COMPOSE_DISABLE_ENV_FILE: "true", DOCKER_HOST: "unix:///nonexistent-cp-test.sock" },
            stdout: "pipe", stderr: "pipe",
        });
        const [output, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
        expect(code).toBe(0);
        const config = JSON.parse(output);
        const panel = config.services.panel;
        expect(Object.keys(config.services)).toEqual(["panel"]);
        expect(config.name).toBe("compose-panel");
        expect(panel.image).toBe("ghcr.io/lekoala/compose-panel:latest");
        expect(panel.build).toBeUndefined();
        expect(panel.ports).toBeUndefined();
        expect(panel.network_mode).toBe("host");
        expect(panel.environment.COMPOSE_PANEL_ADMIN_PASSWORD_HASH).toBe(hash);
        expect(panel.environment.STACKS_DIR).toBe("/opt/stacks");
        expect(panel.volumes).toEqual(expect.arrayContaining([
            expect.objectContaining({ source: "/opt/stacks", target: "/opt/stacks", type: "bind" }),
            expect.objectContaining({ source: "/var/run/docker.sock", target: "/var/run/docker.sock", type: "bind" }),
            expect.objectContaining({ source: "/run/compose-panel", target: "/run/compose-panel", read_only: true }),
        ]));
    } finally { await rm(root, { recursive: true, force: true }); }
}, TEST_TIMEOUT_MS);

test.skipIf(process.platform !== "linux" || process.env.COMPOSE_PANEL_TEST_COMPOSE_CONFIG !== "1")("real Compose validates stack creation in its final directory without deployment", async () => {
    const root = await mkdtemp(join(tmpdir(), "cp-create-config-"));
    const runner = createDockerRunner();
    const provider = createComposeProvider({ runner: (args, options) => {
        if (args.includes("ls")) return Promise.resolve({ code: 0, stdout: "[]", stderr: "", timedOut: false, truncated: false });
        expect(args).toContain("config");
        return runner(args, options);
    } });
    try {
        const composeSource = '# raw draft\nname: ${STACK_ID}\nservices:\n  app:\n    image: busybox:latest\n    env_file: .env\n';
        const envSource = 'STACK_ID=cp-created-project\n';
        await createStack(root, { name: "created", composeSource, envSource }, provider, 10000);
        const cwd = join(root, "created");
        expect(await provider.projectName({ cwd, composeFile: join(cwd, "compose.yaml"), envFile: join(cwd, ".env") })).toBe("cp-created-project");
        // Without a supplied .env, relative env_file: .env must fail rather
        // than pass against a temporary .env that disappears after creation.
        await expect(createStack(root, { name: "no-env", composeSource: 'services:\n  app:\n    image: busybox:latest\n    env_file: .env\n', envSource: "" }, provider, 10000)).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
}, TEST_TIMEOUT_MS);

test.skipIf(process.platform !== "linux" || process.env.COMPOSE_PANEL_TEST_COMPOSE_CONFIG !== "1")("creation without .env checks the same project identity that later operations resolve", async () => {
    const root = await mkdtemp(join(tmpdir(), "cp-create-env-files-"));
    const previous = process.env.COMPOSE_ENV_FILES;
    const runner = createDockerRunner();
    let projects: unknown[] = [];
    const provider = createComposeProvider({ runner: (args, options) => {
        if (args.includes("ls")) return Promise.resolve({ code: 0, stdout: JSON.stringify(projects), stderr: "", timedOut: false, truncated: false });
        expect(args).toContain("config");
        return runner(args, options);
    } });
    try {
        // An interpolation source inherited by the panel process (ADR 0008).
        const global = join(root, "global.env");
        await writeFile(global, "REVIEW_PROJECT=from-global-env\n");
        process.env.COMPOSE_ENV_FILES = global;
        const stacks = join(root, "stacks");
        await mkdir(stacks);
        const composeSource = 'name: ${REVIEW_PROJECT:-fallback}\nservices:\n  app:\n    image: busybox:latest\n';
        projects = [{ Name: "from-global-env", Status: "running(1)", ConfigFiles: "/another/compose.yaml" }];
        await expect(createStack(stacks, { name: "taken", composeSource, envSource: "" }, provider, 10000)).rejects.toMatchObject({ status: 409 });
        projects = [];
        await createStack(stacks, { name: "created", composeSource, envSource: "" }, provider, 10000);
        const context = await resolveProjectContext(stacks, "created", provider, true);
        expect(context.envFile).toBeNull();
        expect(context.project).toBe("from-global-env");
    } finally {
        if (previous === undefined) delete process.env.COMPOSE_ENV_FILES;
        else process.env.COMPOSE_ENV_FILES = previous;
        await rm(root, { recursive: true, force: true });
    }
}, TEST_TIMEOUT_MS);

test.skipIf(process.platform !== "linux" || process.env.COMPOSE_PANEL_TEST_COMPOSE_CONFIG !== "1")("real Compose resolves environment/name precedence and rejects conflicting project ownership", async () => {
    const root = await mkdtemp(join(tmpdir(), "compose-panel-config-"));
    const cwd = join(root, "demo");
    const composeFile = join(cwd, "compose.yaml");
    const previous = process.env.COMPOSE_PROJECT_NAME;
    const runner = createDockerRunner();
    let projects: unknown[] = [];
    const provider = createComposeProvider({ runner: (args, options) => {
        if (args.includes("ls")) return Promise.resolve({ code: 0, stdout: JSON.stringify(projects), stderr: "", timedOut: false, truncated: false });
        expect(args).toContain("config");
        return runner(args, options);
    } });
    try {
        delete process.env.COMPOSE_PROJECT_NAME;
        await mkdir(cwd);
        await writeFile(composeFile, 'name: ${STACK_ID}\nservices:\n  app:\n    image: busybox:latest\n');
        await writeFile(join(cwd, ".env"), 'STACK_ID=yaml-stack\nCOMPOSE_PROJECT_NAME=env-stack\n');
        // Preflight: projectName() deliberately hides Compose output, so a
        // broken or slow Compose would only show up as null or a timeout. The
        // fixture holds no secret, so surface the real exit status here.
        const started = Date.now();
        const probe = await runner(["compose", "--project-directory", cwd, "-f", composeFile, "config", "--format", "json"], { cwd });
        if (probe.code !== 0 || probe.timedOut) {
            const version = await runner(["compose", "version"]);
            throw new Error(`docker compose config failed after ${Date.now() - started} ms: code=${probe.code} timedOut=${probe.timedOut} stderr=${probe.stderr.trim()} (${version.stdout.trim() || version.stderr.trim()})`);
        }
        expect(await provider.projectName({ cwd, composeFile })).toBe("env-stack");
        await writeFile(composeFile, 'name: ${STACK_ID}\nservices:\n  app:\n    image: busybox:latest\n    labels:\n      stack.version: ${STACK_ID}\n      private.secret: do-not-display\n');
        expect(await provider.stackMetadata({ project: "env-stack", cwd, composeFile, envFile: join(cwd, ".env") })).toEqual({ app: { "stack.version": "yaml-stack" } });
        projects = [{ Name: "env-stack", Status: "running(1)", ConfigFiles: "/another/compose.yaml" }];
        expect((await resolveProjectContext(root, "demo", provider, true)).kind).toBe("ambiguous");
        projects = [];
        expect((await resolveProjectContext(root, "demo", provider, true)).project).toBe("env-stack");
        process.env.COMPOSE_PROJECT_NAME = "process-stack";
        expect(await provider.projectName({ cwd, composeFile })).toBe("process-stack");
        delete process.env.COMPOSE_PROJECT_NAME;
        await writeFile(join(cwd, ".env"), 'STACK_ID=yaml-stack\n');
        expect(await provider.projectName({ cwd, composeFile })).toBe("yaml-stack");
        await writeFile(composeFile, 'services:\n  app:\n    image: busybox:latest\n');
        expect(await provider.projectName({ cwd, composeFile })).toBe("demo");
    } finally {
        if (previous === undefined) delete process.env.COMPOSE_PROJECT_NAME;
        else process.env.COMPOSE_PROJECT_NAME = previous;
        await rm(root, { recursive: true, force: true });
    }
}, TEST_TIMEOUT_MS);
