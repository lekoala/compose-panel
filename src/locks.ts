export class StackBusyError extends Error {
    constructor(message = "Another operation is already running for this stack.") {
        super(message);
        this.name = "StackBusyError";
    }
}

/**
 * In-memory lock guaranteeing a single modifying operation per stack (saves and,
 * later, Docker mutations). The same instance is shared by the whole process.
 */
export class StackLocks {
    private readonly active = new Set<string>();

    isLocked(name: string): boolean {
        return this.active.has(name);
    }

    async run<T>(name: string, fn: () => Promise<T>): Promise<T> {
        if (this.active.has(name)) throw new StackBusyError();
        this.active.add(name);
        try {
            return await fn();
        } finally {
            this.active.delete(name);
        }
    }
}
