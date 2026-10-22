import type { ComposeProvider, ComposeTarget } from "./compose-provider.ts";
import { StackError } from "./stacks.ts";

export interface LogManagerOptions {
    tailLines: number;
    maxBytes: number;
    timeoutMs: number;
}

export interface LogSnapshot {
    text: string;
    truncated: boolean;
}

interface LogStream {
    stack: string;
    /** Stream identity: one subprocess per (stack, service, tailLines). */
    key: string;
    target: ComposeTarget;
    buffer: string;
    truncated: boolean;
    listeners: Set<(chunk: string) => void>;
    endListeners: Set<(reason: "ended" | "timeout") => void>;
    controller: AbortController;
    timer: ReturnType<typeof setTimeout>;
    done: Promise<void>;
    ended: boolean;
    settled: boolean;
}

/** At most two live selections per stack: identical selections share one. */
const MAX_STREAMS_PER_STACK = 2;

/** Strip ANSI color escapes so the browser shows strictly textual output. */
export function stripAnsi(text: string): string {
    return text.replace(new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g"), "");
}

/**
 * Reference-counted `compose logs --follow` streams, one subprocess per
 * (stack, service, tailLines) selection at most (two selections per stack).
 * Attaching never starts a second process for the same selection; a subprocess
 * is killed when its last reader leaves or when the explicit timeout fires.
 * Closing the browser only stops observation of operations, but for logs the
 * follow subprocess exists solely for its readers, so the last unsubscribe
 * stops it.
 */
export class LogManager {
    private readonly streams = new Map<string, LogStream>();
    private refusing = false;

    constructor(
        private readonly provider: ComposeProvider,
        private readonly options: LogManagerOptions,
    ) {}

    private static keyOf(stack: string, target: ComposeTarget & { tailLines?: number }, fallbackTail: number): string {
        return `${stack}\n${target.service ?? ""}\n${target.tailLines ?? fallbackTail}`;
    }

    private liveOf(stack: string): LogStream[] {
        return [...this.streams.values()].filter((stream) => stream.stack === stack && !stream.ended);
    }

    /** Refuse new subscriptions synchronously. Existing readers keep going. */
    refuseNew(): void {
        this.refusing = true;
    }

    isActive(stack: string): boolean {
        return this.liveOf(stack).length > 0;
    }

    subscriberCount(): number {
        let total = 0;
        for (const stream of this.streams.values()) total += stream.listeners.size;
        return total;
    }

    subscribersOf(stack: string): number {
        return this.liveOf(stack).reduce((total, stream) => total + stream.listeners.size, 0);
    }

    subscribe(
        stack: string,
        target: ComposeTarget & { tailLines?: number },
        listener: (chunk: string) => void,
        onEnd: (reason: "ended" | "timeout") => void,
    ): { replay: LogSnapshot; unsubscribe: () => void } {
        if (this.refusing) throw new StackError("The panel is shutting down and no longer starts log streams.", 503);
        const key = LogManager.keyOf(stack, target, this.options.tailLines);
        let stream = this.streams.get(key);
        if (stream?.ended) throw new StackError("The previous log stream is still closing. Try again in a few seconds.", 409);
        if (!stream) {
            if (this.liveOf(stack).length >= MAX_STREAMS_PER_STACK) {
                throw new StackError(
                    "Too many log selections are followed at once for this stack. Stop one before following another.",
                    409,
                );
            }
            stream = this.start(stack, key, target);
            this.streams.set(key, stream);
        }
        // Capture the instance: a later replacement must not receive this
        // reader's unsubscribe, and this reader must not stop the replacement.
        const owned = stream;
        owned.listeners.add(listener);
        owned.endListeners.add(onEnd);
        const replay: LogSnapshot = { text: owned.buffer, truncated: owned.truncated };
        let done = false;
        return {
            replay,
            unsubscribe: () => {
                if (done) return;
                done = true;
                owned.listeners.delete(listener);
                owned.endListeners.delete(onEnd);
                if (this.streams.get(key) === owned && owned.listeners.size === 0) {
                    this.stop(owned, "ended");
                }
            },
        };
    }

    /**
     * Abort every follow and wait for confirmation, bounded. Late provider
     * completions are dropped by instance check; stopped entries remain owned
     * until exit is confirmed, preventing overlapping replacement processes.
     */
    async shutdown(graceMs: number): Promise<void> {
        this.refuseNew();
        const pending = [...this.streams.values()].map((stream) => stream.done);
        for (const stream of this.streams.values()) this.stop(stream, "ended");
        if (pending.length === 0) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                Promise.allSettled(pending),
                new Promise<void>((resolve) => {
                    timer = setTimeout(resolve, graceMs);
                }),
            ]);
        } finally {
            clearTimeout(timer);
        }
    }

    private start(stack: string, key: string, target: ComposeTarget & { tailLines?: number }): LogStream {
        const controller = new AbortController();
        const stream: LogStream = {
            stack,
            key,
            target,
            buffer: "",
            truncated: false,
            listeners: new Set(),
            endListeners: new Set(),
            controller,
            timer: setTimeout(() => this.stop(stream, "timeout"), this.options.timeoutMs),
            done: Promise.resolve(),
            ended: false,
            settled: false,
        };
        const fullTarget = { ...target, tailLines: target.tailLines ?? this.options.tailLines };
        stream.done = this.provider
            .followLogs(fullTarget, (chunk) => this.ingest(stream, chunk), controller.signal)
            .then(
                (result) => {
                    stream.settled = !result.terminationUnconfirmed;
                    this.finish(stream, "ended");
                    if (stream.settled && this.streams.get(key) === stream) this.streams.delete(key);
                },
                () => {
                    // Rejection cannot prove that a spawned child exited.
                    this.finish(stream, "ended");
                },
            );
        return stream;
    }

    private ingest(stream: LogStream, raw: string): void {
        if (stream.ended) return;
        const chunk = stripAnsi(raw);
        if (!chunk) return;
        const combined = stream.buffer ? `${stream.buffer}${chunk}` : chunk;
        const bytes = Buffer.from(combined, "utf8");
        if (bytes.byteLength > this.options.maxBytes) {
            stream.truncated = true;
            // Keep the tail: recent log lines matter more than the head.
            stream.buffer = bytes.subarray(bytes.byteLength - this.options.maxBytes).toString("utf8");
        } else {
            stream.buffer = combined;
        }
        for (const listener of [...stream.listeners]) {
            try {
                listener(chunk);
            } catch {
                /* a broken observer must not fail the stream */
            }
        }
    }

    private finish(stream: LogStream, reason: "ended" | "timeout"): void {
        if (stream.ended) return;
        stream.ended = true;
        clearTimeout(stream.timer);
        for (const listener of [...stream.endListeners]) {
            try {
                listener(reason);
            } catch {
                /* ignore */
            }
        }
        // Only remove our own entry: a replacement started after us keeps
        // running under the same key.
        if (stream.settled && this.streams.get(stream.key) === stream) this.streams.delete(stream.key);
    }

    private stop(stream: LogStream, reason: "ended" | "timeout"): void {
        if (stream.ended) return;
        try {
            stream.controller.abort();
        } catch {
            /* already aborted */
        }
        this.finish(stream, reason);
    }
}
