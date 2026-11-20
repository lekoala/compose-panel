export class StackBusyError extends Error {
    constructor(message = "Another action or save is already in progress for this stack. Wait for it to finish, then try again.") {
        super(message);
        this.name = "StackBusyError";
    }
}

/**
 * Refused because global Docker maintenance holds the engine. It extends
 * StackBusyError so every existing mutation refusal path answers 409 with its
 * message instead of a generic 500.
 */
export class MaintenanceBusyError extends StackBusyError {
    constructor(message = "Docker maintenance is running. Wait for it to finish, then try again.") {
        super(message);
        this.name = "MaintenanceBusyError";
    }
}

/**
 * In-memory lock guaranteeing a single modifying operation per stack (saves and
 * Docker mutations). The same instance is shared by the whole process.
 *
 * It also owns the panel-wide engine maintenance lock (ADR 0040), which is
 * mutually exclusive with every stack mutation: a save, an operation, an app
 * action or a rollout must not overlap a prune, and a prune must not start
 * while one of them runs. Acquisition is synchronous, so the check and the
 * reservation cannot interleave.
 */
export class StackLocks {
    private readonly active = new Set<string>();
    private maintenance = false;

    isLocked(name: string): boolean {
        return this.active.has(name);
    }

    /** Whether global Docker maintenance currently holds the engine. */
    maintenanceActive(): boolean {
        return this.maintenance;
    }

    /**
     * Whether any stack is locked, including a lock kept on purpose after an
     * operation whose process exit could not be confirmed, or global
     * maintenance. Used to refuse a panel self-update, whose restart would drop
     * that guard (ADR 0018).
     */
    hasActive(): boolean {
        return this.maintenance || this.active.size > 0;
    }

    /** Non-blocking acquire. Returns a release function, or null if already held. */
    tryAcquire(name: string): (() => void) | null {
        if (this.maintenance || this.active.has(name)) return null;
        this.active.add(name);
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.active.delete(name);
        };
    }

    /**
     * Non-blocking acquire of the single maintenance slot. Refused while any
     * stack is locked, so pruning can never race a pull, up, save, app action
     * or rollout.
     */
    tryAcquireMaintenance(): (() => void) | null {
        if (this.maintenance || this.active.size > 0) return null;
        this.maintenance = true;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.maintenance = false;
        };
    }

    async run<T>(name: string, fn: () => Promise<T>): Promise<T> {
        const release = this.tryAcquire(name);
        if (!release) {
            throw this.maintenance ? new MaintenanceBusyError() : new StackBusyError();
        }
        try {
            return await fn();
        } finally {
            release();
        }
    }
}
