import { describe, expect, test } from "bun:test";
import { ActionRunnerError, createActionRunner } from "../src/action-runner.ts";
import { DOCKER_FILE_TAR_OVERHEAD } from "../src/docker-file-tar.ts";
import type { CommandResult, DockerRunner, RunOptions } from "../src/docker.ts";
import { fileTar } from "./helpers/tar.ts";

const ID = "df48a7b63a0a611b2a1b7050ac56f05338b4eaf24ee1ef83c456fa56beecc10d";
const ok: CommandResult = { code: 0, stdout: "", stderr: "", timedOut: false, truncated: false };

function recording(result: CommandResult = ok) {
    const calls: { args: string[]; options?: RunOptions }[] = [];
    const runner: DockerRunner = async (args, options) => { calls.push({ args, options }); return result; };
    return { calls, actionRunner: createActionRunner({ runner }) };
}

describe("DockerActionRunner.readFile", () => {
    const options = { timeoutMs: 5000, maxBytes: 1024 };
    test("reads a regular manifest directly from a bounded binary transfer", async () => {
        const { actionRunner, calls } = recording({ ...ok, stdoutBytes: fileTar("composer.json", "é🙂") });
        expect(await actionRunner.readFile(ID, "/app/composer.json", options)).toEqual({ kind: "ok", content: "é🙂" });
        expect(calls[0]!.args).toEqual(["cp", "--", `${ID}:/app/composer.json`, "-"]);
        expect(calls[0]!.options).toMatchObject({ timeoutMs: 5000, maxBytes: 1024 + DOCKER_FILE_TAR_OVERHEAD, binaryStdout: true, stopOnOutputLimit: true });
    });

    for (const [label, type] of [["directory", "5"], ["symlink", "2"], ["hard link", "1"], ["FIFO", "6"]]) {
        test(`refuses a ${label}`, async () => {
            const { actionRunner } = recording({ ...ok, stdoutBytes: fileTar("composer.json", "", type) });
            expect((await actionRunner.readFile(ID, "/app/composer.json", options)).kind).toBe("not-file");
        });
    }

    test("refuses a file larger than the manifest cap and a truncated transfer", async () => {
        for (const result of [{ ...ok, stdoutBytes: fileTar("composer.json", "x".repeat(4096)) }, { ...ok, code: 137, truncated: true }]) {
            expect((await recording(result).actionRunner.readFile(ID, "/app/composer.json", options)).kind).toBe("too-large");
        }
    });

    test("refuses failed, timed-out, or unconfirmed copies without reading partial bytes", async () => {
        for (const result of [{ code: 1 }, { timedOut: true }, { terminationUnconfirmed: true }]) {
            const { actionRunner } = recording({ ...ok, stdoutBytes: fileTar("composer.json", "{}"), ...result });
            expect((await actionRunner.readFile(ID, "/app/composer.json", options)).kind).toBe("error");
        }
    });

    test("refuses invalid references before spawning", async () => {
        const { actionRunner, calls } = recording();
        expect((await actionRunner.readFile("../escape", "/app/composer.json", options)).kind).toBe("error");
        expect((await actionRunner.readFile(ID, "app/composer.json", options)).kind).toBe("error");
        expect((await actionRunner.readFile(ID, "/app/../etc/passwd", options)).kind).toBe("error");
        expect(calls).toHaveLength(0);
    });
});

describe("DockerActionRunner.exec", () => {
    test("builds a non-interactive exec with user and workdir", async () => {
        const { actionRunner, calls } = recording();
        await actionRunner.exec({ id: ID, argv: ["npm", "run", "build"], user: "node", workdir: "/app", timeoutMs: 3000 });
        expect(calls[0]!.args).toEqual(["exec", "-u", "node", "-w", "/app", ID, "npm", "run", "build"]);
        expect(calls[0]!.options?.timeoutMs).toBe(3000);
    });
    test("omits user and workdir when not configured", async () => {
        const { actionRunner, calls } = recording();
        await actionRunner.exec({ id: ID, argv: ["bun", "run", "check"] });
        expect(calls[0]!.args).toEqual(["exec", ID, "bun", "run", "check"]);
    });
    test("rejects invalid IDs and empty commands", () => {
        const { actionRunner } = recording();
        expect(() => actionRunner.exec({ id: "nope", argv: ["npm", "run", "x"] })).toThrow(ActionRunnerError);
        expect(() => actionRunner.exec({ id: ID, argv: [] })).toThrow(ActionRunnerError);
    });
});
