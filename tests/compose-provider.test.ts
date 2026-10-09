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
});
