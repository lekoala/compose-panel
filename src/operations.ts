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
    constructor(message = "The server is shutting down; new operations are refused.") {
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
    private readonly tasks = new Set<Promise<void>>();
    private shuttingDown = false;

    constructor(
        private readonly locks: StackLocks,
        private readonly provider: ComposeProvider,
        private readonly options: OperationManagerOptions,
    ) {}

    forStack(stack: string): OperationView | null {
        return this.last.get(stack) ?? null;
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

    /** Stop accepting new operations and wait (bounded) for running ones. */
    async shutdown(graceMs: number): Promise<void> {
        this.shuttingDown = true;
        if (this.tasks.size === 0) return;
        const drained = Promise.allSettled([...this.tasks]);
        await Promise.race([drained, new Promise<void>(resolve => setTimeout(resolve, graceMs))]);
    }

    private async execute(
        operation: OperationView,
        action: OperationAction,
        target: ComposeTarget,
        release: () => void,
    ): Promise<void> {
        try {
            let result: CommandResult;
            if (action === "pull-up") {
                const pulled = await this.provider.pull(target);
                this.append(operation, pulled);
                if (pulled.code !== 0 || pulled.timedOut) {
                    this.finalize(operation, pulled);
                    return;
                }
                result = await this.provider.up(target);
            } else {
                result = await runAction(this.provider, action, target);
            }
            this.append(operation, result);
            this.finalize(operation, result);
        } catch (error) {
            operation.status = "unknown";
            operation.endedAt = Date.now();
            this.appendText(operation, error instanceof Error ? error.message : "operation failed");
        } finally {
            release();
        }
    }

    private finalize(operation: OperationView, result: CommandResult): void {
        operation.endedAt = Date.now();
        operation.exitCode = result.code;
        operation.timedOut = result.timedOut;
        // Success is only ever announced after a clean exit 0.
        if (result.timedOut) operation.status = "unknown";
        else if (result.code === 0) operation.status = "succeeded";
        else operation.status = "failed";
    }

    private append(operation: OperationView, result: CommandResult): void {
        const chunk = [result.stdout, result.stderr].filter(text => text.length > 0).join("\n");
        this.appendText(operation, chunk);
    }

    private appendText(operation: OperationView, chunk: string): void {
        if (!chunk) return;
        const combined = operation.output ? `${operation.output}\n${chunk}` : chunk;
        const buffer = Buffer.from(combined, "utf8");
        if (buffer.byteLength > this.options.maxBytes) {
            operation.truncated = true;
            operation.output = buffer.subarray(0, this.options.maxBytes).toString("utf8");
        } else {
            operation.output = combined;
        }
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
