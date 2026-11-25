import { randomSuffix } from "./fs-safe.ts";
import type { CommandResult } from "./docker.ts";
import type { ComposeProvider, ComposeTarget } from "./compose-provider.ts";
import { StackLocks, MaintenanceBusyError, StackBusyError } from "./locks.ts";

export const OPERATION_ACTIONS = ["up", "pull", "stop", "start", "restart", "down", "pull-up"] as const;
export type OperationAction = (typeof OPERATION_ACTIONS)[number];

export function isOperationAction(value: string): value is OperationAction {
    return (OPERATION_ACTIONS as readonly string[]).includes(value);
}

export type OperationStatus = "running" | "succeeded" | "failed" | "unknown" | "refused" | "intervention";

/** A declared app action either produces a command result or is refused before running. */
export type AppActionOutcome = CommandResult | { refused: string } | { intervention: string };

export interface OperationView {
    id: string;
    stack: string;
    /** Compose action, or the application script name for a toolbox action. */
    action: string;
    /** Human label for display (compose action name, or the declared label). */
    label: string;
    /** Service the action was scoped to, if any (ADR 0021). */
    service?: string;
    /** Application toolbox source id, when this is a declared app action. */
    source?: string;
    /** Application toolbox script name, when this is a declared app action. */
    script?: string;
    /** Pinned container the app action ran in, for the audit record. */
    containerId?: string;
    /** Image ID of that container, for the audit record. */
    imageId?: string;
    /** Catalog revision revalidated under the lock, for the audit record. */
    revision?: string;
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
    /**
     * Called when an operation is accepted and holds its stack lock, before
     * anything runs (e.g. to drop a remote image check that can no longer
     * describe the stack).
     */
    onBegin?: (stack: string) => void;
    /** Called once when an operation reaches its final status (e.g. for the audit log). */
    onFinish?: (operation: OperationView) => void;
    /**
     * Authoritative admission check, run after the per-stack lock and project
     * reservation are held and before any command or app closure. A non-null
     * reason refuses the operation. This closes the race where a route-level
     * check passes, the request awaits Docker, and a deploy leaves a pending
     * marker before the lock is acquired.
     */
    admit?: (stack: string, action: string) => Promise<string | null>;
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
        const { operation, release } = this.begin({
            stack: input.stack,
            action: input.action,
            label: input.action,
            service: input.target.service,
            project: input.target.project,
        });

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

    /**
     * Run a declared, non-interactive application action (ADR 0026). The `run`
     * closure performs the container resolution, the manifest re-read and the
     * exec; it is invoked from inside the operation, after the per-stack lock is
     * held, so validation and execution share the same critical section. It may
     * call `record` with the identity it actually resolved, so the final audit
     * line names the exact definition that ran.
     */
    startApp(input: {
        stack: string;
        source: string;
        script: string;
        label: string;
        project?: string;
        run: (context: {
            onOutput: (chunk: string) => void;
            record: (detail: { containerId?: string; imageId?: string; revision?: string }) => void;
        }) => Promise<AppActionOutcome>;
    }): OperationView {
        const { operation, release } = this.begin({
            stack: input.stack,
            action: input.script,
            label: input.label,
            source: input.source,
            script: input.script,
            project: input.project,
        });
        const task = this.executeApp(operation, input.run, release, input.project);
        this.tasks.add(task);
        void task.finally(() => this.tasks.delete(task));
        return operation;
    }

    /**
     * Run an opt-in service rollout (ADR 0035). The lock, project reservation,
     * streaming and finalize semantics are the same as any other operation;
     * the `run` closure performs the locked revalidation and the phase machine.
     */
    startRollout(input: {
        stack: string;
        service: string;
        project?: string;
        run: (context: {
            onOutput: (chunk: string) => void;
            record: (detail: { containerId?: string; imageId?: string; revision?: string }) => void;
        }) => Promise<AppActionOutcome>;
    }): OperationView {
        const { operation, release } = this.begin({
            stack: input.stack,
            action: "rollout",
            label: "Rollout",
            service: input.service,
            project: input.project,
        });
        const task = this.executeApp(operation, input.run, release, input.project);
        this.tasks.add(task);
        void task.finally(() => this.tasks.delete(task));
        return operation;
    }

    /**
     * Run one manual offsite backup (ADR 0049). It holds the stack lock and
     * streams like any other operation; the `run` closure stages, dumps and
     * uploads. It is not a Compose action.
     */
    startBackup(input: {
        stack: string;
        project?: string;
        run: (context: {
            onOutput: (chunk: string) => void;
            record: (detail: { containerId?: string; imageId?: string; revision?: string }) => void;
        }) => Promise<AppActionOutcome>;
    }): OperationView {
        const { operation, release } = this.begin({
            stack: input.stack,
            action: "backup",
            label: "Backup",
            project: input.project,
        });
        const task = this.executeApp(operation, input.run, release, input.project);
        this.tasks.add(task);
        void task.finally(() => this.tasks.delete(task));
        return operation;
    }

    /**
     * Run one verified restore (ADR 0049). It holds the stack lock, but it never
     * writes to the live site: the snapshot goes to a private directory and a
     * disposable database.
     */
    startRestore(input: {
        stack: string;
        project?: string;
        run: (context: {
            onOutput: (chunk: string) => void;
            record: (detail: { containerId?: string; imageId?: string; revision?: string }) => void;
        }) => Promise<AppActionOutcome>;
    }): OperationView {
        const { operation, release } = this.begin({
            stack: input.stack,
            action: "restore",
            label: "Restore",
            project: input.project,
        });
        const task = this.executeApp(operation, input.run, release, input.project);
        this.tasks.add(task);
        void task.finally(() => this.tasks.delete(task));
        return operation;
    }

    /**
     * Measure one declared retention policy (ADR 0052). It holds the stack lock
     * like a backup, but it is read-only: the run closure asks Restic for a
     * dry-run, and the panel deletes nothing.
     */
    startRetentionPreview(input: {
        stack: string;
        project?: string;
        run: (context: {
            onOutput: (chunk: string) => void;
            record: (detail: { containerId?: string; imageId?: string; revision?: string }) => void;
        }) => Promise<AppActionOutcome>;
    }): OperationView {
        const { operation, release } = this.begin({
            stack: input.stack,
            action: "retention-preview",
            label: "Retention preview",
            project: input.project,
        });
        const task = this.executeApp(operation, input.run, release, input.project);
        this.tasks.add(task);
        void task.finally(() => this.tasks.delete(task));
        return operation;
    }

    /**
     * Check one backup repository (ADR 0054). It holds the stack lock so no
     * upload adds packs mid-check, but it is read-only: the run closure asks
     * Restic to check and the panel repairs, deletes and stores nothing.
     */
    startRepositoryCheck(input: {
        stack: string;
        project?: string;
        run: (context: {
            onOutput: (chunk: string) => void;
            record: (detail: { containerId?: string; imageId?: string; revision?: string }) => void;
        }) => Promise<AppActionOutcome>;
    }): OperationView {
        const { operation, release } = this.begin({
            stack: input.stack,
            action: "repository-check",
            label: "Repository check",
            project: input.project,
        });
        const task = this.executeApp(operation, input.run, release, input.project);
        this.tasks.add(task);
        void task.finally(() => this.tasks.delete(task));
        return operation;
    }

    /** Whether shutdown has begun; a running rollout uses it between phases. */
    isShuttingDown(): boolean {
        return this.shuttingDown;
    }

    private async admissionRefusal(stack: string, action: string): Promise<string | null> {
        if (!this.options.admit) return null;
        try {
            return await this.options.admit(stack, action);
        } catch {
            return "The pending state of this stack could not be checked, so nothing was run.";
        }
    }

    /**
     * Run one managed-site deploy (ADR 0043). The lock, project reservation,
     * streaming and finalize semantics are the same as any other operation; the
     * `run` closure performs the locked revalidation, the fetch/publish and the
     * activation phase machine.
     */
    startDeploy(input: {
        stack: string;
        project?: string;
        run: (context: {
            onOutput: (chunk: string) => void;
            record: (detail: { containerId?: string; imageId?: string; revision?: string }) => void;
        }) => Promise<AppActionOutcome>;
    }): OperationView {
        const { operation, release } = this.begin({
            stack: input.stack,
            action: "deploy",
            label: "Deploy",
            project: input.project,
        });
        const task = this.executeApp(operation, input.run, release, input.project);
        this.tasks.add(task);
        void task.finally(() => this.tasks.delete(task));
        return operation;
    }

    /**
     * Publish the first release of a managed site (ADR 0042). It uses the same
     * lock, admission and streaming rules as a deploy, but it never touches a
     * container: there is no serving state to stop or roll back.
     */
    startBaseline(input: {
        stack: string;
        project?: string;
        run: (context: {
            onOutput: (chunk: string) => void;
            record: (detail: { containerId?: string; imageId?: string; revision?: string }) => void;
        }) => Promise<AppActionOutcome>;
    }): OperationView {
        const { operation, release } = this.begin({
            stack: input.stack,
            action: "baseline",
            label: "Publish baseline",
            project: input.project,
        });
        const task = this.executeApp(operation, input.run, release, input.project);
        this.tasks.add(task);
        void task.finally(() => this.tasks.delete(task));
        return operation;
    }

    /** Shared acquisition: per-stack lock, project reservation, operation record. */
    private begin(input: {
        stack: string;
        action: string;
        label: string;
        service?: string;
        source?: string;
        script?: string;
        project?: string;
    }): { operation: OperationView; release: () => void } {
        if (this.shuttingDown) throw new OperationsDisabledError();
        const release = this.locks.tryAcquire(input.stack);
        if (!release) {
            throw this.locks.maintenanceActive() ? new MaintenanceBusyError() : new StackBusyError();
        }
        if (input.project && this.projects.has(input.project)) {
            release();
            throw new StackBusyError(
                "Another action is already running for the same Compose project. Wait for it to finish, then try again.",
            );
        }
        if (input.project) this.projects.add(input.project);

        try {
            this.options.onBegin?.(input.stack);
        } catch {
            /* a bookkeeping hook must not refuse an accepted operation */
        }

        const operation: OperationView = {
            id: randomSuffix(),
            stack: input.stack,
            action: input.action,
            label: input.label,
            service: input.service,
            source: input.source,
            script: input.script,
            status: "running",
            startedAt: Date.now(),
            endedAt: null,
            exitCode: null,
            output: "",
            truncated: false,
            timedOut: false,
        };
        this.last.set(input.stack, operation);
        return { operation, release };
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
            await Promise.race([
                drained,
                new Promise<void>((resolve) => {
                    timer = setTimeout(resolve, graceMs);
                }),
            ]);
        } finally {
            clearTimeout(timer);
        }
    }

    private async execute(operation: OperationView, action: OperationAction, target: ComposeTarget, release: () => void): Promise<void> {
        // The route-level check cannot see a marker that appears while the
        // request awaits Docker; this one runs under the lock. Without a
        // configured hook the command starts exactly as before (no extra tick).
        if (this.options.admit) {
            const admission = await this.admissionRefusal(operation.stack, action);
            if (admission) {
                operation.status = "refused";
                operation.endedAt = Date.now();
                this.appendText(operation, admission);
                this.emit(operation);
                if (target.project) this.projects.delete(target.project);
                release();
                return;
            }
        }
        // Live pipe chunks land here while the command runs. When any flowed
        // for a call, the retained output is already complete and the bulk
        // append for that call is skipped (it would duplicate). Buffered
        // providers that ignore onOutput keep the old append path. The flag
        // resets per call so a streamed pull never masks a buffered up.
        let live = false;
        let terminationUnconfirmed = false;
        const streaming: ComposeTarget = {
            ...target,
            onOutput: (chunk) => {
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
                const pulled = await runStreamed((target) => this.provider.pull(target));
                if (pulled.code !== 0 || pulled.timedOut) {
                    this.finalize(operation, pulled);
                    return;
                }
                result = await runStreamed((target) => this.provider.up(target));
            } else {
                result = await runStreamed((target) => runAction(this.provider, action, target));
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

    /**
     * Runs a single app-action command. The caller's closure owns the Docker
     * work (resolution, manifest re-read, exec); this method only streams,
     * finalizes and releases the lock, keeping the same lock/unknown semantics
     * as a Compose operation.
     */
    private async executeApp(
        operation: OperationView,
        run: (context: {
            onOutput: (chunk: string) => void;
            record: (detail: { containerId?: string; imageId?: string; revision?: string }) => void;
        }) => Promise<AppActionOutcome>,
        release: () => void,
        project: string | undefined,
    ): Promise<void> {
        let live = false;
        // Same rule as a Compose mutation: the lock is kept only when the process
        // exit could not be confirmed. A timeout whose termination is confirmed
        // releases the lock; the operation is still reported as unknown, because
        // the work inside the container may continue.
        let hold = false;
        const onOutput = (chunk: string) => {
            live = true;
            this.appendText(operation, chunk);
        };
        const record = (detail: { containerId?: string; imageId?: string; revision?: string }) => {
            if (detail.containerId) operation.containerId = detail.containerId;
            if (detail.imageId) operation.imageId = detail.imageId;
            if (detail.revision) operation.revision = detail.revision;
        };
        try {
            if (this.options.admit) {
                const admission = await this.admissionRefusal(operation.stack, operation.action);
                if (admission) {
                    operation.status = "refused";
                    operation.endedAt = Date.now();
                    this.appendText(operation, admission);
                    this.emit(operation);
                    return;
                }
            }
            const outcome = await run({ onOutput, record });
            if ("refused" in outcome) {
                // Nothing ran: the locked revalidation found a changed declaration.
                // Append while still "running" (no final notification yet), then set
                // the terminal status and notify exactly once.
                this.appendText(operation, outcome.refused);
                operation.status = "refused";
                operation.endedAt = Date.now();
                this.emit(operation);
                return;
            }
            if ("intervention" in outcome) {
                // The rollout reached an irreversible phase and refused to remove
                // anything automatically. The operator must inspect Docker.
                if (!live) this.appendText(operation, outcome.intervention);
                operation.status = "intervention";
                operation.endedAt = Date.now();
                this.emit(operation);
                return;
            }
            hold = outcome.terminationUnconfirmed === true;
            if (!live) this.append(operation, outcome);
            this.finalize(operation, outcome);
        } catch (error) {
            operation.status = "unknown";
            operation.endedAt = Date.now();
            this.appendText(operation, error instanceof Error ? error.message : "action failed");
            this.emit(operation);
        } finally {
            if (!hold) {
                if (project) this.projects.delete(project);
                release();
            }
        }
    }

    private emit(operation: OperationView): void {
        if (operation.status !== "running" && this.options.onFinish) {
            try {
                this.options.onFinish(operation);
            } catch {
                /* recording must not fail the operation */
            }
        }
        const set = this.listeners.get(operation.stack);
        if (!set || set.size === 0) return;
        for (const listener of [...set]) {
            try {
                listener(operation);
            } catch {
                /* a slow/broken observer must not fail the operation */
            }
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
        const chunk = [result.stdout, result.stderr].filter((text) => text.length > 0).join("\n");
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
        case "up":
            return provider.up(target);
        case "pull":
            return provider.pull(target);
        case "stop":
            return provider.stop(target);
        case "start":
            return provider.start(target);
        case "restart":
            return provider.restart(target);
        case "down":
            return provider.down(target);
    }
}
