import { expect, test } from "bun:test";
import { StackBusyError, StackLocks } from "../src/locks.ts";

test("rejects a concurrent operation on the same stack", async () => {
    const locks = new StackLocks();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });

    const first = locks.run("a", () => gate);
    await expect(locks.run("a", async () => 1)).rejects.toThrow(StackBusyError);
    await expect(locks.run("b", async () => 2)).resolves.toBe(2);
    expect(locks.isLocked("a")).toBe(true);

    release();
    await first;
    expect(locks.isLocked("a")).toBe(false);
    await expect(locks.run("a", async () => 3)).resolves.toBe(3);
});

test("releases the lock when the operation throws", async () => {
    const locks = new StackLocks();
    await expect(locks.run("a", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(locks.isLocked("a")).toBe(false);
});
