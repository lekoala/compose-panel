import { expect, test } from "bun:test";
import { LogManager, stripAnsi } from "../src/logs.ts";
import { StackError } from "../src/stacks.ts";
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
        projectName: async () => "demo-proj",
        projectServices: async () => ok,
        projectImages: async () => ok,
        stackMetadata: async () => ({}),
        inspectImages: async () => ok,
        validateConfig: async () => ok,
        listServices: async () => [],
        runningContainerIds: async () => [],
        readLogs: async () => ok,
        pull: async () => ok,
        up: async () => ok,
        stop: async () => ok,
        start: async () => ok,
        restart: async () => ok,
        down: async () => ok,
        serviceImage: async () => null,
        recreateService: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false, truncated: false }),
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

/** Provider whose follow calls settle only when told to (or on abort). */
function deferredProvider(): {
    provider: ComposeProvider;
    calls: FollowCall[];
    resolvers: (() => void)[];
} {
    const calls: FollowCall[] = [];
    const resolvers: (() => void)[] = [];
    const caps: ComposeCapabilities = { engine: "fake", available: true, operations: { ls: true, ps: true, config: true, logs: true } };
    const provider: ComposeProvider = {
        engine: "fake",
        capabilities: () => caps,
        detect: async () => caps,
        listProjects: async () => ok,
        projectName: async () => "demo-proj",
        projectServices: async () => ok,
        projectImages: async () => ok,
        stackMetadata: async () => ({}),
        inspectImages: async () => ok,
        validateConfig: async () => ok,
        listServices: async () => [],
        runningContainerIds: async () => [],
        readLogs: async () => ok,
        pull: async () => ok,
        up: async () => ok,
        stop: async () => ok,
        start: async () => ok,
        restart: async () => ok,
        down: async () => ok,
        serviceImage: async () => null,
        recreateService: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false, truncated: false }),
        followLogs: (followTarget, onChunk, signal) => new Promise(resolve => {
            calls.push({ target: followTarget, onChunk, signal });
            resolvers.push(() => resolve({ code: 0, timedOut: false }));
            signal.addEventListener("abort", () => resolve({ code: 137, timedOut: false }), { once: true });
        }),
    };
    return { provider, calls, resolvers };
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

test("different selections run their own subprocess and share identical ones", () => {
    const { provider, calls } = controllableProvider();
    const logs = manager(provider);
    const all = logs.subscribe("demo", target, () => {}, () => {});
    const web = logs.subscribe("demo", { ...target, service: "web", tailLines: 500 }, () => {}, () => {});
    const webAgain = logs.subscribe("demo", { ...target, service: "web", tailLines: 500 }, () => {}, () => {});
    expect(calls.length).toBe(2);
    expect(calls[1]!.target.service).toBe("web");
    expect(calls[1]!.target.tailLines).toBe(500);
    // Leaving one selection does not stop the other.
    web.unsubscribe();
    webAgain.unsubscribe();
    expect(logs.isActive("demo")).toBe(true);
    expect(calls[1]!.signal.aborted).toBe(true);
    all.unsubscribe();
    expect(logs.isActive("demo")).toBe(false);
});

test("a third live selection for one stack is refused", () => {
    const { provider, calls } = controllableProvider();
    const logs = manager(provider);
    const a = logs.subscribe("demo", target, () => {}, () => {});
    const b = logs.subscribe("demo", { ...target, service: "web" }, () => {}, () => {});
    expect(calls.length).toBe(2);
    expect(() => logs.subscribe("demo", { ...target, service: "db" }, () => {}, () => {})).toThrow(StackError);
    // After one selection ends, a new one fits again.
    a.unsubscribe();
    const c = logs.subscribe("demo", { ...target, service: "db" }, () => {}, () => {});
    expect(calls.length).toBe(3);
    b.unsubscribe();
    c.unsubscribe();
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
    await logs.shutdown(1000);
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
    await logs.shutdown(1000);
    expect(calls[0]!.signal.aborted).toBe(true);
    expect(logs.isActive("demo")).toBe(false);
    expect(logs.subscriberCount()).toBe(0);
});

test("a timed-out stream cannot kill or contaminate its replacement", async () => {
    const { provider, calls, resolvers } = deferredProvider();
    const logs = manager(provider, { timeoutMs: 20 });
    let reasonA: string | null = null;
    const subA = logs.subscribe("demo", target, () => {}, end => { reasonA = end; });
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(reasonA!).toBe("timeout");
    expect(logs.isActive("demo")).toBe(false);

    const receivedB: string[] = [];
    const subB = logs.subscribe("demo", target, chunk => receivedB.push(chunk), () => {});
    expect(calls.length).toBe(2);

    // The old stream settles late and emits stale output: both are dropped.
    resolvers[0]!();
    calls[0]!.onChunk("stale\n");
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(logs.isActive("demo")).toBe(true);
    expect(receivedB.join("")).not.toContain("stale");

    // The old reader leaving does not stop the replacement.
    subA.unsubscribe();
    expect(logs.isActive("demo")).toBe(true);
    expect(calls[1]!.signal.aborted).toBe(false);
    subB.unsubscribe();
    expect(calls[1]!.signal.aborted).toBe(true);
});

test("shutdown stays bounded when a follow never settles", async () => {
    const caps: ComposeCapabilities = { engine: "stuck", available: true, operations: { ls: true, ps: true, config: true, logs: true } };
    const stuck: ComposeProvider = {
        engine: "stuck",
        capabilities: () => caps,
        detect: async () => caps,
        listProjects: async () => ok,
        projectName: async () => "demo-proj",
        projectServices: async () => ok,
        projectImages: async () => ok,
        stackMetadata: async () => ({}),
        inspectImages: async () => ok,
        validateConfig: async () => ok,
        listServices: async () => [],
        runningContainerIds: async () => [],
        readLogs: async () => ok,
        pull: async () => ok,
        up: async () => ok,
        stop: async () => ok,
        start: async () => ok,
        restart: async () => ok,
        down: async () => ok,
        serviceImage: async () => null,
        recreateService: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false, truncated: false }),
        followLogs: () => new Promise(() => {}),
    };
    const logs = manager(stuck, { timeoutMs: 60_000 });
    let ended = false;
    logs.subscribe("demo", target, () => {}, () => { ended = true; });
    const started = Date.now();
    await logs.shutdown(50);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(ended).toBe(true);
    expect(logs.isActive("demo")).toBe(false);
});

test("refuses new subscriptions once shutdown started", async () => {
    const { provider } = controllableProvider();
    const logs = manager(provider);
    logs.refuseNew();
    try {
        logs.subscribe("demo", target, () => {}, () => {});
        throw new Error("expected subscribe to fail");
    } catch (error) {
        expect(error).toBeInstanceOf(StackError);
        expect((error as StackError).status).toBe(503);
    }
});

test("does not replace an aborted follow until its process exit is confirmed", async () => {
    const { provider, calls } = controllableProvider();
    let finish!: (result: { code: number; timedOut: boolean }) => void;
    provider.followLogs = (target, onChunk, signal) => new Promise(resolve => {
        calls.push({ target, onChunk, signal });
        finish = resolve;
    });
    const logs = manager(provider);
    const sub = logs.subscribe("demo", target, () => {}, () => {});
    sub.unsubscribe();
    expect(calls[0]!.signal.aborted).toBe(true);
    expect(() => logs.subscribe("demo", target, () => {}, () => {})).toThrow(StackError);
    expect(calls).toHaveLength(1);
    finish({ code: 137, timedOut: false });
    await Promise.resolve();
    const replacement = logs.subscribe("demo", target, () => {}, () => {});
    expect(calls).toHaveLength(2);
    replacement.unsubscribe();
    finish({ code: 137, timedOut: false });
    await logs.shutdown(100);
});
