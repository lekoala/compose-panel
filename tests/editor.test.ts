import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileSafetyError, hashContent, writeFileAtomic } from "../src/fs-safe.ts";
import {
    StackConflictError,
    StackPartialError,
    StackValidationError,
    collectSecrets,
    readEditableStack,
    redactSecrets,
    saveEditableStack,
    type SaveRequest,
} from "../src/editor.ts";
import { StackError } from "../src/stacks.ts";
import type { CommandResult, DockerRunner } from "../src/docker.ts";
import { createComposeProvider } from "../src/compose-provider.ts";

const MAX = 1024 * 1024;
const COMPOSE = "services:\n  app:\n    image: nginx:alpine\n# keep this comment\n";
const ENV = "DB_PASSWORD=supersecretvalue\n# keep env comment\n";
const okResult: CommandResult = { code: 0, stdout: "", stderr: "", timedOut: false, truncated: false };
const okRunner: DockerRunner = async () => okResult;
const asProvider = (runner: DockerRunner) => createComposeProvider({ runner });

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

    test("strips inline comments, quotes and export prefixes when collecting secrets", () => {
        const secrets = collectSecrets([
            "TOKEN=audit-secret # comment",
            'PASS="quoted # not a comment"',
            "SINGLE='literal value'",
            "export EXPORTED=exportvalue",
            "# comment line",
        ].join("\n"));
        expect(secrets).toContain("audit-secret");
        expect(secrets).toContain("quoted # not a comment");
        expect(secrets).toContain("literal value");
        expect(secrets).toContain("exportvalue");
        expect(secrets).not.toContain("audit-secret # comment");
    });

    test("handles an escaped quote inside a single-quoted value", () => {
        const secrets = collectSecrets("TOKEN='super\\'secret'\n");
        expect(secrets).toContain("super'secret");
        expect(redactSecrets("error super'secret here", secrets)).toBe("error *** here");
    });

    test("redacts before truncating so a boundary secret is not leaked as a prefix", async () => {
        const leaking: DockerRunner = async () => ({
            code: 1,
            stdout: "",
            stderr: `invalid ${"x".repeat(992)}supersecretvalue`,
            timedOut: false,
            truncated: false,
        });
        const stack = await current();
        try {
            await saveEditableStack(root, "demo", req(stack, { composeSource: "services: {}\n" }), asProvider(leaking), MAX);
            throw new Error("expected validation to fail");
        } catch (error) {
            expect(error).toBeInstanceOf(StackValidationError);
            expect((error as Error).message).not.toContain("supersecretvalue");
            expect((error as Error).message).not.toContain("superse");
        }
    });
});

describe("saveEditableStack", () => {
    test("validates in context and writes changed files with a backup", async () => {
        const { runner, calls } = recordingRunner();
        const stack = await current();
        const nextCompose = COMPOSE.replace("nginx:alpine", "nginx:1.27-alpine");

        const result = await saveEditableStack(root, "demo", req(stack, { composeSource: nextCompose }), asProvider(runner), MAX);

        expect(result.changed).toBe(true);
        expect(await readFile(join(root, "demo", "compose.yaml"), "utf8")).toBe(nextCompose);
        // The draft is validated with an explicit -f and --project-directory.
        const args = calls.find(call => call.includes("config"))!;
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
        await saveEditableStack(root, "demo", req(stack, { envSource: "DB_PASSWORD=changedvalue\n" }), asProvider(runner), MAX);
        expect(calls.find(call => call.includes("config"))!).toContain("--env-file");
        expect(await readFile(join(root, "demo", ".env"), "utf8")).toBe("DB_PASSWORD=changedvalue\n");
    });

    test("validates against the live .env when only the Compose file changes", async () => {
        const { runner, calls } = recordingRunner();
        const stack = await current();
        await saveEditableStack(root, "demo", req(stack, { composeSource: COMPOSE.replace("nginx:alpine", "nginx:1.27-alpine") }), asProvider(runner), MAX);
        const args = calls.find(call => call.includes("config") && call.includes("--quiet"))!;
        const position = args.indexOf("--env-file");
        expect(position).toBeGreaterThan(-1);
        expect(args[position + 1]).toBe(join(root, "demo", ".env"));
    });

    test("omits --env-file when the stack has no .env", async () => {
        await rm(join(root, "demo", ".env"));
        const { runner, calls } = recordingRunner();
        const stack = await current();
        await saveEditableStack(root, "demo", req(stack, { composeSource: COMPOSE.replace("nginx:alpine", "nginx:1.28-alpine") }), asProvider(runner), MAX);
        const args = calls.find(call => call.includes("config") && call.includes("--quiet"))!;
        expect(args.includes("--env-file")).toBe(false);
    });

    test("is a no-op when nothing changed", async () => {
        const stack = await current();
        const result = await saveEditableStack(root, "demo", req(stack), asProvider(okRunner), MAX);
        expect(result.changed).toBe(false);
        expect(await readFile(join(root, "demo", "compose.yaml"), "utf8")).toBe(COMPOSE);
    });

    test("refuses to overwrite an external change", async () => {
        const stack = await current();
        await writeFile(join(root, "demo", "compose.yaml"), "services: {}\n");
        await expect(saveEditableStack(root, "demo", req(stack, { composeSource: "services:\n  app:\n    image: x\n" }), asProvider(okRunner), MAX))
            .rejects.toThrow(StackConflictError);
        expect(await readFile(join(root, "demo", "compose.yaml"), "utf8")).toBe("services: {}\n");
    });

    test("refuses a save when compose changes during validation", async () => {
        const stack = await current();
        const external = "services:\n  external: true\n";
        const racingRunner: DockerRunner = async args => {
            if (args.includes("config")) {
                await writeFile(join(root, "demo", "compose.yaml"), external);
                return okResult;
            }
            return okResult;
        };
        await expect(saveEditableStack(root, "demo", req(stack, { composeSource: "services:\n  app:\n    image: x\n" }), asProvider(racingRunner), MAX))
            .rejects.toThrow(StackConflictError);
        // The external change is preserved; the draft was never published.
        expect(await readFile(join(root, "demo", "compose.yaml"), "utf8")).toBe(external);
        expect(await readFile(join(root, "demo", ".env"), "utf8")).toBe(ENV);
    });

    test("refuses when compose is removed during validation", async () => {
        const stack = await current();
        const racingRunner: DockerRunner = async args => {
            if (args.includes("config")) {
                await rm(join(root, "demo", "compose.yaml"));
                return okResult;
            }
            return okResult;
        };
        try {
            await saveEditableStack(root, "demo", req(stack, { composeSource: "services:\n  app:\n    image: x\n" }), asProvider(racingRunner), MAX);
            throw new Error("expected the save to fail");
        } catch (error) {
            expect(error).toBeInstanceOf(StackError);
            expect((error as StackError).status).toBe(404);
        }
        expect(await readFile(join(root, "demo", ".env"), "utf8")).toBe(ENV);
    });

    test("leaves both files untouched when backups cannot be taken", async () => {
        // Block the backup directory with a regular file.
        await mkdir(join(root, ".compose-panel", "backups"), { recursive: true });
        await writeFile(join(root, ".compose-panel", "backups", "demo"), "blocker");
        const stack = await current();
        await expect(saveEditableStack(root, "demo", req(stack, {
            composeSource: "services:\n  app:\n    image: x\n",
            envSource: "DB_PASSWORD=changedvalue\n",
        }), asProvider(okRunner), MAX)).rejects.toThrow();
        expect(await readFile(join(root, "demo", "compose.yaml"), "utf8")).toBe(COMPOSE);
        expect(await readFile(join(root, "demo", ".env"), "utf8")).toBe(ENV);
    });

    test.skipIf(process.platform === "win32")("refuses a symlinked backup hierarchy and leaves the target alone", async () => {
        const outside = await mkdtemp(join(tmpdir(), "compose-panel-outside-"));
        try {
            await writeFile(join(outside, "planted.txt"), "outside\n");
            await symlink(outside, join(root, ".compose-panel"));
            const stack = await current();
            await expect(saveEditableStack(root, "demo", req(stack, {
                composeSource: "services:\n  app:\n    image: x\n",
            }), asProvider(okRunner), MAX)).rejects.toThrow(FileSafetyError);
            expect(await readFile(join(root, "demo", "compose.yaml"), "utf8")).toBe(COMPOSE);
            expect(await readdir(outside)).toEqual(["planted.txt"]);
        } finally {
            await rm(outside, { recursive: true, force: true });
        }
    });

    test("refuses a replaced stack directory even with identical content", async () => {
        const stack = await current();
        const racingRunner: DockerRunner = async args => {
            if (args.includes("config")) {
                const compose = await readFile(join(root, "demo", "compose.yaml"), "utf8");
                const env = await readFile(join(root, "demo", ".env"), "utf8");
                await rm(join(root, "demo"), { recursive: true });
                await mkdir(join(root, "demo"));
                await writeFile(join(root, "demo", "compose.yaml"), compose);
                await writeFile(join(root, "demo", ".env"), env);
                return okResult;
            }
            return okResult;
        };
        // Hashes still match: only the directory identity check can fire.
        await expect(saveEditableStack(root, "demo", req(stack, { composeSource: "services:\n  app:\n    image: x\n" }), asProvider(racingRunner), MAX))
            .rejects.toThrow(StackConflictError);
        expect(await readFile(join(root, "demo", "compose.yaml"), "utf8")).toBe(COMPOSE);
    });

    test("restores compose and reports partial when the env write fails", async () => {
        const stack = await current();
        const written: string[] = [];
        const writer = async (path: string, content: string, mode: number) => {
            written.push(path);
            if (path.endsWith(".env")) throw new Error("disk full");
            await writeFileAtomic(path, content, mode);
        };
        const error = await saveEditableStack(root, "demo", req(stack, {
            composeSource: "services:\n  app:\n    image: x\n",
            envSource: "DB_PASSWORD=changedvalue\n",
        }), asProvider(okRunner), MAX, { writer }).catch(error => error);
        expect(error).toBeInstanceOf(StackPartialError);
        expect((error as StackPartialError).backupPaths.length).toBe(2);
        expect((error as Error).message).toContain("put back to its previous version");
        expect(await readFile(join(root, "demo", "compose.yaml"), "utf8")).toBe(COMPOSE);
        expect(await readFile(join(root, "demo", ".env"), "utf8")).toBe(ENV);
        // Compose was written, then written back by the restore.
        expect(written.filter(path => path.endsWith("compose.yaml")).length).toBe(2);
    });

    test("reports manual recovery when the restore also fails", async () => {
        const stack = await current();
        const draft = "services:\n  app:\n    image: x\n";
        let calls = 0;
        const writer = async (path: string, content: string, mode: number) => {
            calls += 1;
            if (calls === 1) {
                await writeFileAtomic(path, content, mode);
                return;
            }
            throw new Error("disk full");
        };
        const error = await saveEditableStack(root, "demo", req(stack, {
            composeSource: draft,
            envSource: "DB_PASSWORD=changedvalue\n",
        }), asProvider(okRunner), MAX, { writer }).catch(error => error);
        expect(error).toBeInstanceOf(StackPartialError);
        expect((error as Error).message).toContain("could not be put back");
        expect((error as StackPartialError).backupPaths.length).toBe(2);
        // Compose is left at the draft: the message must say so honestly.
        expect(await readFile(join(root, "demo", "compose.yaml"), "utf8")).toBe(draft);
    });

    test("does not publish an invalid draft", async () => {
        const failing: DockerRunner = async () => ({ code: 1, stdout: "", stderr: "services.app.ports must be a list", timedOut: false, truncated: false });
        const stack = await current();
        await expect(saveEditableStack(root, "demo", req(stack, { composeSource: "services: {}\n" }), asProvider(failing), MAX))
            .rejects.toThrow(StackValidationError);
        expect(await readFile(join(root, "demo", "compose.yaml"), "utf8")).toBe(COMPOSE);
    });

    test("does not write when Docker is unavailable", async () => {
        const unavailable: DockerRunner = async () => ({ code: -1, stdout: "", stderr: "", timedOut: false, truncated: false });
        const stack = await current();
        await expect(saveEditableStack(root, "demo", req(stack, { composeSource: "services: {}\n" }), asProvider(unavailable), MAX))
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
            await saveEditableStack(root, "demo", req(stack, { composeSource: "services: {}\n" }), asProvider(leaking), MAX);
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
        const result = await saveEditableStack(root, "demo", request, asProvider(okRunner), MAX);
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
