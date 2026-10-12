import { describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, posix } from "node:path";
import { ActionRunnerError, createActionRunner } from "../src/action-runner.ts";
import type { CommandResult, DockerRunner } from "../src/docker.ts";

// Creating a symlink needs a privilege or Developer Mode on Windows; probe once
// so the refusal is still exercised wherever the platform allows it.
const symlinksSupported = await (async () => {
    const dir = await mkdtemp(join(tmpdir(), "cp-symlink-probe-"));
    try { await symlink("/etc/passwd", join(dir, "link")); return true; }
    catch { return false; }
    finally { await rm(dir, { recursive: true, force: true }); }
})();

const ID = "df48a7b63a0a611b2a1b7050ac56f05338b4eaf24ee1ef83c456fa56beecc10d";
const ok: CommandResult = { code: 0, stdout: "", stderr: "", timedOut: false, truncated: false };

/** A runner that materializes the `docker cp` result so readFile can read it. */
function copyingRunner(options: { kind?: "file" | "dir" | "symlink"; size?: number } = {}) {
    const calls: string[][] = [];
    const runner: DockerRunner = async args => {
        calls.push(args);
        if (args[0] === "cp") {
            const destDir = args[3]!;
            const target = join(destDir, basename(posix.normalize(args[2]!.split(":").slice(1).join(":"))));
            if (options.kind === "dir") await mkdir(target, { recursive: true });
            else if (options.kind === "symlink") await symlink("/etc/passwd", target);
            else await writeFile(target, "x".repeat(options.size ?? 8));
        }
        return ok;
    };
    return { runner, calls };
}

describe("DockerActionRunner.readFile", () => {
    test("reads a regular file and removes the temporary directory", async () => {
        const { runner, calls } = copyingRunner();
        const actionRunner = createActionRunner({ runner });
        const result = await actionRunner.readFile(ID, "/app/composer.json", { timeoutMs: 5000, maxBytes: 1024 });
        expect(result).toEqual({ kind: "ok", content: "x".repeat(8) });
        expect(calls[0]![0]).toBe("cp");
        expect(calls[0]![1]).toBe("--");
        expect(calls[0]![2]).toBe(`${ID}:/app/composer.json`);
        // The private temp directory is gone after the read.
        const dir = calls[0]![3]!;
        await expect(lstat(dir)).rejects.toBeTruthy();
    });

    test("refuses a directory", async () => {
        const { runner, calls } = copyingRunner({ kind: "dir" });
        const actionRunner = createActionRunner({ runner });
        const result = await actionRunner.readFile(ID, "/app/composer.json", { timeoutMs: 5000, maxBytes: 1024 });
        expect(result.kind).toBe("not-file");
        await expect(lstat(calls[0]![3]!)).rejects.toBeTruthy();
    });

    // Creating a symlink needs privileges on some platforms; the refusal itself
    // (the `isSymbolicLink()` branch) is what must be covered where possible.
    test.skipIf(!symlinksSupported)("refuses a symlink", async () => {
        const { runner } = copyingRunner({ kind: "symlink" });
        const actionRunner = createActionRunner({ runner });
        const result = await actionRunner.readFile(ID, "/app/composer.json", { timeoutMs: 5000, maxBytes: 1024 });
        expect(result.kind).toBe("not-file");
    });

    test("refuses a file larger than the read cap", async () => {
        const { runner } = copyingRunner({ size: 4096 });
        const actionRunner = createActionRunner({ runner });
        expect((await actionRunner.readFile(ID, "/app/composer.json", { timeoutMs: 5000, maxBytes: 1024 })).kind).toBe("too-large");
    });

    test("refuses an invalid container id or path without spawning anything", async () => {
        const { runner, calls } = copyingRunner();
        const actionRunner = createActionRunner({ runner });
        expect((await actionRunner.readFile("../escape", "/app/composer.json", { timeoutMs: 5000, maxBytes: 1024 })).kind).toBe("error");
        expect((await actionRunner.readFile(ID, "app/composer.json", { timeoutMs: 5000, maxBytes: 1024 })).kind).toBe("error");
        expect((await actionRunner.readFile(ID, "/app/../etc/passwd", { timeoutMs: 5000, maxBytes: 1024 })).kind).toBe("error");
        expect(calls).toHaveLength(0);
    });
});

describe("DockerActionRunner.exec", () => {
    test("builds a non-interactive exec with user and workdir", async () => {
        const calls: { args: string[]; options?: Parameters<DockerRunner>[1] }[] = [];
        const runner: DockerRunner = async (args, opts) => { calls.push({ args, options: opts }); return ok; };
        const actionRunner = createActionRunner({ runner });
        await actionRunner.exec({ id: ID, argv: ["npm", "run", "build"], user: "node", workdir: "/app", timeoutMs: 3000 });
        expect(calls[0]!.args).toEqual(["exec", "-u", "node", "-w", "/app", ID, "npm", "run", "build"]);
        expect(calls[0]!.args).not.toContain("-i");
        expect(calls[0]!.args).not.toContain("-t");
        expect(calls[0]!.options?.timeoutMs).toBe(3000);
    });

    test("omits user and workdir when not configured", async () => {
        const calls: string[][] = [];
        const runner: DockerRunner = async args => { calls.push(args); return ok; };
        await createActionRunner({ runner }).exec({ id: ID, argv: ["bun", "run", "check"] });
        expect(calls[0]).toEqual(["exec", ID, "bun", "run", "check"]);
    });

    test("rejects an invalid id or an empty argv", () => {
        const runner: DockerRunner = async () => ok;
        const actionRunner = createActionRunner({ runner });
        expect(() => actionRunner.exec({ id: "nope", argv: ["npm", "run", "x"] })).toThrow(ActionRunnerError);
        expect(() => actionRunner.exec({ id: ID, argv: [] })).toThrow(ActionRunnerError);
    });
});
