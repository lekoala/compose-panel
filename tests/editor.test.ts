import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hashContent } from "../src/fs-safe.ts";
import {
    StackConflictError,
    StackValidationError,
    collectSecrets,
    readEditableStack,
    redactSecrets,
    saveEditableStack,
    type SaveRequest,
} from "../src/editor.ts";
import type { CommandResult, DockerRunner } from "../src/docker.ts";

const MAX = 1024 * 1024;
const COMPOSE = "services:\n  app:\n    image: nginx:alpine\n# keep this comment\n";
const ENV = "DB_PASSWORD=supersecretvalue\n# keep env comment\n";
const okResult: CommandResult = { code: 0, stdout: "", stderr: "", timedOut: false, truncated: false };
const okRunner: DockerRunner = async () => okResult;

let root: string;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "compose-panel-editor-"));
    await mkdir(join(root, "demo"));
    await writeFile(join(root, "demo", "compose.yaml"), COMPOSE);
    await writeFile(join(root, "demo", ".env"), ENV);
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

async function current() {
    return readEditableStack(root, "demo", MAX);
}

function req(stack: Awaited<ReturnType<typeof current>>, overrides: Partial<SaveRequest> = {}): SaveRequest {
    return {
        composeSource: stack.composeSource,
        envSource: stack.envSource,
        baseComposeHash: stack.composeHash,
        baseEnvHash: stack.envHash,
        baseEnvExists: stack.envExists,
        ...overrides,
    };
}

function recordingRunner(result: CommandResult = okResult) {
    const calls: string[][] = [];
    const runner: DockerRunner = async args => { calls.push(args); return result; };
    return { runner, calls };
}

describe("readEditableStack", () => {
    test("returns raw content and hashes without round-tripping", async () => {
        const stack = await current();
        expect(stack.composeSource).toBe(COMPOSE);
        expect(stack.envSource).toBe(ENV);
        expect(stack.composeHash).toBe(hashContent(COMPOSE));
        expect(stack.envHash).toBe(hashContent(ENV));
        expect(stack.envExists).toBe(true);
    });

    test("reports a missing .env", async () => {
        await rm(join(root, "demo", ".env"));
        const stack = await current();
        expect(stack.envExists).toBe(false);
        expect(stack.envSource).toBe("");
    });
});

describe("secret handling", () => {
    test("collects and redacts .env values", () => {
        const secrets = collectSecrets(ENV);
        expect(secrets).toContain("supersecretvalue");
        expect(redactSecrets("error near supersecretvalue here", secrets)).toBe("error near *** here");
    });
});

describe("saveEditableStack", () => {
    test("validates in context and writes changed files with a backup", async () => {
        const { runner, calls } = recordingRunner();
        const stack = await current();
        const nextCompose = COMPOSE.replace("nginx:alpine", "nginx:1.27-alpine");

        const result = await saveEditableStack(root, "demo", req(stack, { composeSource: nextCompose }), runner, MAX);

        expect(result.changed).toBe(true);
        expect(await readFile(join(root, "demo", "compose.yaml"), "utf8")).toBe(nextCompose);
        // The draft is validated with an explicit -f and --project-directory.
        const args = calls[0]!;
        expect(args).toContain("config");
        expect(args).toContain("--quiet");
        expect(args).toContain("--project-directory");
        expect(args).toContain("-f");
        const backups = await readdir(join(root, ".compose-panel", "backups", "demo"));
        expect(backups.length).toBeGreaterThan(0);
    });

    test("passes the draft .env through --env-file", async () => {
        const { runner, calls } = recordingRunner();
        const stack = await current();
        await saveEditableStack(root, "demo", req(stack, { envSource: "DB_PASSWORD=changedvalue\n" }), runner, MAX);
        expect(calls[0]!).toContain("--env-file");
        expect(await readFile(join(root, "demo", ".env"), "utf8")).toBe("DB_PASSWORD=changedvalue\n");
    });

    test("is a no-op when nothing changed", async () => {
        const stack = await current();
        const result = await saveEditableStack(root, "demo", req(stack), okRunner, MAX);
        expect(result.changed).toBe(false);
        expect(await readFile(join(root, "demo", "compose.yaml"), "utf8")).toBe(COMPOSE);
    });

    test("refuses to overwrite an external change", async () => {
        const stack = await current();
        await writeFile(join(root, "demo", "compose.yaml"), "services: {}\n");
        await expect(saveEditableStack(root, "demo", req(stack, { composeSource: "services:\n  app:\n    image: x\n" }), okRunner, MAX))
            .rejects.toThrow(StackConflictError);
        expect(await readFile(join(root, "demo", "compose.yaml"), "utf8")).toBe("services: {}\n");
    });

    test("does not publish an invalid draft", async () => {
        const failing: DockerRunner = async () => ({ code: 1, stdout: "", stderr: "services.app.ports must be a list", timedOut: false, truncated: false });
        const stack = await current();
        await expect(saveEditableStack(root, "demo", req(stack, { composeSource: "services: {}\n" }), failing, MAX))
            .rejects.toThrow(StackValidationError);
        expect(await readFile(join(root, "demo", "compose.yaml"), "utf8")).toBe(COMPOSE);
    });

    test("does not write when Docker is unavailable", async () => {
        const unavailable: DockerRunner = async () => ({ code: -1, stdout: "", stderr: "", timedOut: false, truncated: false });
        const stack = await current();
        await expect(saveEditableStack(root, "demo", req(stack, { composeSource: "services: {}\n" }), unavailable, MAX))
            .rejects.toThrow(StackValidationError);
        expect(await readFile(join(root, "demo", "compose.yaml"), "utf8")).toBe(COMPOSE);
    });

    test("redacts .env values from validation errors", async () => {
        const leaking: DockerRunner = async () => ({
            code: 1,
            stdout: "",
            stderr: "error using value supersecretvalue for service app",
            timedOut: false,
            truncated: false,
        });
        const stack = await current();
        try {
            await saveEditableStack(root, "demo", req(stack, { composeSource: "services: {}\n" }), leaking, MAX);
            throw new Error("expected validation to fail");
        } catch (error) {
            expect(error).toBeInstanceOf(StackValidationError);
            expect((error as Error).message).toContain("***");
            expect((error as Error).message).not.toContain("supersecretvalue");
        }
    });

    test("creates a new .env when it did not exist", async () => {
        await rm(join(root, "demo", ".env"));
        const stack = await current();
        const request = req(stack, { envSource: "TOKEN=abcdefgh\n" });
        const result = await saveEditableStack(root, "demo", request, okRunner, MAX);
        expect(result.changed).toBe(true);
        expect(result.envExists).toBe(true);
        expect(await readFile(join(root, "demo", ".env"), "utf8")).toBe("TOKEN=abcdefgh\n");
    });

    test.skipIf(process.platform === "win32")("refuses a symlinked .env", async () => {
        const outside = await mkdtemp(join(tmpdir(), "compose-panel-outside-"));
        await writeFile(join(outside, "secret.env"), "SECRET=12345678\n");
        await rm(join(root, "demo", ".env"));
        await symlink(join(outside, "secret.env"), join(root, "demo", ".env"));
        await expect(current()).rejects.toThrow();
        await rm(outside, { recursive: true, force: true });
    });
});
