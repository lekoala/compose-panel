import { composeEnvironment, type CommandResult, type DockerRunner } from "./docker.ts";
import type { StackLocks } from "./locks.ts";
import { MaintenanceBusyError } from "./locks.ts";
import { maintenanceArgv, parseReclaimedBytes, type MaintenanceScope } from "./maintenance.ts";

export type MaintenanceStatus = "running" | "succeeded" | "failed" | "unknown";

/** In-memory record of the last maintenance run. No persistence, no replay. */
export interface MaintenanceView {
    scope: MaintenanceScope;
    status: MaintenanceStatus;
    startedAt: number;
    endedAt: number | null;
    exitCode: number | null;
    timedOut: boolean;
    truncated: boolean;
    /** Best effort only: null when Docker's summary line was absent or cut. */
    reclaimedBytes: number | null;
    /** Bounded command output for display. Never written to the audit log. */
    output: string;
}

export class MaintenanceDisabledError extends Error {
    constructor(message = "The panel is shutting down and no longer accepts maintenance actions.") {
        super(message);
        this.name = "MaintenanceDisabledError";
    }
}

export interface HostMaintenanceOptions {
    timeoutMs: number;
    maxBytes: number;
    /** Called once when the run reaches a final status (e.g. for the audit log). */
    onFinish?: (view: MaintenanceView) => void;
}

/**
 * One global Docker storage prune at a time (ADR 0040), tied to the server
 * lifetime and not to any client: the command keeps running after the browser
 * disconnects, its outcome is kept in memory, and nothing is replayed after a
 * crash. No SSE channel: the page is refreshed by the administrator.
 *
 * The engine is held through `StackLocks.tryAcquireMaintenance`, which refuses
 * every stack mutation for the duration. An exit Docker could not confirm
 * (`terminationUnconfirmed`) is reported as unknown and keeps the lock.
 */
export class HostMaintenance {
    private current: MaintenanceView | null = null;
    private task: Promise<void> | null = null;
    private disabled = false;

    constructor(
        private readonly locks: StackLocks,
        private readonly runner: DockerRunner,
        private readonly options: HostMaintenanceOptions,
    ) {}

    last(): MaintenanceView | null {
        return this.current;
    }

    isRunning(): boolean {
        return this.current?.status === "running";
    }

    /**
     * Reserve the engine and start the command. Throws synchronously when the
     * engine is held by a stack mutation or by another maintenance run, so the
     * HTTP handler can answer before any Docker call is made.
     */
    start(scope: MaintenanceScope): MaintenanceView {
        if (this.disabled) throw new MaintenanceDisabledError();
        const release = this.locks.tryAcquireMaintenance();
        if (!release) throw new MaintenanceBusyError();
        const view: MaintenanceView = {
            scope,
            status: "running",
            startedAt: Date.now(),
            endedAt: null,
            exitCode: null,
            timedOut: false,
            truncated: false,
            reclaimedBytes: null,
            output: "",
        };
        this.current = view;
        let released = false;
        const releaseOnce = () => {
            if (released) return;
            released = true;
            release();
        };
        const task = this.execute(view, releaseOnce);
        this.task = task;
        void task.finally(() => {
            if (this.task === task) this.task = null;
        });
        return view;
    }

    /** Refuse new maintenance synchronously. A running one keeps going. */
    refuseNew(): void {
        this.disabled = true;
    }

    /** Stop accepting new maintenance and wait (bounded) for the current run. */
    async shutdown(graceMs: number): Promise<void> {
        this.refuseNew();
        if (!this.task) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                this.task,
                new Promise<void>((resolve) => {
                    timer = setTimeout(resolve, graceMs);
                }),
            ]);
        } finally {
            clearTimeout(timer);
        }
    }

    private async execute(view: MaintenanceView, release: () => void): Promise<void> {
        try {
            const result: CommandResult = await this.runner(maintenanceArgv(view.scope), {
                timeoutMs: this.options.timeoutMs,
                maxBytes: this.options.maxBytes,
                // Pin the default builder: with Buildx installed, `builder prune`
                // otherwise follows BUILDX_BUILDER or the current builder, which
                // may be a remote BuildKit. `default` is the local docker driver,
                // and the legacy CLI ignores the variable.
                env: { ...composeEnvironment(), BUILDX_BUILDER: "default" },
            });
            this.finalize(view, result);
            // Same rule as a stack mutation: keep the engine locked when the
            // process exit could not be confirmed, so nothing overlaps it.
            if (!result.terminationUnconfirmed) release();
        } catch (error) {
            view.status = "unknown";
            view.endedAt = Date.now();
            const cut = bound(error instanceof Error ? error.message : "maintenance failed", this.options.maxBytes);
            view.output = cut.text;
            view.truncated ||= cut.truncated;
            release();
        } finally {
            this.report(view);
        }
    }

    private finalize(view: MaintenanceView, result: CommandResult): void {
        const combined = [result.stdout, result.stderr].filter((text) => text.length > 0).join("\n");
        const cut = bound(combined, this.options.maxBytes);
        view.endedAt = Date.now();
        view.exitCode = result.code;
        view.timedOut = result.timedOut;
        view.truncated = result.truncated || cut.truncated;
        view.output = cut.text;
        // Docker's own summary is best effort; a truncated tail simply yields null.
        view.reclaimedBytes = parseReclaimedBytes(result.stdout);
        // Success is only announced after a clean exit 0.
        if (result.timedOut || result.terminationUnconfirmed) view.status = "unknown";
        else if (result.code === 0) view.status = "succeeded";
        else view.status = "failed";
    }

    private report(view: MaintenanceView): void {
        if (!this.options.onFinish) return;
        try {
            this.options.onFinish(view);
        } catch {
            /* recording must not fail the run */
        }
    }
}

/** Byte-capped, UTF-8-safe display text. */
function bound(text: string, maxBytes: number): { text: string; truncated: boolean } {
    if (!text) return { text: "", truncated: false };
    const bytes = Buffer.from(text, "utf8");
    if (bytes.byteLength <= maxBytes) return { text, truncated: false };
    return { text: new TextDecoder().decode(bytes.subarray(0, maxBytes), { stream: true }), truncated: true };
}
