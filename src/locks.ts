export class StackBusyError extends Error {
    constructor(message = "Another action or save is already in progress for this stack. Wait for it to finish, then try again.") {
        super(message);
        this.name = "StackBusyError";
    }
}

/**
 * In-memory lock guaranteeing a single modifying operation per stack (saves and
 * Docker mutations). The same instance is shared by the whole process.
 */
export class StackLocks {
    private readonly active = new Set<string>();

    isLocked(name: string): boolean {
        return this.active.has(name);
    }

    /**
     * Whether any stack is locked, including a lock kept on purpose after an
     * operation whose process exit could not be confirmed. Used to refuse a
     * panel self-update, whose restart would drop that guard (ADR 0018).
     */
    hasActive(): boolean {
        return this.active.size > 0;
    }

    /** Non-blocking acquire. Returns a release function, or null if already held. */
    tryAcquire(name: string): (() => void) | null {
        if (this.active.has(name)) return null;
        this.active.add(name);
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.active.delete(name);
        };
    }

    async run<T>(name: string, fn: () => Promise<T>): Promise<T> {
        const release = this.tryAcquire(name);
        if (!release) throw new StackBusyError();
        try {
            return await fn();
        } finally {
            release();
        }
    }
}
