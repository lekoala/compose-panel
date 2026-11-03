/**
 * Compacts Docker Compose pull progress for live operation output (ADR 0034).
 *
 * Without a TTY, Compose prints one new line per progress update per layer
 * (`7801f5cb2c57 Downloading 63.96MB`). A large pull floods the retained
 * output and its byte cap with these lines. Only repeated `Downloading` and
 * `Extracting` updates of one layer are throttled; every other line, including
 * layer state changes (`Pull complete`) and errors, passes unchanged.
 */

const PROGRESS = /^\s*([0-9a-f]{12})\s+(Downloading|Extracting)\b/;
/** A partial line longer than this is passed through instead of buffered. */
const MAX_PENDING = 64 * 1024;
/** Bounds per-layer state; a pull has far fewer layers. */
const MAX_LAYERS = 1024;

export const PROGRESS_INTERVAL_MS = 5000;

export interface ProgressCompactor {
    write(chunk: string): void;
    /** Emits a trailing partial line once the command has ended. */
    flush(): void;
}

export function compactComposeProgress(
    emit: (chunk: string) => void,
    options: { intervalMs?: number; now?: () => number } = {},
): ProgressCompactor {
    const intervalMs = options.intervalMs ?? PROGRESS_INTERVAL_MS;
    const now = options.now ?? Date.now;
    const layers = new Map<string, { status: string; at: number }>();
    let pending = "";

    const keep = (line: string): boolean => {
        const match = PROGRESS.exec(line);
        if (!match) return true;
        const layer = match[1]!;
        const status = match[2]!;
        const at = now();
        const last = layers.get(layer);
        if (last && last.status === status && at - last.at < intervalMs) return false;
        if (!last && layers.size >= MAX_LAYERS) layers.clear();
        layers.set(layer, { status, at });
        return true;
    };

    return {
        write(chunk) {
            const lines = (pending + chunk).split("\n");
            pending = lines.pop() ?? "";
            const kept = lines.filter(keep);
            let text = kept.length > 0 ? `${kept.join("\n")}\n` : "";
            if (pending.length > MAX_PENDING) {
                text += pending;
                pending = "";
            }
            if (text) emit(text);
        },
        flush() {
            if (pending && keep(pending)) emit(pending);
            pending = "";
        },
    };
}
