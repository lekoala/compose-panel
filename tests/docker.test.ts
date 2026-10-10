import { expect, test } from "bun:test";
import { SPAWN_FAILURE, composeEnvironment, runCommand } from "../src/docker.ts";

test("strips panel-only variables from the subprocess environment", () => {
    const env = composeEnvironment({
        PATH: "/usr/bin",
        COMPOSE_PROJECT_NAME: "keep-me",
        COMPOSE_PANEL_ADMIN_PASSWORD_HASH: "secret-hash",
        COMPOSE_PANEL_COOKIE_SECURE: "true",
    } as NodeJS.ProcessEnv);
    expect(env.COMPOSE_PANEL_ADMIN_PASSWORD_HASH).toBeUndefined();
    expect(env.COMPOSE_PANEL_COOKIE_SECURE).toBeUndefined();
    expect(env.COMPOSE_PROJECT_NAME).toBe("keep-me");
    expect(env.PATH).toBe("/usr/bin");
});

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

test("delivers pipe chunks before the process exits", async () => {
    const seen: string[] = [];
    const pending = runCommand(process.execPath, ["-e", "process.stdout.write('early\\n'); setTimeout(() => {}, 500)"], {
        timeoutMs: 5000,
        onChunk: chunk => seen.push(chunk),
    });
    const deadline = Date.now() + 4000;
    while (seen.length === 0 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(seen.join("")).toContain("early");
    const result = await pending;
    expect(result.code).toBe(0);
    expect(result.timedOut).toBe(false);
});

test("drains chatty output past the cap instead of wedging the child", async () => {
    const live: string[] = [];
    const result = await runCommand(
        process.execPath,
        ["-e", "for (let i = 0; i < 300000; i++) process.stdout.write('0123456789abcdef\\n')"],
        {
            maxBytes: 100,
            timeoutMs: 15000,
            onChunk: chunk => live.push(chunk),
        },
    );
    // Megabytes flowed through a 100-byte cap: the child exited on its own.
    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(0);
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(100);
    expect(live.join("").length).toBeGreaterThan(1000);
});

test("does not throw when the executable is missing", async () => {
    const result = await runCommand("compose-panel-no-such-binary", []);
    expect(result.code).toBe(SPAWN_FAILURE);
});

test("preserves UTF-8 split between separate pipe writes", async () => {
    const seen: string[] = [];
    const result = await runCommand(process.execPath, ["-e", "const b = Buffer.from('é🙂'); process.stdout.write(b.subarray(0, 1)); setTimeout(() => process.stdout.write(b.subarray(1, 4)), 30); setTimeout(() => process.stdout.write(b.subarray(4)), 60)"], { onChunk: text => seen.push(text) });
    expect(seen.join("")).toBe("é🙂");
    expect(result.stdout).toBe("é🙂");
});

test("aborts a running child and confirms its exit within the kill deadline", async () => {
    const controller = new AbortController();
    const result = await runCommand(process.execPath, ["-e", "process.stdout.write('ready'); setInterval(() => {}, 1000)"], {
        timeoutMs: 5000, signal: controller.signal,
        onChunk: () => controller.abort(),
    });
    expect(result.timedOut).toBe(true);
    expect(result.terminationUnconfirmed).toBe(false);
    expect(result.code).not.toBe(0);
});
