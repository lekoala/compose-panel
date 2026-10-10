import type { ComposeProvider, ComposeTarget } from "./compose-provider.ts";

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
    target: ComposeTarget;
    buffer: string;
    truncated: boolean;
    listeners: Set<(chunk: string) => void>;
    endListeners: Set<(reason: "ended" | "timeout") => void>;
    controller: AbortController;
    timer: ReturnType<typeof setTimeout>;
    done: Promise<void>;
    ended: boolean;
}

/** Strip ANSI color escapes so the browser shows strictly textual output. */
export function stripAnsi(text: string): string {
    return text.replace(new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g"), "");
}

/**
 * Reference-counted `compose logs --follow` streams, one subprocess per stack
 * at most. Attaching never starts a second process; the subprocess is killed
 * when the last reader leaves or when the explicit timeout fires. Closing the
 * browser only stops observation of operations, but for logs the follow
 * subprocess exists solely for its readers, so the last unsubscribe stops it.
 */
export class LogManager {
    private readonly streams = new Map<string, LogStream>();

    constructor(
        private readonly provider: ComposeProvider,
        private readonly options: LogManagerOptions,
    ) {}

    isActive(stack: string): boolean {
        return this.streams.has(stack);
    }

    subscriberCount(): number {
        let total = 0;
        for (const stream of this.streams.values()) total += stream.listeners.size;
        return total;
    }

    subscribersOf(stack: string): number {
        return this.streams.get(stack)?.listeners.size ?? 0;
    }

    subscribe(
        stack: string,
        target: ComposeTarget,
        listener: (chunk: string) => void,
        onEnd: (reason: "ended" | "timeout") => void,
    ): { replay: LogSnapshot; unsubscribe: () => void } {
        let stream = this.streams.get(stack);
        if (!stream) {
            stream = this.start(stack, target);
            this.streams.set(stack, stream);
        }
        stream.listeners.add(listener);
        stream.endListeners.add(onEnd);
        const replay: LogSnapshot = { text: stream.buffer, truncated: stream.truncated };
        let done = false;
        return {
            replay,
            unsubscribe: () => {
                if (done) return;
                done = true;
                const current = this.streams.get(stack);
                if (!current) return;
                current.listeners.delete(listener);
                current.endListeners.delete(onEnd);
                if (current.listeners.size === 0) this.stop(stack, "ended");
            },
        };
    }

    /** Kill every follow subprocess. Used on server shutdown. */
    async shutdown(): Promise<void> {
        const stacks = [...this.streams.keys()];
        for (const stack of stacks) this.stop(stack, "ended");
        await Promise.allSettled([...this.streams.values()].map(stream => stream.done));
    }

    private start(stack: string, target: ComposeTarget): LogStream {
        const controller = new AbortController();
        const stream: LogStream = {
            target,
            buffer: "",
            truncated: false,
            listeners: new Set(),
            endListeners: new Set(),
            controller,
            timer: setTimeout(() => this.stop(stack, "timeout"), this.options.timeoutMs),
            done: Promise.resolve(),
            ended: false,
        };
        const fullTarget = { ...target, tailLines: this.options.tailLines };
        stream.done = this.provider.followLogs(fullTarget, chunk => this.ingest(stack, chunk), controller.signal)
            .then(
                () => this.finish(stack, "ended"),
                () => this.finish(stack, "ended"),
            );
        return stream;
    }

    private ingest(stack: string, raw: string): void {
        const stream = this.streams.get(stack);
        if (!stream || stream.ended) return;
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
            try { listener(chunk); }
            catch { /* a broken observer must not fail the stream */ }
        }
    }

    private finish(stack: string, reason: "ended" | "timeout"): void {
        const stream = this.streams.get(stack);
        if (!stream || stream.ended) return;
        stream.ended = true;
        clearTimeout(stream.timer);
        for (const listener of [...stream.endListeners]) {
            try { listener(reason); }
            catch { /* ignore */ }
        }
        this.streams.delete(stack);
    }

    private stop(stack: string, reason: "ended" | "timeout"): void {
        const stream = this.streams.get(stack);
        if (!stream || stream.ended) return;
        clearTimeout(stream.timer);
        try { stream.controller.abort(); } catch { /* already aborted */ }
        // If the provider never settles (stuck process), still notify readers.
        // finish() will no-op thanks to the `ended` flag when the process exits.
        if (reason === "timeout") this.finish(stack, reason);
    }
}
