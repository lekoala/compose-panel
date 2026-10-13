export interface CommandResult {
    code: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    truncated: boolean;
    /** The kill deadline elapsed without observing the child exit. */
    terminationUnconfirmed?: boolean;
    /** Raw stdout only for bounded Docker archive reads. */
    stdoutBytes?: Uint8Array;
}

export interface RunOptions {
    cwd?: string;
    timeoutMs?: number;
    maxBytes?: number;
    /** Forwarded every pipe chunk as it arrives; retention stays capped. */
    onChunk?: (chunk: string) => void;
    signal?: AbortSignal;
    /** Exact subprocess environment. Defaults to `composeEnvironment()`. */
    env?: Record<string, string>;
    /** Capture stdout without decoding binary archive bytes. */
    binaryStdout?: boolean;
    /** Stop read-only transfers as soon as their capture limit is exceeded. */
    stopOnOutputLimit?: boolean;
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
    onLimit?: () => void,
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
            // Live delivery first: observers see progress while running.
            if (onChunk) notify(decoder.decode(value, { stream: true }));
            if (capture.total >= maxBytes) {
                // Past the cap: keep draining so a chatty process can exit,
                // discard the rest. Stopping here could wedge the child on a
                // full pipe and hang the command.
                capture.truncated = true;
                onLimit?.();
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
                onLimit?.();
            }
        }
        notify(decoder.decode());
    } finally {
        cleanup?.removeEventListener("abort", cancel);
        try { reader.releaseLock(); } catch { /* already released */ }
    }
}

/**
 * Environment handed to Docker/Compose subprocesses. Panel-only variables
 * (the `COMPOSE_PANEL_*` namespace, including the admin password hash) are
 * stripped so they can never enter Compose interpolation. Everything else is
 * inherited unchanged, preserving documented precedence such as an operator's
 * `COMPOSE_PROJECT_NAME`. See docs/adr/0008-compose-subprocess-environment.md.
 */
export function composeEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
    const filtered: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
        if (value === undefined) continue;
        if (key.startsWith("COMPOSE_PANEL_")) continue;
        filtered[key] = value;
    }
    return filtered;
}

function spawnPipe(file: string, args: string[], cwd?: string, env: Record<string, string> = composeEnvironment()) {
    return Bun.spawn([file, ...args], {
        cwd,
        env,
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
        proc = spawnPipe(file, args, options.cwd, options.env);
    } catch {
        return { code: SPAWN_FAILURE_CODE, stdout: "", stderr: "", timedOut: false, truncated: false };
    }

    const out: Capture = { chunks: [], total: 0, truncated: false };
    const err: Capture = { chunks: [], total: 0, truncated: false };
    const cleanup = new AbortController();
    let timedOut = false;
    let terminating = false;
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
    const terminate = (timeout = true) => {
        if (terminating) return;
        terminating = true;
        timedOut = timeout;
        kill("SIGTERM");
        escalate = setTimeout(() => kill("SIGKILL"), KILL_GRACE_MS);
        deadline = setTimeout(expire, KILL_DEADLINE_MS);
    };
    const timer = timeoutMs > 0 ? setTimeout(() => terminate(), timeoutMs) : undefined;
    const abort = () => terminate();
    options.signal?.addEventListener("abort", abort, { once: true });
    const onLimit = options.stopOnOutputLimit ? () => terminate(false) : undefined;
    const completed = Promise.all([
        readCapped(proc.stdout, maxBytes, options.binaryStdout ? undefined : options.onChunk, out, cleanup.signal, onLimit),
        readCapped(proc.stderr, maxBytes, options.onChunk, err, cleanup.signal, onLimit),
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
            code: exitCode ?? -1, stdout: options.binaryStdout ? "" : decode(out), stderr: decode(err), timedOut,
            ...(options.binaryStdout ? { stdoutBytes: Buffer.concat(out.chunks) } : {}),
            truncated: out.truncated || err.truncated,
            terminationUnconfirmed: exitCode === null || deadlineExpired,
        };
    } finally {
        clearTimeout(timer);
        clearTimeout(escalate);
        clearTimeout(deadline);
        options.signal?.removeEventListener("abort", abort);
        cleanup.abort();
    }
}

export function createDockerRunner(options: { dockerPath?: string; timeoutMs?: number; maxBytes?: number; env?: Record<string, string> } = {}): DockerRunner {
    const dockerPath = options.dockerPath ?? "docker";
    const timeoutMs = options.timeoutMs ?? 5000;
    const maxBytes = options.maxBytes ?? 1024 * 1024;
    const env = options.env;
    return (args, overrides = {}) =>
        runCommand(dockerPath, args, { timeoutMs, maxBytes, env, ...overrides });
}

export const SPAWN_FAILURE = SPAWN_FAILURE_CODE;
