import { expect, test } from "bun:test";
import { LogManager, stripAnsi } from "../src/logs.ts";
import type { ComposeCapabilities, ComposeProvider, ComposeTarget } from "../src/compose-provider.ts";
import type { CommandResult } from "../src/docker.ts";

const ok: CommandResult = { code: 0, stdout: "", stderr: "", timedOut: false, truncated: false };
const target: ComposeTarget = { composeFile: "/stacks/demo/compose.yaml", cwd: "/stacks/demo", project: "demo-proj" };

interface FollowCall {
    target: ComposeTarget & { tailLines?: number };
    onChunk: (chunk: string) => void;
    signal: AbortSignal;
}

function controllableProvider(): { provider: ComposeProvider; calls: FollowCall[] } {
    const calls: FollowCall[] = [];
    const caps: ComposeCapabilities = { engine: "fake", available: true, operations: { ls: true, ps: true, config: true, logs: true } };
    const provider: ComposeProvider = {
        engine: "fake",
        capabilities: () => caps,
        detect: async () => caps,
        listProjects: async () => ok,
        projectServices: async () => ok,
        validateConfig: async () => ok,
        pull: async () => ok,
        up: async () => ok,
        stop: async () => ok,
        restart: async () => ok,
        down: async () => ok,
        followLogs: (followTarget, onChunk, signal) => new Promise(resolve => {
            calls.push({ target: followTarget, onChunk, signal });
            signal.addEventListener("abort", () => resolve({ code: 137, timedOut: false }), { once: true });
        }),
    };
    return { provider, calls };
}

function manager(provider: ComposeProvider, overrides = {}) {
    return new LogManager(provider, { tailLines: 50, maxBytes: 1024, timeoutMs: 60_000, ...overrides });
}

test("stripAnsi removes color escapes", () => {
    expect(stripAnsi("\x1b[32mok\x1b[0m plain")).toBe("ok plain");
});

test("readers share one subprocess and late readers get a replay", () => {
    const { provider, calls } = controllableProvider();
    const logs = manager(provider);
    const first: string[] = [];
    const second: string[] = [];
    const a = logs.subscribe("demo", target, chunk => first.push(chunk), () => {});
    calls[0]!.onChunk("line 1\n");
    const b = logs.subscribe("demo", target, chunk => second.push(chunk), () => {});
    expect(calls.length).toBe(1);
    expect(calls[0]!.target.tailLines).toBe(50);
    expect(b.replay.text).toContain("line 1");
    calls[0]!.onChunk("line 2\n");
    expect(first.join("")).toContain("line 2");
    expect(second.join("")).toContain("line 2");
    a.unsubscribe();
    b.unsubscribe();
});

test("leaving the last reader aborts the follow subprocess", async () => {
    const { provider, calls } = controllableProvider();
    const logs = manager(provider);
    const a = logs.subscribe("demo", target, () => {}, () => {});
    const b = logs.subscribe("demo", target, () => {}, () => {});
    expect(logs.isActive("demo")).toBe(true);
    a.unsubscribe();
    // One reader left: the process keeps running.
    expect(logs.isActive("demo")).toBe(true);
    expect(calls[0]!.signal.aborted).toBe(false);
    b.unsubscribe();
    expect(calls[0]!.signal.aborted).toBe(true);
    await logs.shutdown();
    expect(logs.isActive("demo")).toBe(false);
});

test("the retained buffer is capped and keeps the tail", () => {
    const { provider, calls } = controllableProvider();
    const logs = manager(provider, { maxBytes: 16 });
    const sub = logs.subscribe("demo", target, () => {}, () => {});
    calls[0]!.onChunk("0123456789abcdef tail");
    expect(sub.replay.truncated).toBe(false);
    const late = logs.subscribe("demo", target, () => {}, () => {});
    expect(late.replay.truncated).toBe(true);
    expect(Buffer.byteLength(late.replay.text, "utf8")).toBeLessThanOrEqual(16);
    expect(late.replay.text).toContain("tail");
    sub.unsubscribe();
    late.unsubscribe();
});

test("the explicit timeout ends the stream", async () => {
    const { provider } = controllableProvider();
    const logs = manager(provider, { timeoutMs: 20 });
    let reason: string | null = null;
    const sub = logs.subscribe("demo", target, () => {}, end => { reason = end; });
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(reason!).toBe("timeout");
    expect(logs.isActive("demo")).toBe(false);
    sub.unsubscribe();
});

test("shutdown kills active follows", async () => {
    const { provider, calls } = controllableProvider();
    const logs = manager(provider);
    logs.subscribe("demo", target, () => {}, () => {});
    await logs.shutdown();
    expect(calls[0]!.signal.aborted).toBe(true);
    expect(logs.isActive("demo")).toBe(false);
    expect(logs.subscriberCount()).toBe(0);
});
