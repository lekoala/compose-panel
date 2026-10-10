import { describe, expect, test } from "bun:test";
import { createComposeProvider } from "../src/compose-provider.ts";
import type { CommandResult, DockerRunner } from "../src/docker.ts";

const ok: CommandResult = { code: 0, stdout: "", stderr: "", timedOut: false, truncated: false };

function recording(result: CommandResult = ok) {
    const calls: { args: string[]; cwd?: string }[] = [];
    const runner: DockerRunner = async (args, options) => { calls.push({ args, cwd: options?.cwd }); return result; };
    return { runner, calls };
}

describe("createComposeProvider", () => {
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
        const { runner, calls } = recording({ ...ok, stdout: '{"name":"from-env","services":{"app":{"environment":{"TOKEN":"private"}}}}' });
        expect(await createComposeProvider({ runner }).projectName({ composeFile: "/opt/demo/compose.yaml", cwd: "/opt/demo" })).toBe("from-env");
        expect(calls[0]!.args).toEqual(["compose", "--project-directory", "/opt/demo", "-f", "/opt/demo/compose.yaml", "config", "--format", "json"]);
        for (const result of [
            { ...ok, stdout: "not JSON" }, { ...ok, stdout: '{"name":""}' },
            { ...ok, stdout: '{"name":"valid"}', truncated: true },
            { ...ok, stdout: '{"name":"valid"}', timedOut: true },
            { ...ok, code: 1, stderr: "secret" },
        ]) {
            expect(await createComposeProvider({ runner: async () => result }).projectName({ composeFile: "compose.yaml", cwd: "/opt/demo" })).toBeNull();
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
        expect(calls[1]!.args).toEqual(["compose", "-p", "demo", "-f", "compose.yaml", "ps", "--all", "--format", "json"]);
        expect(calls[1]!.cwd).toBe("/opt/stacks/demo");

        await provider.validateConfig({ directory: "/opt/stacks/demo", composeFile: "compose.yaml" });
        expect(calls[2]!.args).toEqual([
            "compose", "--project-directory", "/opt/stacks/demo", "-f", "compose.yaml", "config", "--quiet",
        ]);

        await provider.validateConfig({ directory: "/opt/stacks/demo", composeFile: "draft.yaml", envFile: "draft.env" });
        expect(calls[3]!.args).toEqual([
            "compose", "--env-file", "draft.env", "--project-directory", "/opt/stacks/demo", "-f", "draft.yaml", "config", "--quiet",
        ]);
    });

    test("reads a bounded log snapshot with explicit arguments", async () => {
        const { runner, calls } = recording();
        const provider = createComposeProvider({ runner });
        await provider.readLogs({ project: "demo", composeFile: "compose.yaml", cwd: "/opt/stacks/demo", envFile: "/opt/stacks/demo/.env", tailLines: 50 });
        expect(calls[0]!.args).toEqual([
            "compose", "-p", "demo", "--env-file", "/opt/stacks/demo/.env",
            "--project-directory", "/opt/stacks/demo", "-f", "compose.yaml",
            "logs", "--tail", "50", "--timestamps", "--no-color",
        ]);
        expect(calls[0]!.cwd).toBe("/opt/stacks/demo");
    });

    test("refuses a log read when the provider has no logs capability", async () => {
        const { runner } = recording();
        const provider = createComposeProvider({ runner });
        (provider.capabilities().operations as { logs: boolean }).logs = false;
        await expect(provider.readLogs({ composeFile: "compose.yaml", cwd: "/opt/stacks/demo" })).rejects.toThrow(/does not support/);
    });
});
