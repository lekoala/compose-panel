/**
 * The site-scoped machine credential and request contract for a CI-triggered
 * deploy (ADR 0050).
 *
 * The panel stores only a SHA-256 verifier, never a usable token. A request
 * carries one exact commit, the configured ref, a timestamp and a nonce; the
 * nonce is consumed once and the timestamp is bounded, so a captured request
 * cannot be replayed after it was accepted. This module performs no request
 * handling and never starts a deploy.
 */
import { constants } from "node:fs";
import type { Stats } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { randomSuffix } from "./fs-safe.ts";
import { safeEqual } from "./auth.ts";
import { MANAGED_SITE_PATHS, type ManagedSiteManifest } from "./managed-site.ts";

export const MANAGED_SITE_CI_DIR = "ci";
export const MANAGED_SITE_CI_VERIFIER_FILE = "deploy-token.sha256";
export const MANAGED_SITE_CI_STATE_FILE = "last-attempt.json";
export const MANAGED_SITE_CI_VERIFIER_MAX_BYTES = 256;
export const MANAGED_SITE_CI_STATE_MAX_BYTES = 32 * 1024;
export const MANAGED_SITE_CI_MAX_BODY_BYTES = 8 * 1024;
export const MANAGED_SITE_CI_REPLAY_WINDOW_MS = 5 * 60 * 1000;
export const MANAGED_SITE_CI_MAX_NONCES = 32;
export const MANAGED_SITE_CI_TOKEN_MIN = 32;
export const MANAGED_SITE_CI_TOKEN_MAX = 128;
export const MANAGED_SITE_CI_FAILURE_WINDOW_MS = 60 * 1000;
export const MANAGED_SITE_CI_MAX_FAILURES = 10;

export type ManagedSiteCiResult = "accepted" | "succeeded" | "refused" | "failed";

export type ManagedSiteCiCheck = { ok: true; digest: string } | { ok: false; reason: string };

export interface ManagedSiteCiFsOptions {
    /** Test seam; production uses `lstat`. */
    lstat?: (path: string) => Promise<Stats>;
    /** Test seam; production reads the real file with no-follow semantics. */
    read?: (path: string, maxBytes: number) => Promise<{ source: string } | null>;
    /** Test seam; defaults to the panel process uid when the platform has one. */
    ownerUid?: number | null;
}

export function managedSiteCiDir(stackDir: string): string {
    return `${stackDir}/${MANAGED_SITE_PATHS.private}/${MANAGED_SITE_CI_DIR}`;
}

export function managedSiteCiVerifierPath(stackDir: string): string {
    return `${managedSiteCiDir(stackDir)}/${MANAGED_SITE_CI_VERIFIER_FILE}`;
}

export function managedSiteCiStatePath(stackDir: string): string {
    return `${managedSiteCiDir(stackDir)}/${MANAGED_SITE_CI_STATE_FILE}`;
}

const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;
const DIGEST_BODY = /^([0-9a-f]{64})\n?$/;
const COMMIT = /^[0-9a-f]{40}$/;
const NONCE = /^[A-Za-z0-9_-]{16,64}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** One bearer token: 32-128 characters of `[A-Za-z0-9_-]`. */
export function isManagedSiteCiToken(value: string): boolean {
    return TOKEN.test(value);
}

export function hashManagedSiteCiToken(token: string): string {
    return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Constant-time comparison of a presented token with the stored digest. */
export function verifyManagedSiteCiToken(token: string, digest: string): boolean {
    if (!isManagedSiteCiToken(token) || !/^[0-9a-f]{64}$/.test(digest)) return false;
    return safeEqual(hashManagedSiteCiToken(token), digest);
}

function panelUid(options: ManagedSiteCiFsOptions): number | null {
    if (options.ownerUid !== undefined) return options.ownerUid;
    return typeof process.getuid === "function" ? process.getuid() : null;
}

async function readBoundedNoFollow(path: string, maxBytes: number): Promise<{ source: string; info: Stats } | null> {
    const before = await lstat(path);
    if (before.isSymbolicLink() || !before.isFile() || before.size > maxBytes || before.size === 0) return null;
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
        const opened = await handle.stat();
        if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) return null;
        const source = await handle.readFile("utf8");
        if (Buffer.byteLength(source, "utf8") > maxBytes) return null;
        return { source, info: opened };
    } finally {
        await handle.close().catch(() => {});
    }
}

/**
 * Check the fixed verifier by metadata first, then read only the digest. A
 * missing, loose, linked or malformed file is a configuration refusal, never an
 * authentication success.
 */
export async function checkManagedSiteCiVerifier(stackDir: string, options: ManagedSiteCiFsOptions = {}): Promise<ManagedSiteCiCheck> {
    const dir = managedSiteCiDir(stackDir);
    let info: Stats;
    try {
        info = await (options.lstat ?? lstat)(dir);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return { ok: false, reason: `The CI credential directory "${dir}" is missing. Create it with mode 0700 before enabling ci.` };
        }
        return { ok: false, reason: `The CI credential directory "${dir}" cannot be checked.` };
    }
    if (info.isSymbolicLink())
        return { ok: false, reason: `The CI credential directory "${dir}" is a symbolic link; it must be a real directory.` };
    if (!info.isDirectory()) return { ok: false, reason: `The CI credential directory "${dir}" is not a directory.` };
    if ((info.mode & 0o077) !== 0) {
        return { ok: false, reason: `The CI credential directory "${dir}" must not be accessible by group or others (mode 0700).` };
    }
    const uid = panelUid(options);
    if (uid !== null && info.uid !== uid) {
        return { ok: false, reason: `The CI credential directory "${dir}" must be owned by the account that runs the panel.` };
    }
    const path = managedSiteCiVerifierPath(stackDir);
    let file: Stats;
    try {
        file = await (options.lstat ?? lstat)(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return { ok: false, reason: `The CI verifier file "${path}" is missing. Provision the SHA-256 digest of the CI token there.` };
        }
        return { ok: false, reason: `The CI verifier file "${path}" cannot be checked.` };
    }
    if (file.isSymbolicLink())
        return { ok: false, reason: `The CI verifier file "${path}" is a symbolic link; it must be a regular file.` };
    if (!file.isFile()) return { ok: false, reason: `The CI verifier file "${path}" is not a regular file.` };
    if (file.nlink !== 1) return { ok: false, reason: `The CI verifier file "${path}" must not be a hard link.` };
    if (file.size === 0 || file.size > MANAGED_SITE_CI_VERIFIER_MAX_BYTES) {
        return { ok: false, reason: `The CI verifier file "${path}" must be between 1 and ${MANAGED_SITE_CI_VERIFIER_MAX_BYTES} bytes.` };
    }
    if ((file.mode & 0o077) !== 0) {
        return { ok: false, reason: `The CI verifier file "${path}" must not be accessible by group or others (mode 0600).` };
    }
    if (uid !== null && file.uid !== uid) {
        return { ok: false, reason: `The CI verifier file "${path}" must be owned by the account that runs the panel.` };
    }
    let read: { source: string } | null;
    try {
        read = await (options.read ?? readBoundedNoFollow)(path, MANAGED_SITE_CI_VERIFIER_MAX_BYTES);
    } catch {
        read = null;
    }
    if (!read) return { ok: false, reason: `The CI verifier file "${path}" changed or could not be read.` };
    const matched = DIGEST_BODY.exec(read.source);
    if (!matched) return { ok: false, reason: `The CI verifier file "${path}" must contain one lowercase SHA-256 digest.` };
    return { ok: true, digest: matched[1]! };
}

export interface ManagedSiteCiRequestBody {
    sha: string;
    ref: string;
    nonce: string;
    /** The validated ISO 8601 string, stored as the attempt time. */
    timestamp: string;
    /** Milliseconds parsed from the request timestamp. */
    at: number;
}

/**
 * Parse the bounded request body. Unknown fields, a wrong ref, a decorated SHA,
 * a malformed nonce or a timestamp outside the replay window are refused before
 * any lock or Docker work.
 */
export function parseManagedSiteCiBody(
    source: string,
    manifest: ManagedSiteManifest,
    now = Date.now(),
    windowMs = MANAGED_SITE_CI_REPLAY_WINDOW_MS,
): { ok: true; request: ManagedSiteCiRequestBody } | { ok: false; reason: string } {
    if (Buffer.byteLength(source, "utf8") > MANAGED_SITE_CI_MAX_BODY_BYTES) {
        return { ok: false, reason: "The request body is larger than the panel accepts." };
    }
    let value: unknown;
    try {
        value = JSON.parse(source);
    } catch {
        return { ok: false, reason: "The request body is not valid JSON." };
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return { ok: false, reason: "The request body must be one JSON object." };
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.length !== 4 || keys.join(",") !== "nonce,ref,sha,timestamp") {
        return { ok: false, reason: "The request body must contain exactly sha, ref, nonce and timestamp." };
    }
    const { sha, ref, nonce, timestamp } = record;
    if (typeof sha !== "string" || !COMMIT.test(sha)) {
        return { ok: false, reason: "sha must be one full lowercase 40-character commit id." };
    }
    if (typeof ref !== "string" || ref !== manifest.deploy.git.ref) {
        return { ok: false, reason: `ref must be exactly "${manifest.deploy.git.ref}".` };
    }
    if (typeof nonce !== "string" || !NONCE.test(nonce)) {
        return { ok: false, reason: "nonce must be 16-64 characters of letters, digits, underscore or dash." };
    }
    if (typeof timestamp !== "string" || !TIMESTAMP.test(timestamp)) {
        return { ok: false, reason: "timestamp must be one ISO 8601 UTC instant." };
    }
    const at = Date.parse(timestamp);
    if (!Number.isFinite(at)) return { ok: false, reason: "timestamp is not a real instant." };
    if (Math.abs(now - at) > windowMs) {
        return { ok: false, reason: `timestamp must be within ${Math.round(windowMs / 1000)} seconds of the panel clock.` };
    }
    return { ok: true, request: { sha, ref, nonce, timestamp, at } };
}

export interface ManagedSiteCiAttempt {
    at: string;
    sha: string;
    result: ManagedSiteCiResult;
}

export interface ManagedSiteCiState {
    version: 1;
    siteId: string;
    ref: string;
    lastAttempt: ManagedSiteCiAttempt | null;
    /** Accepted nonces inside the replay window, oldest first. */
    nonces: { nonce: string; at: string }[];
}

export type ManagedSiteCiStateRead = { kind: "none" } | { kind: "unreadable" } | { kind: "ok"; state: ManagedSiteCiState };

export function parseManagedSiteCiState(source: string, siteId: string): ManagedSiteCiState | null {
    if (Buffer.byteLength(source, "utf8") > MANAGED_SITE_CI_STATE_MAX_BYTES) return null;
    let value: unknown;
    try {
        value = JSON.parse(source);
    } catch {
        return null;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const allowed = ["lastAttempt", "nonces", "ref", "siteId", "version"];
    if (Object.keys(record).some((key) => !allowed.includes(key))) return null;
    if (record.version !== 1 || record.siteId !== siteId) return null;
    if (typeof record.ref !== "string" || record.ref.length === 0 || record.ref.length > 255) return null;
    let lastAttempt: ManagedSiteCiAttempt | null = null;
    if (record.lastAttempt !== null && record.lastAttempt !== undefined) {
        const attempt = record.lastAttempt as Record<string, unknown> | null;
        if (
            !attempt ||
            typeof attempt.at !== "string" ||
            !TIMESTAMP.test(attempt.at) ||
            typeof attempt.sha !== "string" ||
            !COMMIT.test(attempt.sha) ||
            !["accepted", "succeeded", "refused", "failed"].includes(String(attempt.result))
        ) {
            return null;
        }
        lastAttempt = { at: attempt.at, sha: attempt.sha, result: attempt.result as ManagedSiteCiResult };
    }
    if (!Array.isArray(record.nonces) || record.nonces.length > MANAGED_SITE_CI_MAX_NONCES) return null;
    const nonces: { nonce: string; at: string }[] = [];
    for (const entry of record.nonces) {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
        const item = entry as Record<string, unknown>;
        if (typeof item.nonce !== "string" || !NONCE.test(item.nonce) || typeof item.at !== "string" || !TIMESTAMP.test(item.at)) {
            return null;
        }
        nonces.push({ nonce: item.nonce, at: item.at });
    }
    return { version: 1, siteId, ref: record.ref, lastAttempt, nonces };
}

export async function readManagedSiteCiState(stackDir: string, siteId: string): Promise<ManagedSiteCiStateRead> {
    let read: { source: string } | null;
    try {
        read = await readBoundedNoFollow(managedSiteCiStatePath(stackDir), MANAGED_SITE_CI_STATE_MAX_BYTES);
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "none" } : { kind: "unreadable" };
    }
    if (!read) return { kind: "unreadable" };
    const state = parseManagedSiteCiState(read.source, siteId);
    return state ? { kind: "ok", state } : { kind: "unreadable" };
}

/** Atomic 0600 replace. The CI directory is validated before any request. */
export async function writeManagedSiteCiState(stackDir: string, state: ManagedSiteCiState): Promise<void> {
    const path = managedSiteCiStatePath(stackDir);
    const temp = `${path}.${randomSuffix()}.tmp`;
    const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
        await handle.writeFile(`${JSON.stringify(state)}\n`, "utf8");
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

/** Drop nonces outside the replay window and keep the newest bounded set. */
export function pruneManagedSiteCiNonces(
    state: ManagedSiteCiState,
    now = Date.now(),
    windowMs = MANAGED_SITE_CI_REPLAY_WINDOW_MS,
): ManagedSiteCiState {
    const kept = state.nonces
        .filter((entry) => {
            const at = Date.parse(entry.at);
            return Number.isFinite(at) && now - at <= windowMs && at - now <= windowMs;
        })
        .slice(-MANAGED_SITE_CI_MAX_NONCES);
    return { ...state, nonces: kept };
}

export function managedSiteCiNonceSeen(state: ManagedSiteCiState, nonce: string): boolean {
    return state.nonces.some((entry) => entry.nonce === nonce);
}

/** Consume one nonce; the caller writes the returned state under the lock. */
export function acceptManagedSiteCiNonce(
    state: ManagedSiteCiState,
    nonce: string,
    at: string,
    now = Date.now(),
    windowMs = MANAGED_SITE_CI_REPLAY_WINDOW_MS,
): ManagedSiteCiState {
    return pruneManagedSiteCiNonces({ ...state, nonces: [...state.nonces, { nonce, at }] }, now, windowMs);
}

/** A fresh state for the first accepted request of a site. */
export function initialManagedSiteCiState(manifest: ManagedSiteManifest): ManagedSiteCiState {
    return { version: 1, siteId: manifest.siteId, ref: manifest.deploy.git.ref, lastAttempt: null, nonces: [] };
}
