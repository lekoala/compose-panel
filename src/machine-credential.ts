/**
 * Shared primitives for the site-scoped machine endpoints (ADR 0050, ADR 0051).
 *
 * Both a CI-triggered deploy and a timer-triggered backup authenticate with one
 * bearer token whose SHA-256 digest the panel stores in a fixed private file,
 * send one bounded nonce/timestamp request and share the same failure counter.
 * Nothing here starts an operation, and no usable credential is ever stored.
 */
import { constants } from "node:fs";
import type { Stats } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { randomSuffix } from "./fs-safe.ts";
import { safeEqual } from "./auth.ts";

export const MACHINE_TOKEN_MIN = 32;
export const MACHINE_TOKEN_MAX = 128;
export const MACHINE_VERIFIER_MAX_BYTES = 256;
export const MACHINE_WINDOW_MS = 5 * 60 * 1000;
export const MACHINE_MAX_NONCES = 32;
export const MACHINE_FAILURE_WINDOW_MS = 60 * 1000;
export const MACHINE_MAX_FAILURES = 10;

/** One full lowercase commit id: only the deploy request carries one. */
export const MACHINE_COMMIT = /^[0-9a-f]{40}$/;
export const MACHINE_NONCE = /^[A-Za-z0-9_-]{16,64}$/;
export const MACHINE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;
const DIGEST_BODY = /^([0-9a-f]{64})\n?$/;

/** One bearer token: 32-128 characters of `[A-Za-z0-9_-]`. */
export function isMachineToken(value: string): boolean {
    return TOKEN.test(value);
}

export function hashMachineToken(token: string): string {
    return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Constant-time comparison of a presented token with the stored digest. */
export function verifyMachineToken(token: string, digest: string): boolean {
    if (!isMachineToken(token) || !/^[0-9a-f]{64}$/.test(digest)) return false;
    return safeEqual(hashMachineToken(token), digest);
}

export interface MachineFsOptions {
    /** Test seam; production uses `lstat`. */
    lstat?: (path: string) => Promise<Stats>;
    /** Test seam; production reads the real file with no-follow semantics. */
    read?: (path: string, maxBytes: number) => Promise<{ source: string } | null>;
    /** Test seam; defaults to the panel process uid when the platform has one. */
    ownerUid?: number | null;
}

export type MachineDigestCheck = { ok: true; digest: string } | { ok: false; reason: string };

export interface MachineDigestOptions extends MachineFsOptions {
    /** Fixed directory that must be a real directory, mode 0700, owned by the panel. */
    dir: string;
    /** Fixed verifier file inside that directory. */
    file: string;
    /** Human label for the directory, e.g. "CI credential". */
    dirLabel: string;
    /** Human label for the file, e.g. "CI verifier". */
    fileLabel: string;
    /** Instruction appended when the directory is missing. */
    missingDirHint: string;
    maxBytes?: number;
}

function panelUid(options: MachineFsOptions): number | null {
    if (options.ownerUid !== undefined) return options.ownerUid;
    return typeof process.getuid === "function" ? process.getuid() : null;
}

/**
 * Read one regular file with no-follow semantics, refusing a file that changed
 * identity between the metadata check and the read. `ENOENT` is thrown for the
 * caller to classify; any other problem returns `null`.
 */
export async function readMachineFileNoFollow(path: string, maxBytes: number): Promise<{ source: string } | null> {
    const before = await lstat(path);
    if (before.isSymbolicLink() || !before.isFile() || before.size > maxBytes || before.size === 0) return null;
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
        const opened = await handle.stat();
        if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) return null;
        const source = await handle.readFile("utf8");
        if (Buffer.byteLength(source, "utf8") > maxBytes) return null;
        return { source };
    } finally {
        await handle.close().catch(() => {});
    }
}

/**
 * Check the fixed verifier by metadata first, then read only the digest. A
 * missing, loose, linked or malformed file is a configuration refusal, never an
 * authentication success.
 */
export async function checkMachineDigestFile(options: MachineDigestOptions): Promise<MachineDigestCheck> {
    const { dir, file, dirLabel, fileLabel, missingDirHint } = options;
    const maxBytes = options.maxBytes ?? MACHINE_VERIFIER_MAX_BYTES;
    let info: Stats;
    try {
        info = await (options.lstat ?? lstat)(dir);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return { ok: false, reason: `The ${dirLabel} directory "${dir}" is missing. ${missingDirHint}` };
        }
        return { ok: false, reason: `The ${dirLabel} directory "${dir}" cannot be checked.` };
    }
    if (info.isSymbolicLink()) {
        return { ok: false, reason: `The ${dirLabel} directory "${dir}" is a symbolic link; it must be a real directory.` };
    }
    if (!info.isDirectory()) return { ok: false, reason: `The ${dirLabel} directory "${dir}" is not a directory.` };
    if ((info.mode & 0o077) !== 0) {
        return { ok: false, reason: `The ${dirLabel} directory "${dir}" must not be accessible by group or others (mode 0700).` };
    }
    const uid = panelUid(options);
    if (uid !== null && info.uid !== uid) {
        return { ok: false, reason: `The ${dirLabel} directory "${dir}" must be owned by the account that runs the panel.` };
    }
    let entry: Stats;
    try {
        entry = await (options.lstat ?? lstat)(file);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return {
                ok: false,
                reason: `The ${fileLabel} file "${file}" is missing. Provision the SHA-256 digest of the machine token there.`,
            };
        }
        return { ok: false, reason: `The ${fileLabel} file "${file}" cannot be checked.` };
    }
    if (entry.isSymbolicLink()) {
        return { ok: false, reason: `The ${fileLabel} file "${file}" is a symbolic link; it must be a regular file.` };
    }
    if (!entry.isFile()) return { ok: false, reason: `The ${fileLabel} file "${file}" is not a regular file.` };
    if (entry.nlink !== 1) return { ok: false, reason: `The ${fileLabel} file "${file}" must not be a hard link.` };
    if (entry.size === 0 || entry.size > maxBytes) {
        return { ok: false, reason: `The ${fileLabel} file "${file}" must be between 1 and ${maxBytes} bytes.` };
    }
    if ((entry.mode & 0o077) !== 0) {
        return { ok: false, reason: `The ${fileLabel} file "${file}" must not be accessible by group or others (mode 0600).` };
    }
    if (uid !== null && entry.uid !== uid) {
        return { ok: false, reason: `The ${fileLabel} file "${file}" must be owned by the account that runs the panel.` };
    }
    let read: { source: string } | null;
    try {
        read = await (options.read ?? readMachineFileNoFollow)(file, maxBytes);
    } catch {
        read = null;
    }
    if (!read) return { ok: false, reason: `The ${fileLabel} file "${file}" changed or could not be read.` };
    const matched = DIGEST_BODY.exec(read.source);
    if (!matched) return { ok: false, reason: `The ${fileLabel} file "${file}" must contain one lowercase SHA-256 digest.` };
    return { ok: true, digest: matched[1]! };
}

/** Atomic `0600` JSON replace; the caller has already validated the directory. */
export async function writeMachineJsonFile(path: string, value: unknown): Promise<void> {
    const temp = `${path}.${randomSuffix()}.tmp`;
    const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
        await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
        await handle.sync();
    } finally {
        await handle.close();
    }
    try {
        await rename(temp, path);
    } catch (error) {
        await unlink(temp).catch(() => {});
        throw error;
    }
}

export interface MachineNonceEntry {
    nonce: string;
    at: string;
}

/** Parse a stored nonce list, refusing any malformed or oversized entry. */
export function parseMachineNonceList(value: unknown, max = MACHINE_MAX_NONCES): MachineNonceEntry[] | null {
    if (!Array.isArray(value) || value.length > max) return null;
    const entries: MachineNonceEntry[] = [];
    for (const entry of value) {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
        const item = entry as Record<string, unknown>;
        if (typeof item.nonce !== "string" || !MACHINE_NONCE.test(item.nonce)) return null;
        if (typeof item.at !== "string" || !MACHINE_TIMESTAMP.test(item.at)) return null;
        entries.push({ nonce: item.nonce, at: item.at });
    }
    return entries;
}

/** Drop nonces outside the replay window (in either direction) and bound the list. */
export function pruneMachineNonces(entries: MachineNonceEntry[], now = Date.now(), windowMs = MACHINE_WINDOW_MS): MachineNonceEntry[] {
    return entries
        .filter((entry) => {
            const at = Date.parse(entry.at);
            return Number.isFinite(at) && now - at <= windowMs && at - now <= windowMs;
        })
        .slice(-MACHINE_MAX_NONCES);
}

export function machineNonceSeen(entries: MachineNonceEntry[], nonce: string): boolean {
    return entries.some((entry) => entry.nonce === nonce);
}

/** Consume one nonce; the caller writes the returned list under the lock. */
export function acceptMachineNonce(
    entries: MachineNonceEntry[],
    nonce: string,
    at: string,
    now = Date.now(),
    windowMs = MACHINE_WINDOW_MS,
): MachineNonceEntry[] {
    return pruneMachineNonces([...entries, { nonce, at }], now, windowMs);
}

/**
 * Validate one request timestamp against the panel clock. A captured request is
 * useful only inside the window, and a clock-skewed CI host is bounded too.
 */
export function parseMachineTimestamp(
    value: unknown,
    now: number,
    windowMs: number,
): { ok: true; timestamp: string; at: number } | { ok: false; reason: string } {
    if (typeof value !== "string" || !MACHINE_TIMESTAMP.test(value)) {
        return { ok: false, reason: "timestamp must be one ISO 8601 UTC instant." };
    }
    const at = Date.parse(value);
    if (!Number.isFinite(at)) return { ok: false, reason: "timestamp is not a real instant." };
    if (Math.abs(now - at) > windowMs) {
        return { ok: false, reason: `timestamp must be within ${Math.round(windowMs / 1000)} seconds of the panel clock.` };
    }
    return { ok: true, timestamp: value, at };
}

const DEFAULT_FAILURE_WINDOW_MS = MACHINE_FAILURE_WINDOW_MS;
const DEFAULT_MAX_FAILURES = MACHINE_MAX_FAILURES;

/**
 * In-memory per-site authentication failure counter. A restart only forgets
 * recent noise; it never weakens a token.
 */
export class MachineAuthLimiter {
    private readonly failures = new Map<string, { count: number; resetAt: number }>();

    constructor(
        private readonly now: () => number = Date.now,
        private readonly windowMs = DEFAULT_FAILURE_WINDOW_MS,
        private readonly maxFailures = DEFAULT_MAX_FAILURES,
    ) {}

    limited(key: string): boolean {
        const entry = this.failures.get(key);
        if (!entry) return false;
        if (entry.resetAt <= this.now()) {
            this.failures.delete(key);
            return false;
        }
        return entry.count >= this.maxFailures;
    }

    refuse(key: string): void {
        const now = this.now();
        const entry = this.failures.get(key);
        if (!entry || entry.resetAt <= now) {
            this.failures.set(key, { count: 1, resetAt: now + this.windowMs });
            return;
        }
        entry.count += 1;
    }

    clear(key: string): void {
        this.failures.delete(key);
    }
}
