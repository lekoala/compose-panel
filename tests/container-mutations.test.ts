import { describe, expect, test } from "bun:test";
import { ContainerMutationError, createContainerMutator } from "../src/container-mutations.ts";
import type { CommandResult, DockerRunner } from "../src/docker.ts";

const ID = "a".repeat(64);
const ok: CommandResult = { code: 0, stdout: "", stderr: "", timedOut: false, truncated: false };

function recording() {
    const calls: { args: string[]; timeoutMs?: number }[] = [];
    const runner: DockerRunner = async (args, options) => {
        calls.push({ args, timeoutMs: options?.timeoutMs });
        return ok;
    };
    return { mutator: createContainerMutator({ runner }), calls };
}

describe("container mutator", () => {
    test("stop uses the fixed executable, the full ID and no force", async () => {
        const { mutator, calls } = recording();
        await mutator.stop(ID, 30);
        expect(calls[0]!.args).toEqual(["container", "stop", "--time", "30", "--", ID]);
        expect(calls[0]!.timeoutMs).toBe(35_000);
    });

    test("remove never forces and never removes volumes", async () => {
        const { mutator, calls } = recording();
        await mutator.remove(ID);
        expect(calls[0]!.args).toEqual(["container", "remove", "--", ID]);
        expect(calls[0]!.args).not.toContain("--force");
        expect(calls[0]!.args).not.toContain("-f");
        expect(calls[0]!.args).not.toContain("-v");
    });

    test("markDrain always runs touch with one validated path", async () => {
        const { mutator, calls } = recording();
        await mutator.markDrain(ID, "/tmp/drain");
        expect(calls[0]!.args).toEqual(["container", "exec", ID, "touch", "/tmp/drain"]);
    });

    test("refuses a short container ID", async () => {
        const { mutator } = recording();
        expect(() => mutator.stop("abc123", 30)).toThrow(ContainerMutationError);
        expect(() => mutator.remove("abc123")).toThrow(ContainerMutationError);
        expect(() => mutator.markDrain("abc123", "/tmp/drain")).toThrow(ContainerMutationError);
    });

    test("refuses invalid stop timeouts", async () => {
        const { mutator } = recording();
        for (const seconds of [0, -1, 301, 1.5, Number.NaN]) {
            expect(() => mutator.stop(ID, seconds)).toThrow(ContainerMutationError);
        }
    });

    test("refuses an unsafe drain path", async () => {
        const { mutator } = recording();
        for (const path of ["tmp/drain", "/tmp/../etc/passwd", "/tmp/a\nb", "/tmp/" + "a".repeat(300), ""]) {
            expect(() => mutator.markDrain(ID, path)).toThrow(ContainerMutationError);
        }
    });

    test("refuses Podman and unknown engines", () => {
        expect(() => createContainerMutator({ runner: async () => ok, engine: "podman" })).toThrow(/not implemented/);
        expect(() => createContainerMutator({ runner: async () => ok, engine: "containerd" })).toThrow(/Unknown container engine/);
    });
});
