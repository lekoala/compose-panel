import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createComposeProvider } from "../src/compose-provider.ts";
import { createDockerRunner } from "../src/docker.ts";
import { resolveProjectContext } from "../src/status.ts";

// Real Compose CLI, config only. Discovery is a fixture; no command is allowed
// to connect to a daemon or create/change Docker resources. Opt in explicitly.
// The test makes six sequential Compose calls, each bounded by the runner's own
// 5 s timeout, so Bun's default 5 s per-test limit is too short by design.
const TEST_TIMEOUT_MS = 40_000;
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
