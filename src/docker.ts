export interface CommandResult {
    code: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    truncated: boolean;
    /** The kill deadline elapsed without observing the child exit. */
    terminationUnconfirmed?: boolean;
}

export interface RunOptions {
    cwd?: string;
    timeoutMs?: number;
    maxBytes?: number;
    /** Forwarded every pipe chunk as it arrives; retention stays capped. */
    onChunk?: (chunk: string) => void;
    signal?: AbortSignal;
}

export type DockerRunner = (args: string[], options?: RunOptions) => Promise<CommandResult>;

const SPAWN_FAILURE_CODE = -1;
const KILL_GRACE_MS = 250;
const KILL_DEADLINE_MS = 1000;

interface Capture {
    chunks: Uint8Array[];
    total: number;
    truncated: boolean;
}

async function readCapped(
    stream: ReadableStream<Uint8Array> | undefined,
    maxBytes: number,
    onChunk?: (chunk: string) => void,
    capture: Capture = { chunks: [], total: 0, truncated: false },
    cleanup?: AbortSignal,
): Promise<void> {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const cancel = () => { void reader.cancel().catch(() => {}); };
    cleanup?.addEventListener("abort", cancel, { once: true });
    const notify = (text: string) => {
        if (!cleanup?.aborted && onChunk && text) {
            try { onChunk(text); }
            catch { /* a broken observer must not fail the command */ }
        }
    };
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value || value.byteLength === 0) continue;
            const text = decoder.decode(value, { stream: true });
            // Live delivery first: observers see progress while running.
            notify(text);
            if (capture.total >= maxBytes) {
                // Past the cap: keep draining so a chatty process can exit,
                // discard the rest. Stopping here could wedge the child on a
                // full pipe and hang the command.
                capture.truncated = true;
                continue;
            }
            const room = maxBytes - capture.total;
            if (value.byteLength <= room) {
                capture.chunks.push(value);
                capture.total += value.byteLength;
            } else {
                capture.chunks.push(value.subarray(0, room));
                capture.total = maxBytes;
                capture.truncated = true;
            }
        }
        notify(decoder.decode());
    } finally {
        cleanup?.removeEventListener("abort", cancel);
        try { reader.releaseLock(); } catch { /* already released */ }
    }
}

function spawnPipe(file: string, args: string[], cwd?: string) {
    return Bun.spawn([file, ...args], {
        cwd,
        env: process.env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        // Docker may launch the Compose plugin as a child. Own the Linux
        // process group so escalation also reaches that child, never the panel.
        detached: process.platform === "linux",
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

    if (options.signal?.aborted) return { code: -1, stdout: "", stderr: "", timedOut: true, truncated: false };
    let proc: ReturnType<typeof spawnPipe>;
    try {
        proc = spawnPipe(file, args, options.cwd);
    } catch {
        return { code: SPAWN_FAILURE_CODE, stdout: "", stderr: "", timedOut: false, truncated: false };
    }

    const out: Capture = { chunks: [], total: 0, truncated: false };
    const err: Capture = { chunks: [], total: 0, truncated: false };
    const cleanup = new AbortController();
    let timedOut = false;
    let deadlineExpired = false;
    let exitCode: number | null = null;
    let escalate: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let expire!: () => void;
    const expired = new Promise<void>(resolve => { expire = () => { deadlineExpired = true; resolve(); }; });
    const kill = (signal: "SIGTERM" | "SIGKILL") => {
        try {
            if (process.platform === "linux") process.kill(-proc.pid, signal);
            else proc.kill(signal);
        } catch { /* already exited or unavailable */ }
    };
    const terminate = () => {
        if (timedOut) return;
        timedOut = true;
        kill("SIGTERM");
        escalate = setTimeout(() => kill("SIGKILL"), KILL_GRACE_MS);
        deadline = setTimeout(expire, KILL_DEADLINE_MS);
    };
    const timer = timeoutMs > 0 ? setTimeout(terminate, timeoutMs) : undefined;
    options.signal?.addEventListener("abort", terminate, { once: true });
    const completed = Promise.all([
        readCapped(proc.stdout, maxBytes, options.onChunk, out, cleanup.signal),
        readCapped(proc.stderr, maxBytes, options.onChunk, err, cleanup.signal),
        proc.exited.then(code => { exitCode = code; }),
    ]).then(() => {}, async () => {
        // A broken pipe must not abandon a still-running privileged child.
        terminate();
        await expired;
    });

    try {
        await Promise.race([completed, expired]);
        const decode = (capture: Capture) => new TextDecoder().decode(Buffer.concat(capture.chunks), { stream: capture.truncated });
        return {
            code: exitCode ?? -1, stdout: decode(out), stderr: decode(err), timedOut,
            truncated: out.truncated || err.truncated,
            terminationUnconfirmed: exitCode === null || deadlineExpired,
        };
    } finally {
        clearTimeout(timer);
        clearTimeout(escalate);
        clearTimeout(deadline);
        options.signal?.removeEventListener("abort", terminate);
        cleanup.abort();
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
