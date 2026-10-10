import { constants } from "node:fs";
import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

export type AuditRotation = "day" | "month";

/** Fields an audit line may carry. Never contains passwords, hashes or .env values. */
export interface AuditEvent {
    /** Stable event name, e.g. "login", "logout", "save", "operation", "startup". */
    event: string;
    /** Outcome, e.g. "success", "failure", "refused", "unknown". */
    result: string;
    /** Client key (loopback "direct", or the forwarded address behind a reviewed proxy). */
    actor?: string;
    stack?: string;
    action?: string;
    /** Attempted username. Not a secret; logged only to surface targeting. */
    username?: string;
    /** Short human-readable detail. Truncated; never includes secrets. */
    detail?: string;
}

export interface AuditEntry extends AuditEvent {
    ts: string;
}

export interface AuditLogOptions {
    /** Absolute directory that holds the period files. Created owner-only. */
    dir: string;
    enabled?: boolean;
    rotation?: AuditRotation;
    /** Number of period files to keep; the oldest are pruned on rollover. */
    retainFiles?: number;
    /** Maximum entries returned by `readPeriod`. */
    maxReadLines?: number;
    now?: () => number;
    /** Sink for write failures; defaults to `console.error`. */
    onError?: (error: unknown) => void;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;
const MAX_FIELD = 500;

export class AuditError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "AuditError";
    }
}

function clampField(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    const trimmed = value.replace(/[\r\n]+/g, " ").trim();
    if (!trimmed) return undefined;
    return trimmed.length > MAX_FIELD ? `${trimmed.slice(0, MAX_FIELD)}…` : trimmed;
}

/**
 * Append-only activity log backed by plain NDJSON files, one per period.
 *
 * There is no database and no in-memory history: the files on disk are the
 * whole record. Writes are best-effort — a failure is reported to `onError`
 * and never propagates into the request that produced the event. Reads are
 * bounded (tail of a single period file) and every filename is derived from a
 * validated period, never from user input.
 */
export class AuditLog {
    private readonly dir: string;
    private readonly enabled: boolean;
    private readonly rotation: AuditRotation;
    private readonly retainFiles: number;
    private readonly maxReadLines: number;
    private readonly now: () => number;
    private readonly onError: (error: unknown) => void;
    private lastPeriod: string | null = null;

    constructor(options: AuditLogOptions) {
        this.dir = options.dir;
        this.enabled = options.enabled ?? true;
        this.rotation = options.rotation ?? "day";
        this.retainFiles = options.retainFiles ?? 31;
        this.maxReadLines = options.maxReadLines ?? 2000;
        this.now = options.now ?? Date.now;
        this.onError = options.onError ?? (error => console.error("Audit log write failed", error));
    }

    /** Append one event. Never throws; a failure is surfaced through `onError`. */
    async record(event: AuditEvent): Promise<void> {
        if (!this.enabled) return;
        try {
            const ts = this.now();
            const period = this.periodFor(ts);
            await this.ensureDir();
            const entry: AuditEntry = {
                ts: new Date(ts).toISOString(),
                event: clampField(event.event) ?? "unknown",
                result: clampField(event.result) ?? "unknown",
                ...(clampField(event.actor) ? { actor: clampField(event.actor) } : {}),
                ...(clampField(event.stack) ? { stack: clampField(event.stack) } : {}),
                ...(clampField(event.action) ? { action: clampField(event.action) } : {}),
                ...(clampField(event.username) ? { username: clampField(event.username) } : {}),
                ...(clampField(event.detail) ? { detail: clampField(event.detail) } : {}),
            };
            await this.appendLine(`${period}.log`, `${JSON.stringify(entry)}\n`);
            if (this.lastPeriod !== period) {
                this.lastPeriod = period;
                await this.prune();
            }
        } catch (error) {
            this.onError(error);
        }
    }

    /** Period keys (most recent first) currently present on disk. */
    async listPeriods(): Promise<string[]> {
        if (!this.enabled) return [];
        try {
            const names = await readdir(this.dir);
            return names
                .filter(name => this.isValidPeriod(name.slice(0, -4)))
                .map(name => name.slice(0, -4))
                .sort((a, b) => b.localeCompare(a));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
            this.onError(error);
            return [];
        }
    }

    /** Tail of one period, oldest-first. Invalid periods are refused. */
    async readPeriod(period: string, maxLines = this.maxReadLines): Promise<AuditEntry[]> {
        if (!this.enabled) return [];
        if (!this.isValidPeriod(period)) throw new AuditError("This activity period is not valid.");
        const path = join(this.dir, `${period}.log`);
        let text: string;
        let truncated: boolean;
        try {
            ({ text, truncated } = await this.readTail(path, this.readBudget()));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
            throw error;
        }
        const lines = text.split("\n");
        if (truncated && lines.length > 0) lines.shift();
        const entries: AuditEntry[] = [];
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                const parsed = JSON.parse(trimmed) as AuditEntry;
                if (parsed && typeof parsed.ts === "string" && typeof parsed.event === "string") entries.push(parsed);
            } catch {
                // A truncated or partially written final line is skipped, not fatal.
            }
        }
        return entries.slice(-maxLines);
    }

    private periodFor(time: number): string {
        const iso = new Date(time).toISOString();
        return this.rotation === "month" ? iso.slice(0, 7) : iso.slice(0, 10);
    }

    private isValidPeriod(period: string): boolean {
        return this.rotation === "month" ? MONTH_RE.test(period) : DATE_RE.test(period);
    }

    private readBudget(): number {
        return Math.max(64 * 1024, Math.min(2 * 1024 * 1024, this.maxReadLines * 1024));
    }

    private async ensureDir(): Promise<void> {
        await mkdir(this.dir, { recursive: true, mode: 0o700 });
        const info = await lstat(this.dir);
        if (info.isSymbolicLink() || !info.isDirectory()) {
            throw new AuditError("The audit folder is a symbolic link or not a folder.");
        }
        try { await chmod(this.dir, 0o700); } catch { /* Best effort (Windows ignores POSIX modes). */ }
    }

    private async appendLine(filename: string, line: string): Promise<void> {
        const path = join(this.dir, filename);
        let info: Stats | null = null;
        try { info = await lstat(path); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (info && (info.isSymbolicLink() || !info.isFile())) {
            throw new AuditError("The audit file is a symbolic link or not a regular file.");
        }
        const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0), 0o600);
        try { await handle.write(line, undefined, "utf8"); }
        finally { await handle.close(); }
    }

    /** Read at most `maxBytes` from the end of a regular file. */
    private async readTail(path: string, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
        const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
            const info = await handle.stat();
            if (!info.isFile()) throw new AuditError("The audit file is not a regular file.");
            const start = Math.max(0, info.size - maxBytes);
            const length = info.size - start;
            if (length <= 0) return { text: "", truncated: false };
            const buffer = Buffer.alloc(length);
            await handle.read(buffer, 0, length, start);
            return { text: buffer.toString("utf8"), truncated: start > 0 };
        } finally {
            await handle.close();
        }
    }

    private async prune(): Promise<void> {
        const names = (await readdir(this.dir)).filter(name => this.isValidPeriod(name.slice(0, -4)));
        names.sort((a, b) => b.localeCompare(a));
        for (const name of names.slice(this.retainFiles)) {
            try { await unlink(join(this.dir, name)); }
            catch (error) { this.onError(error); }
        }
    }
}
