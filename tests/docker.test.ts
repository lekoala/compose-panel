import { expect, test } from "bun:test";
import { SPAWN_FAILURE, runCommand } from "../src/docker.ts";

test("captures stdout and exit code", async () => {
    const result = await runCommand(process.execPath, ["-e", "process.stdout.write('hello')"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("hello");
    expect(result.timedOut).toBe(false);
    expect(result.truncated).toBe(false);
});

test("caps captured output", async () => {
    const result = await runCommand(process.execPath, ["-e", "process.stdout.write('x'.repeat(5000))"], { maxBytes: 100 });
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(100);
});

test("times out a hanging process", async () => {
    const result = await runCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 400 });
    expect(result.timedOut).toBe(true);
});

test("does not throw when the executable is missing", async () => {
    const result = await runCommand("compose-panel-no-such-binary", []);
    expect(result.code).toBe(SPAWN_FAILURE);
});
