import { describe, expect, test } from "bun:test";
import { createComposeProvider } from "../src/compose-provider.ts";
import type { CommandResult, DockerRunner } from "../src/docker.ts";

const ok: CommandResult = { code: 0, stdout: "", stderr: "", timedOut: false, truncated: false };

function recording(result: CommandResult = ok) {
    const calls: { args: string[]; cwd?: string }[] = [];
    const runner: DockerRunner = async (args, options) => {
        calls.push({ args, cwd: options?.cwd });
        return result;
    };
    return { runner, calls };
}

describe("createComposeProvider", () => {
    test("ps and images carry the verified env file and explicit project directory", async () => {
        const calls: { args: string[]; options?: Parameters<DockerRunner>[1] }[] = [];
        const provider = createComposeProvider({
            runner: async (args, options) => {
                calls.push({ args, options });
                return ok;
            },
        });
        const base = { project: "real-project", composeFile: "/opt/demo/compose.yaml", cwd: "/opt/demo" };
        for (const method of [provider.projectServices.bind(provider), provider.projectImages.bind(provider)]) {
            await method({ ...base, envFile: "/opt/demo/.env" });
            await method(base);
        }
        for (const index of [0, 2]) {
            expect(calls[index]!.args.slice(0, 9)).toEqual([
                "compose",
                "-p",
                "real-project",
                "--env-file",
                "/opt/demo/.env",
                "--project-directory",
                "/opt/demo",
                "-f",
                "/opt/demo/compose.yaml",
            ]);
        }
        for (const index of [1, 3]) {
            expect(calls[index]!.options?.env?.COMPOSE_DISABLE_ENV_FILE).toBe("true");
            expect(calls[index]!.args).not.toContain("--env-file");
        }
    });
    test("builds the Docker provider by default", () => {
        const { runner } = recording();
        expect(createComposeProvider({ runner }).engine).toBe("docker");
    });

    test("refuses Podman explicitly for now", () => {
        const { runner } = recording();
        expect(() => createComposeProvider({ runner, engine: "podman" })).toThrow(/not implemented/);
    });

    test("refuses an unknown engine", () => {
        const { runner } = recording();
        expect(() => createComposeProvider({ runner, engine: "containerd" })).toThrow(/Unknown Compose engine/);
    });
});

describe("DockerComposeProvider", () => {
    test("extracts only the effective project identity and rejects unreliable output", async () => {
        const { runner, calls } = recording({
            ...ok,
            stdout: '{"name":"from-env","services":{"app":{"environment":{"TOKEN":"private"}}}}',
        });
        expect(await createComposeProvider({ runner }).projectName({ composeFile: "/opt/demo/compose.yaml", cwd: "/opt/demo" })).toBe(
            "from-env",
        );
        expect(calls[0]!.args).toEqual([
            "compose",
            "--project-directory",
            "/opt/demo",
            "-f",
            "/opt/demo/compose.yaml",
            "config",
            "--format",
            "json",
        ]);
        for (const result of [
            { ...ok, stdout: "not JSON" },
            { ...ok, stdout: '{"name":""}' },
            { ...ok, stdout: '{"name":"valid"}', truncated: true },
            { ...ok, stdout: '{"name":"valid"}', timedOut: true },
            { ...ok, code: 1, stderr: "secret" },
        ]) {
            expect(
                await createComposeProvider({ runner: async () => result }).projectName({ composeFile: "compose.yaml", cwd: "/opt/demo" }),
            ).toBeNull();
        }
    });
    test("detects availability", async () => {
        const { runner } = recording(ok);
        const provider = createComposeProvider({ runner });
        expect((await provider.detect()).available).toBe(true);
    });

    test("reports unavailable when the probe fails", async () => {
        const { runner } = recording({ ...ok, code: 1 });
        const provider = createComposeProvider({ runner });
        expect((await provider.detect()).available).toBe(false);
    });

    test("issues the expected argument arrays", async () => {
        const { runner, calls } = recording();
        const provider = createComposeProvider({ runner });

        await provider.listProjects();
        expect(calls[0]!.args).toEqual(["compose", "ls", "--all", "--format", "json"]);

        await provider.projectServices({ project: "demo", composeFile: "compose.yaml", cwd: "/opt/stacks/demo" });
        expect(calls[1]!.args).toEqual([
            "compose",
            "-p",
            "demo",
            "--project-directory",
            "/opt/stacks/demo",
            "-f",
            "compose.yaml",
            "ps",
            "--all",
            "--format",
            "json",
        ]);
        expect(calls[1]!.cwd).toBe("/opt/stacks/demo");

        await provider.validateConfig({ directory: "/opt/stacks/demo", composeFile: "compose.yaml" });
        expect(calls[2]!.args).toEqual(["compose", "--project-directory", "/opt/stacks/demo", "-f", "compose.yaml", "config", "--quiet"]);

        await provider.validateConfig({ directory: "/opt/stacks/demo", composeFile: "draft.yaml", envFile: "draft.env" });
        expect(calls[3]!.args).toEqual([
            "compose",
            "--env-file",
            "draft.env",
            "--project-directory",
            "/opt/stacks/demo",
            "-f",
            "draft.yaml",
            "config",
            "--quiet",
        ]);
    });

    test("reads a bounded log snapshot with explicit arguments", async () => {
        const { runner, calls } = recording();
        const provider = createComposeProvider({ runner });
        await provider.readLogs({
            project: "demo",
            composeFile: "compose.yaml",
            cwd: "/opt/stacks/demo",
            envFile: "/opt/stacks/demo/.env",
            tailLines: 50,
        });
        expect(calls[0]!.args).toEqual([
            "compose",
            "-p",
            "demo",
            "--env-file",
            "/opt/stacks/demo/.env",
            "--project-directory",
            "/opt/stacks/demo",
            "-f",
            "compose.yaml",
            "logs",
            "--tail",
            "50",
            "--timestamps",
            "--no-color",
        ]);
        expect(calls[0]!.cwd).toBe("/opt/stacks/demo");
    });

    test("clamps an absurd log tail instead of passing it to Docker", async () => {
        const { runner, calls } = recording();
        const provider = createComposeProvider({ runner });
        const base = { composeFile: "compose.yaml", cwd: "/opt/stacks/demo" };
        await provider.readLogs({ ...base, tailLines: 1_000_000_000 });
        await provider.readLogs({ ...base, tailLines: -5 });
        await provider.readLogs({ ...base, tailLines: Number.NaN });
        await provider.readLogs({ ...base });
        const tails = calls.map((call) => call.args[call.args.indexOf("--tail") + 1]);
        expect(tails).toEqual(["5000", "1", "200", "200"]);
    });

    test("refuses a log read when the provider has no logs capability", async () => {
        const { runner } = recording();
        const provider = createComposeProvider({ runner });
        (provider.capabilities().operations as { logs: boolean }).logs = false;
        await expect(provider.readLogs({ composeFile: "compose.yaml", cwd: "/opt/stacks/demo" })).rejects.toThrow(/does not support/);
    });

    test("lists service names from the effective config, or nothing usable", async () => {
        const { runner, calls } = recording({ ...ok, stdout: "web\ndb\nweb\n" });
        const provider = createComposeProvider({ runner });
        const base = { project: "demo", composeFile: "compose.yaml", cwd: "/opt/stacks/demo", envFile: "/opt/stacks/demo/.env" };
        expect(await provider.listServices(base)).toEqual(["web", "db"]);
        expect(calls[0]!.args).toEqual([
            "compose",
            "-p",
            "demo",
            "--env-file",
            "/opt/stacks/demo/.env",
            "--project-directory",
            "/opt/stacks/demo",
            "-f",
            "compose.yaml",
            "config",
            "--services",
        ]);
        expect(calls[0]!.cwd).toBe("/opt/stacks/demo");
        for (const result of [
            { ...ok, stdout: "web\n--privileged\n" },
            { ...ok, stdout: "web\n../evil\n" },
            { ...ok, stdout: "web", truncated: true },
            { ...ok, stdout: "web", timedOut: true },
            { ...ok, code: 1, stderr: "nope" },
        ]) {
            expect(await createComposeProvider({ runner: async () => result }).listServices(base)).toBeNull();
        }
    });

    test("scopes up and restart to one service without touching dependents", async () => {
        const { runner, calls } = recording();
        const provider = createComposeProvider({ runner });
        const base = { composeFile: "compose.yaml", cwd: "/opt/stacks/demo" };
        await provider.restart({ ...base, service: "web" });
        expect(calls[0]!.args).toEqual([
            "compose",
            "--project-directory",
            "/opt/stacks/demo",
            "-f",
            "compose.yaml",
            "restart",
            "--no-deps",
            "--",
            "web",
        ]);
        await provider.up({ project: "demo", ...base, service: "web" });
        expect(calls[1]!.args).toEqual([
            "compose",
            "-p",
            "demo",
            "--project-directory",
            "/opt/stacks/demo",
            "-f",
            "compose.yaml",
            "up",
            "-d",
            "--no-deps",
            "--",
            "web",
        ]);
        // Stack-wide commands are unchanged: no --no-deps without a service.
        await provider.restart(base);
        expect(calls[2]!.args).toContain("restart");
        expect(calls[2]!.args).not.toContain("--no-deps");
        await provider.up(base);
        expect(calls[3]!.args.slice(-2)).toEqual(["up", "-d"]);
        await expect(provider.restart({ ...base, service: "-f" })).rejects.toThrow(/Invalid service name/);
        await expect(provider.up({ ...base, service: "" })).rejects.toThrow(/Invalid service name/);
    });

    test("pull skips locally built services (ADR 0022)", async () => {
        const { runner, calls } = recording();
        const provider = createComposeProvider({ runner });
        await provider.pull({ project: "demo", composeFile: "compose.yaml", cwd: "/opt/stacks/demo" });
        expect(calls[0]!.args).toEqual([
            "compose",
            "-p",
            "demo",
            "--project-directory",
            "/opt/stacks/demo",
            "-f",
            "compose.yaml",
            "pull",
            "--ignore-buildable",
        ]);
    });

    test("pull and up compact repeated layer progress in live output (ADR 0034)", async () => {
        const provider = createComposeProvider({
            runner: async (_args, options) => {
                options?.onChunk?.(" 7801f5cb2c57 Downloading 1MB\n 7801f5cb2c57 Downloading 2MB\n");
                options?.onChunk?.(" 7801f5cb2c57 Pull complete");
                return ok;
            },
        });
        const base = { project: "demo", composeFile: "compose.yaml", cwd: "/opt/stacks/demo" };
        for (const call of [provider.pull.bind(provider), provider.up.bind(provider)]) {
            const chunks: string[] = [];
            await call({ ...base, onOutput: (chunk) => chunks.push(chunk) });
            expect(chunks.join("")).toBe(" 7801f5cb2c57 Downloading 1MB\n 7801f5cb2c57 Pull complete");
        }
    });

    test("scopes log reads to a validated service after `--`", async () => {
        const { runner, calls } = recording();
        const provider = createComposeProvider({ runner });
        await provider.readLogs({ composeFile: "compose.yaml", cwd: "/opt/stacks/demo", tailLines: 500, service: "web" });
        expect(calls[0]!.args).toEqual([
            "compose",
            "--project-directory",
            "/opt/stacks/demo",
            "-f",
            "compose.yaml",
            "logs",
            "--tail",
            "500",
            "--timestamps",
            "--no-color",
            "--",
            "web",
        ]);
        await expect(provider.readLogs({ composeFile: "compose.yaml", cwd: "/opt/stacks/demo", service: "--privileged" })).rejects.toThrow(
            /Invalid service name/,
        );
        await expect(provider.readLogs({ composeFile: "compose.yaml", cwd: "/opt/stacks/demo", service: "" })).rejects.toThrow(
            /Invalid service name/,
        );
    });
});

describe("rollout support", () => {
    const target = { project: "demo", composeFile: "/opt/stacks/demo/compose.yaml", cwd: "/opt/stacks/demo" };
    const configJson = JSON.stringify({
        services: {
            web: {
                image: "ghcr.io/example/app:1.2.3",
                labels: {
                    "panel.rollout.enabled": "true",
                    "panel.rollout.timeout": "60",
                    "stack.version": "1.2.3",
                    "com.example.secret": "do-not-keep",
                },
            },
            sidecar: { image: "sidecar:1", network_mode: "service:web" },
            db: {
                image: "postgres:16",
                scale: 1,
                build: { context: "." },
                ports: ["5432:5432"],
                networks: { back: { ipv4_address: "10.0.0.5" }, plain: null, unset: { ipv6_address: null } },
            },
        },
    });

    test("projects only allow-listed rollout facts", async () => {
        const { runner, calls } = recording({ ...ok, stdout: configJson });
        const provider = createComposeProvider({ runner });
        const facts = await provider.serviceRolloutFacts(target);
        expect(facts).not.toBeNull();
        expect(calls[0]!.args).toEqual([
            "compose",
            "-p",
            "demo",
            "--project-directory",
            "/opt/stacks/demo",
            "-f",
            "/opt/stacks/demo/compose.yaml",
            "config",
            "--format",
            "json",
        ]);
        const web = facts!.get("web")!;
        expect(web.labels).toEqual({ enabled: "true", timeout: "60" });
        expect(web.namespaceDependents).toEqual(["sidecar"]);
        const db = facts!.get("db")!;
        expect(db.build).toBe(true);
        expect(db.publishedPorts).toBe(true);
        expect(db.replicas).toEqual([1]);
        expect(db.fixedAddresses).toEqual(["back"]);
        expect(JSON.stringify([...facts!.entries()])).not.toContain("do-not-keep");
    });

    test("refuses unusable config answers", async () => {
        for (const result of [
            { ...ok, stdout: "not json" },
            { ...ok, stdout: '{"services":[]}' },
            { ...ok, stdout: '{"services":{"web":null}}' },
            { ...ok, stdout: configJson, truncated: true },
            { ...ok, code: 1, stderr: "secret" },
        ]) {
            const { runner } = recording(result);
            expect(await createComposeProvider({ runner }).serviceRolloutFacts(target)).toBeNull();
        }
    });

    test("lists every container of a service, in any state", async () => {
        const { runner, calls } = recording({ ...ok, stdout: "abc123def456\nabc123def456\n" });
        const provider = createComposeProvider({ runner });
        expect(await provider.serviceContainerIds({ ...target, service: "web" })).toEqual(["abc123def456"]);
        expect(calls[0]!.args).toEqual(["compose", "-p", "demo", "-f", "/opt/stacks/demo/compose.yaml", "ps", "-a", "-q", "web"]);
        for (const result of [
            { ...ok, stdout: "not-an-id\n" },
            { ...ok, stdout: "abc", code: 1 },
            { ...ok, stdout: "abc", timedOut: true },
        ]) {
            const { runner: bad } = recording(result);
            expect(await createComposeProvider({ runner: bad }).serviceContainerIds({ ...target, service: "web" })).toBeNull();
        }
    });

    test("pullService and scaleService build explicit argument arrays", async () => {
        const { runner, calls } = recording();
        const provider = createComposeProvider({ runner });
        await provider.pullService({ ...target, service: "web" });
        expect(calls[0]!.args).toEqual([
            "compose",
            "-p",
            "demo",
            "--project-directory",
            "/opt/stacks/demo",
            "-f",
            "/opt/stacks/demo/compose.yaml",
            "pull",
            "--ignore-buildable",
            "--",
            "web",
        ]);
        await provider.scaleService({ ...target, service: "web", replicas: 2 });
        expect(calls[1]!.args).toEqual([
            "compose",
            "-p",
            "demo",
            "--project-directory",
            "/opt/stacks/demo",
            "-f",
            "/opt/stacks/demo/compose.yaml",
            "up",
            "-d",
            "--no-deps",
            "--no-recreate",
            "--no-build",
            "--pull",
            "never",
            "--scale",
            "web=2",
            "--",
            "web",
        ]);
        await expect(provider.pullService({ ...target, service: "--privileged" })).rejects.toThrow(/Invalid service name/);
        await expect(provider.scaleService({ ...target, service: "web", replicas: 0 })).rejects.toThrow(/Invalid replica count/);
    });
});
