export interface CommandResult {
    code: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    truncated: boolean;
}

export interface RunOptions {
    cwd?: string;
    timeoutMs?: number;
    maxBytes?: number;
    /** Forwarded every pipe chunk as it arrives; retention stays capped. */
    onChunk?: (chunk: string) => void;
}

export type DockerRunner = (args: string[], options?: RunOptions) => Promise<CommandResult>;

const SPAWN_FAILURE_CODE = -1;

async function readCapped(
    stream: ReadableStream<Uint8Array> | undefined,
    maxBytes: number,
    onChunk?: (chunk: string) => void,
): Promise<{ text: string; truncated: boolean }> {
    if (!stream) return { text: "", truncated: false };
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value || value.byteLength === 0) continue;
            const text = Buffer.from(value).toString("utf8");
            // Live delivery first: observers see progress while running.
            if (onChunk && text) {
                try { onChunk(text); }
                catch { /* a broken observer must not fail the command */ }
            }
            if (total >= maxBytes) {
                // Past the cap: keep draining so a chatty process can exit,
                // discard the rest. Stopping here could wedge the child on a
                // full pipe and hang the command.
                truncated = true;
                continue;
            }
            const room = maxBytes - total;
            if (value.byteLength <= room) {
                chunks.push(value);
                total += value.byteLength;
            } else {
                chunks.push(value.subarray(0, room));
                total = maxBytes;
                truncated = true;
            }
        }
    } finally {
        try { reader.releaseLock(); } catch { /* already released */ }
    }
    return { text: Buffer.concat(chunks).toString("utf8"), truncated };
}

function spawnPipe(file: string, args: string[], cwd?: string) {
    return Bun.spawn([file, ...args], {
        cwd,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
    });
}

/**
 * Run a fixed executable with an explicit argument array. Never uses a shell.
 * Both streams are consumed even if the output is capped, and the process is
 * killed after the timeout.
 */
export async function runCommand(file: string, args: string[], options: RunOptions = {}): Promise<CommandResult> {
    const timeoutMs = options.timeoutMs ?? 5000;
    const maxBytes = options.maxBytes ?? 1024 * 1024;

    let proc: ReturnType<typeof spawnPipe>;
    try {
        proc = spawnPipe(file, args, options.cwd);
    } catch {
        return { code: SPAWN_FAILURE_CODE, stdout: "", stderr: "", timedOut: false, truncated: false };
    }

    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        proc.kill();
    }, timeoutMs);

    try {
        const [out, err] = await Promise.all([
            readCapped(proc.stdout, maxBytes, options.onChunk),
            readCapped(proc.stderr, maxBytes, options.onChunk),
        ]);
        const code = await proc.exited;
        return { code, stdout: out.text, stderr: err.text, timedOut, truncated: out.truncated || err.truncated };
    } finally {
        clearTimeout(timer);
    }
}

export function createDockerRunner(options: { dockerPath?: string; timeoutMs?: number; maxBytes?: number } = {}): DockerRunner {
    const dockerPath = options.dockerPath ?? "docker";
    const timeoutMs = options.timeoutMs ?? 5000;
    const maxBytes = options.maxBytes ?? 1024 * 1024;
    return (args, overrides = {}) =>
        runCommand(dockerPath, args, { timeoutMs, maxBytes, ...overrides });
}

export const SPAWN_FAILURE = SPAWN_FAILURE_CODE;
