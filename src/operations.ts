import { randomSuffix } from "./fs-safe.ts";
import type { CommandResult } from "./docker.ts";
import type { ComposeProvider, ComposeTarget } from "./compose-provider.ts";
import { StackLocks, StackBusyError } from "./locks.ts";

export const OPERATION_ACTIONS = ["up", "stop", "restart", "down", "pull-up"] as const;
export type OperationAction = typeof OPERATION_ACTIONS[number];

export function isOperationAction(value: string): value is OperationAction {
    return (OPERATION_ACTIONS as readonly string[]).includes(value);
}

export type OperationStatus = "running" | "succeeded" | "failed" | "unknown";

export interface OperationView {
    id: string;
    stack: string;
    action: OperationAction;
    status: OperationStatus;
    startedAt: number;
    endedAt: number | null;
    exitCode: number | null;
    output: string;
    truncated: boolean;
    timedOut: boolean;
}

export class OperationsDisabledError extends Error {
    constructor(message = "The panel is shutting down and no longer accepts new actions or saves.") {
        super(message);
        this.name = "OperationsDisabledError";
    }
}

export interface OperationManagerOptions {
    timeoutMs: number;
    maxBytes: number;
}

/**
 * In-memory operation manager. One mutation per stack, tied to the server
 * lifetime, not to any client: an operation keeps running after the browser
 * disconnects. There is no persistence and no automatic replay after a crash.
 */
export class OperationManager {
    private readonly last = new Map<string, OperationView>();
    private readonly listeners = new Map<string, Set<(operation: OperationView) => void>>();
    private readonly tasks = new Set<Promise<void>>();
    private readonly projects = new Set<string>();
    private shuttingDown = false;

    constructor(
        private readonly locks: StackLocks,
        private readonly provider: ComposeProvider,
        private readonly options: OperationManagerOptions,
    ) {}

    forStack(stack: string): OperationView | null {
        return this.last.get(stack) ?? null;
    }

    /**
     * Subscribe to live updates of a stack's last operation. The listener is
     * observation-only: unsubscribing never cancels the running operation.
     * Returns the current snapshot plus an unsubscribe function.
     */
    subscribe(stack: string, listener: (operation: OperationView) => void): { snapshot: OperationView | null; unsubscribe: () => void } {
        let set = this.listeners.get(stack);
        if (!set) {
            set = new Set();
            this.listeners.set(stack, set);
        }
        set.add(listener);
        let done = false;
        return {
            snapshot: this.last.get(stack) ?? null,
            unsubscribe: () => {
                if (done) return;
                done = true;
                set.delete(listener);
                if (set.size === 0) this.listeners.delete(stack);
            },
        };
    }

    subscriberCount(stack: string): number {
        return this.listeners.get(stack)?.size ?? 0;
    }

    isRunning(stack: string): boolean {
        return this.last.get(stack)?.status === "running";
    }

    activeCount(): number {
        return this.tasks.size;
    }

    start(input: { stack: string; action: OperationAction; target: ComposeTarget }): OperationView {
        if (this.shuttingDown) throw new OperationsDisabledError();
        const release = this.locks.tryAcquire(input.stack);
        if (!release) throw new StackBusyError();
        if (input.target.project && this.projects.has(input.target.project)) {
            release();
            throw new StackBusyError("Another action is already running for the same Compose project. Wait for it to finish, then try again.");
        }
        if (input.target.project) this.projects.add(input.target.project);

        const operation: OperationView = {
            id: randomSuffix(),
            stack: input.stack,
            action: input.action,
            status: "running",
            startedAt: Date.now(),
            endedAt: null,
            exitCode: null,
            output: "",
            truncated: false,
            timedOut: false,
        };
        this.last.set(input.stack, operation);

        const target: ComposeTarget = {
            ...input.target,
            timeoutMs: this.options.timeoutMs,
            maxBytes: this.options.maxBytes,
        };
        const task = this.execute(operation, input.action, target, release);
        this.tasks.add(task);
        void task.finally(() => this.tasks.delete(task));
        return operation;
    }

    /** Refuse new operations synchronously. Running ones keep going. */
    refuseNew(): void {
        this.shuttingDown = true;
    }

    /** Stop accepting new operations and wait (bounded) for running ones. */
    async shutdown(graceMs: number): Promise<void> {
        this.refuseNew();
        if (this.tasks.size === 0) return;
        const drained = Promise.allSettled([...this.tasks]);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([drained, new Promise<void>(resolve => { timer = setTimeout(resolve, graceMs); })]);
        } finally { clearTimeout(timer); }
    }

    private async execute(
        operation: OperationView,
        action: OperationAction,
        target: ComposeTarget,
        release: () => void,
    ): Promise<void> {
        // Live pipe chunks land here while the command runs. When any flowed
        // for a call, the retained output is already complete and the bulk
        // append for that call is skipped (it would duplicate). Buffered
        // providers that ignore onOutput keep the old append path. The flag
        // resets per call so a streamed pull never masks a buffered up.
        let live = false;
        let terminationUnconfirmed = false;
        const streaming: ComposeTarget = {
            ...target,
            onOutput: chunk => {
                live = true;
                this.appendText(operation, chunk);
            },
        };
        const runStreamed = async (call: (target: ComposeTarget) => Promise<CommandResult>): Promise<CommandResult> => {
            live = false;
            // This separator belongs between commands (pull then up), never
            // between arbitrary fragments of one command's pipe output.
            if (operation.output && !operation.output.endsWith("\n")) this.appendText(operation, "\n");
            const result = await call(streaming);
            terminationUnconfirmed ||= result.terminationUnconfirmed === true;
            if (!live) this.append(operation, result);
            return result;
        };
        try {
            let result: CommandResult;
            if (action === "pull-up") {
                const pulled = await runStreamed(target => this.provider.pull(target));
                if (pulled.code !== 0 || pulled.timedOut) {
                    this.finalize(operation, pulled);
                    return;
                }
                result = await runStreamed(target => this.provider.up(target));
            } else {
                result = await runStreamed(target => runAction(this.provider, action, target));
            }
            this.finalize(operation, result);
        } catch (error) {
            operation.status = "unknown";
            operation.endedAt = Date.now();
            this.appendText(operation, error instanceof Error ? error.message : "operation failed");
            this.emit(operation);
        } finally {
            // Do not allow another mutation to overlap an unconfirmed child.
            // The UI reports unknown; restarting loses this in-memory lock.
            if (!terminationUnconfirmed) {
                if (target.project) this.projects.delete(target.project);
                release();
            }
        }
    }

    private emit(operation: OperationView): void {
        const set = this.listeners.get(operation.stack);
        if (!set || set.size === 0) return;
        for (const listener of [...set]) {
            try { listener(operation); }
            catch { /* a slow/broken observer must not fail the operation */ }
        }
    }

    private finalize(operation: OperationView, result: CommandResult): void {
        operation.endedAt = Date.now();
        operation.exitCode = result.code;
        operation.timedOut = result.timedOut;
        // Success is only ever announced after a clean exit 0.
        if (result.timedOut || result.terminationUnconfirmed) operation.status = "unknown";
        else if (result.code === 0) operation.status = "succeeded";
        else operation.status = "failed";
        this.emit(operation);
    }

    private append(operation: OperationView, result: CommandResult): void {
        const chunk = [result.stdout, result.stderr].filter(text => text.length > 0).join("\n");
        this.appendText(operation, chunk);
        operation.truncated ||= result.truncated;
    }

    private appendText(operation: OperationView, chunk: string): void {
        if (!chunk || operation.truncated) return;
        const combined = operation.output + chunk;
        const buffer = Buffer.from(combined, "utf8");
        if (buffer.byteLength > this.options.maxBytes) {
            operation.truncated = true;
            operation.output = new TextDecoder().decode(buffer.subarray(0, this.options.maxBytes), { stream: true });
        } else {
            operation.output = combined;
        }
        this.emit(operation);
    }
}

function runAction(provider: ComposeProvider, action: Exclude<OperationAction, "pull-up">, target: ComposeTarget): Promise<CommandResult> {
    switch (action) {
        case "up": return provider.up(target);
        case "stop": return provider.stop(target);
        case "restart": return provider.restart(target);
        case "down": return provider.down(target);
    }
}
