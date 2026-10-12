import { expect, test } from "bun:test";
import { OperationManager, OperationsDisabledError, isOperationAction } from "../src/operations.ts";
import { StackBusyError, StackLocks } from "../src/locks.ts";
import type { ComposeCapabilities, ComposeProvider, ComposeTarget } from "../src/compose-provider.ts";
import type { CommandResult } from "../src/docker.ts";

const ok: CommandResult = { code: 0, stdout: "done", stderr: "", timedOut: false, truncated: false };
const target: ComposeTarget = { composeFile: "/stacks/demo/compose.yaml", cwd: "/stacks/demo" };

function fakeProvider(handlers: Partial<Record<"pull" | "up" | "stop" | "restart" | "down", (target: ComposeTarget) => Promise<CommandResult>>> = {}): ComposeProvider {
    const caps: ComposeCapabilities = { engine: "fake", available: true, operations: { ls: true, ps: true, config: true, logs: true } };
    const run = (kind: "pull" | "up" | "stop" | "restart" | "down") =>
        async (target: ComposeTarget) => (handlers[kind] ?? (async () => ok))(target);
    return {
        engine: "fake",
        capabilities: () => caps,
        detect: async () => caps,
        listProjects: async () => ok,
        projectName: async () => "demo-proj",
        projectServices: async () => ok,
        projectImages: async () => ok,
        inspectImages: async () => ok,
        validateConfig: async () => ok,
        readLogs: async () => ok,
        pull: run("pull"),
        up: run("up"),
        stop: run("stop"),
        restart: run("restart"),
        down: run("down"),
        serviceImage: async () => null,
        recreateService: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false, truncated: false }),
        followLogs: async () => ({ code: 0, timedOut: false }),
    };
}

async function settle(manager: OperationManager): Promise<void> {
    for (let i = 0; i < 200 && manager.activeCount() > 0; i += 1) {
        await new Promise(resolve => setTimeout(resolve, 1));
    }
}

test("isOperationAction accepts allow-listed actions only", () => {
    expect(isOperationAction("up")).toBe(true);
    expect(isOperationAction("pull-up")).toBe(true);
    expect(isOperationAction("rm")).toBe(false);
    expect(isOperationAction("exec")).toBe(false);
});

test("runs an up operation to success and keeps the output", async () => {
    const manager = new OperationManager(new StackLocks(), fakeProvider(), { timeoutMs: 1000, maxBytes: 10_000 });
    const started = manager.start({ stack: "demo", action: "up", target });
    expect(started.status).toBe("running");
    await settle(manager);
    const operation = manager.forStack("demo")!;
    expect(operation.status).toBe("succeeded");
    expect(operation.exitCode).toBe(0);
    expect(operation.output).toContain("done");
});

test("reports a failure with the exact exit code", async () => {
    const provider = fakeProvider({ up: async () => ({ code: 1, stdout: "", stderr: "boom", timedOut: false, truncated: false }) });
    const manager = new OperationManager(new StackLocks(), provider, { timeoutMs: 1000, maxBytes: 10_000 });
    manager.start({ stack: "demo", action: "up", target });
    await settle(manager);
    const operation = manager.forStack("demo")!;
    expect(operation.status).toBe("failed");
    expect(operation.exitCode).toBe(1);
    expect(operation.output).toContain("boom");
});

test("treats a timeout as unknown, never as success", async () => {
    const provider = fakeProvider({ up: async () => ({ code: 137, stdout: "", stderr: "", timedOut: true, truncated: false }) });
    const manager = new OperationManager(new StackLocks(), provider, { timeoutMs: 1000, maxBytes: 10_000 });
    manager.start({ stack: "demo", action: "up", target });
    await settle(manager);
    const operation = manager.forStack("demo")!;
    expect(operation.status).toBe("unknown");
    expect(operation.timedOut).toBe(true);
});

test("rejects a second concurrent operation on the same stack", async () => {
    let release!: () => void;
    const gate = new Promise<CommandResult>(resolve => { release = () => resolve(ok); });
    const manager = new OperationManager(new StackLocks(), fakeProvider({ up: () => gate }), { timeoutMs: 1000, maxBytes: 10_000 });
    manager.start({ stack: "demo", action: "up", target });
    expect(() => manager.start({ stack: "demo", action: "stop", target })).toThrow(StackBusyError);
    release();
    await settle(manager);
    // The lock is released, so a new operation is accepted.
    expect(() => manager.start({ stack: "demo", action: "down", target })).not.toThrow();
    await settle(manager);
});

test("pull-up pulls first and does not up when the pull fails", async () => {
    const calls: string[] = [];
    const provider = fakeProvider({
        pull: async () => { calls.push("pull"); return { code: 1, stdout: "", stderr: "no network", timedOut: false, truncated: false }; },
        up: async () => { calls.push("up"); return ok; },
    });
    const manager = new OperationManager(new StackLocks(), provider, { timeoutMs: 1000, maxBytes: 10_000 });
    manager.start({ stack: "demo", action: "pull-up", target });
    await settle(manager);
    expect(calls).toEqual(["pull"]);
    expect(manager.forStack("demo")!.status).toBe("failed");
});

test("pull-up pulls then ups on success", async () => {
    const calls: string[] = [];
    const provider = fakeProvider({
        pull: async () => { calls.push("pull"); return ok; },
        up: async () => { calls.push("up"); return ok; },
    });
    const manager = new OperationManager(new StackLocks(), provider, { timeoutMs: 1000, maxBytes: 10_000 });
    manager.start({ stack: "demo", action: "pull-up", target });
    await settle(manager);
    expect(calls).toEqual(["pull", "up"]);
    expect(manager.forStack("demo")!.status).toBe("succeeded");
});

test("truncates oversized output", async () => {
    const provider = fakeProvider({ up: async () => ({ code: 0, stdout: "x".repeat(1000), stderr: "", timedOut: false, truncated: false }) });
    const manager = new OperationManager(new StackLocks(), provider, { timeoutMs: 1000, maxBytes: 100 });
    manager.start({ stack: "demo", action: "up", target });
    await settle(manager);
    const operation = manager.forStack("demo")!;
    expect(operation.truncated).toBe(true);
    expect(operation.output.length).toBeLessThanOrEqual(100);
});

test("refuses new operations once shutdown started", async () => {
    const manager = new OperationManager(new StackLocks(), fakeProvider(), { timeoutMs: 1000, maxBytes: 10_000 });
    await manager.shutdown(10);
    expect(() => manager.start({ stack: "demo", action: "up", target })).toThrow(OperationsDisabledError);
});

test("refuses new operations immediately on refuseNew", () => {
    const manager = new OperationManager(new StackLocks(), fakeProvider(), { timeoutMs: 1000, maxBytes: 10_000 });
    manager.refuseNew();
    expect(() => manager.start({ stack: "demo", action: "up", target })).toThrow(OperationsDisabledError);
});

test("subscribers receive live updates and unsubscribe without cancelling", async () => {
    let release!: () => void;
    const gate = new Promise<CommandResult>(resolve => { release = () => resolve(ok); });
    const manager = new OperationManager(new StackLocks(), fakeProvider({ up: () => gate }), { timeoutMs: 1000, maxBytes: 10_000 });
    const seen: string[] = [];
    const sub = manager.subscribe("demo", operation => seen.push(operation.status));
    expect(sub.snapshot).toBeNull();
    expect(manager.subscriberCount("demo")).toBe(1);
    manager.start({ stack: "demo", action: "up", target });
    release();
    await settle(manager);
    expect(seen).toContain("running");
    expect(seen).toContain("succeeded");
    // The operation finished on its own; unsubscribing only drops the observer.
    sub.unsubscribe();
    expect(manager.subscriberCount("demo")).toBe(0);
    expect(manager.forStack("demo")!.status).toBe("succeeded");
});

test("subscribe returns the current snapshot for late observers", async () => {
    const manager = new OperationManager(new StackLocks(), fakeProvider(), { timeoutMs: 1000, maxBytes: 10_000 });
    manager.start({ stack: "demo", action: "up", target });
    await settle(manager);
    const sub = manager.subscribe("demo", () => {});
    expect(sub.snapshot?.status).toBe("succeeded");
    expect(sub.snapshot?.output).toContain("done");
    sub.unsubscribe();
});

test("forwards live chunks before completion without duplicating the result", async () => {
    let resolveUp!: (result: CommandResult) => void;
    const gate = new Promise<CommandResult>(resolve => { resolveUp = resolve; });
    const provider = fakeProvider({
        up: target => {
            target.onOutput?.("pulling layer 1\n");
            target.onOutput?.("pulling layer 2\n");
            return gate;
        },
    });
    const manager = new OperationManager(new StackLocks(), provider, { timeoutMs: 1000, maxBytes: 10_000 });
    const updates: string[] = [];
    manager.subscribe("demo", operation => updates.push(operation.output));
    const started = manager.start({ stack: "demo", action: "up", target });
    // Progress is visible while the command still runs.
    expect(started.output).toContain("pulling layer 1");
    expect(updates.join("\n")).toContain("pulling layer 2");
    resolveUp(ok);
    await settle(manager);
    const final = manager.forStack("demo")!;
    expect(final.status).toBe("succeeded");
    // Streamed content supersedes the buffered result: each layer exactly once.
    expect(final.output.match(/pulling layer 1/g)!.length).toBe(1);
    expect(final.output.match(/pulling layer 2/g)!.length).toBe(1);
});

test("pull-up keeps buffered pull output alongside streamed up output", async () => {
    const pulled: CommandResult = { code: 0, stdout: "pulled", stderr: "", timedOut: false, truncated: false };
    const provider = fakeProvider({
        pull: async () => pulled,
        up: async target => {
            target.onOutput?.("starting\n");
            return ok;
        },
    });
    const manager = new OperationManager(new StackLocks(), provider, { timeoutMs: 1000, maxBytes: 10_000 });
    manager.start({ stack: "demo", action: "pull-up", target });
    await settle(manager);
    const final = manager.forStack("demo")!;
    expect(final.status).toBe("succeeded");
    expect(final.output).toContain("pulled");
    expect(final.output).toContain("starting");
    expect(final.output).toBe("pulled\nstarting\n");
});

test("preserves fragmented text and CRLF exactly", async () => {
    const provider = fakeProvider({ up: async target => {
        for (const chunk of ["hel", "lo\r", "\n", "é🙂\n"]) target.onOutput?.(chunk);
        return ok;
    } });
    const manager = new OperationManager(new StackLocks(), provider, { timeoutMs: 1000, maxBytes: 1000 });
    manager.start({ stack: "demo", action: "up", target });
    await settle(manager);
    expect(manager.forStack("demo")!.output).toBe("hello\r\né🙂\n");
});

test("retains the stack lock after unconfirmed process termination", async () => {
    const locks = new StackLocks();
    const provider = fakeProvider({ up: async () => ({ ...ok, code: -1, timedOut: true, terminationUnconfirmed: true }) });
    const manager = new OperationManager(locks, provider, { timeoutMs: 1000, maxBytes: 1000 });
    manager.start({ stack: "demo", action: "up", target });
    await settle(manager);
    expect(manager.forStack("demo")!.status).toBe("unknown");
    expect(locks.isLocked("demo")).toBe(true);
    expect(() => manager.start({ stack: "demo", action: "up", target })).toThrow(StackBusyError);
});

test("different stacks cannot mutate the same project concurrently", async () => {
    let finish!: (result: CommandResult) => void;
    const provider = fakeProvider({ up: () => new Promise(resolve => { finish = resolve; }) });
    const manager = new OperationManager(new StackLocks(), provider, { timeoutMs: 1000, maxBytes: 1000 });
    const shared = { ...target, project: "shared" };
    manager.start({ stack: "one", action: "up", target: shared });
    expect(() => manager.start({ stack: "two", action: "up", target: shared })).toThrow(StackBusyError);
    finish(ok);
    await settle(manager);
    expect(() => manager.start({ stack: "two", action: "stop", target: shared })).not.toThrow();
    await settle(manager);
});
