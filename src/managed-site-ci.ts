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
import {
    MACHINE_COMMIT,
    MACHINE_MAX_NONCES,
    MACHINE_NONCE,
    MACHINE_TIMESTAMP,
    MACHINE_TOKEN_MAX,
    MACHINE_TOKEN_MIN,
    MACHINE_VERIFIER_MAX_BYTES,
    MACHINE_WINDOW_MS,
    acceptMachineNonce,
    checkMachineDigestFile,
    hashMachineToken,
    isMachineToken,
    machineNonceSeen,
    parseMachineNonceList,
    parseMachineTimestamp,
    pruneMachineNonces,
    readMachineFileNoFollow,
    verifyMachineToken,
    writeMachineJsonFile,
    type MachineDigestCheck,
    type MachineFsOptions,
    type MachineNonceEntry,
} from "./machine-credential.ts";
import { MANAGED_SITE_PATHS, type ManagedSiteManifest } from "./managed-site.ts";

export const MANAGED_SITE_CI_DIR = "ci";
export const MANAGED_SITE_CI_VERIFIER_FILE = "deploy-token.sha256";
export const MANAGED_SITE_CI_STATE_FILE = "last-attempt.json";
export const MANAGED_SITE_CI_VERIFIER_MAX_BYTES = MACHINE_VERIFIER_MAX_BYTES;
export const MANAGED_SITE_CI_STATE_MAX_BYTES = 32 * 1024;
export const MANAGED_SITE_CI_MAX_BODY_BYTES = 8 * 1024;
export const MANAGED_SITE_CI_REPLAY_WINDOW_MS = MACHINE_WINDOW_MS;
export const MANAGED_SITE_CI_MAX_NONCES = MACHINE_MAX_NONCES;
export const MANAGED_SITE_CI_TOKEN_MIN = MACHINE_TOKEN_MIN;
export const MANAGED_SITE_CI_TOKEN_MAX = MACHINE_TOKEN_MAX;

export type ManagedSiteCiResult = "accepted" | "succeeded" | "refused" | "failed";

export type ManagedSiteCiCheck = MachineDigestCheck;

export type ManagedSiteCiFsOptions = MachineFsOptions;

export function managedSiteCiDir(stackDir: string): string {
    return `${stackDir}/${MANAGED_SITE_PATHS.private}/${MANAGED_SITE_CI_DIR}`;
}

export function managedSiteCiVerifierPath(stackDir: string): string {
    return `${managedSiteCiDir(stackDir)}/${MANAGED_SITE_CI_VERIFIER_FILE}`;
}

export function managedSiteCiStatePath(stackDir: string): string {
    return `${managedSiteCiDir(stackDir)}/${MANAGED_SITE_CI_STATE_FILE}`;
}

/** One bearer token: 32-128 characters of `[A-Za-z0-9_-]`. */
export function isManagedSiteCiToken(value: string): boolean {
    return isMachineToken(value);
}

export function hashManagedSiteCiToken(token: string): string {
    return hashMachineToken(token);
}

/** Constant-time comparison of a presented token with the stored digest. */
export function verifyManagedSiteCiToken(token: string, digest: string): boolean {
    return verifyMachineToken(token, digest);
}

/**
 * Check the fixed verifier by metadata first, then read only the digest. A
 * missing, loose, linked or malformed file is a configuration refusal, never an
 * authentication success.
 */
export function checkManagedSiteCiVerifier(stackDir: string, options: ManagedSiteCiFsOptions = {}): Promise<ManagedSiteCiCheck> {
    return checkMachineDigestFile({
        ...options,
        dir: managedSiteCiDir(stackDir),
        file: managedSiteCiVerifierPath(stackDir),
        dirLabel: "CI credential",
        fileLabel: "CI verifier",
        missingDirHint: "Create it with mode 0700 before enabling ci.",
    });
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
    if (typeof sha !== "string" || !MACHINE_COMMIT.test(sha)) {
        return { ok: false, reason: "sha must be one full lowercase 40-character commit id." };
    }
    if (typeof ref !== "string" || ref !== manifest.deploy.git.ref) {
        return { ok: false, reason: `ref must be exactly "${manifest.deploy.git.ref}".` };
    }
    if (typeof nonce !== "string" || !MACHINE_NONCE.test(nonce)) {
        return { ok: false, reason: "nonce must be 16-64 characters of letters, digits, underscore or dash." };
    }
    const parsedTimestamp = parseMachineTimestamp(timestamp, now, windowMs);
    if (!parsedTimestamp.ok) return parsedTimestamp;
    return {
        ok: true,
        request: { sha, ref, nonce, timestamp: parsedTimestamp.timestamp, at: parsedTimestamp.at },
    };
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
    nonces: MachineNonceEntry[];
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
        const raw = record.lastAttempt;
        if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
        const attempt = raw as Record<string, unknown>;
        if (
            typeof attempt.at !== "string" ||
            !MACHINE_TIMESTAMP.test(attempt.at) ||
            typeof attempt.sha !== "string" ||
            !MACHINE_COMMIT.test(attempt.sha) ||
            !["accepted", "succeeded", "refused", "failed"].includes(String(attempt.result))
        ) {
            return null;
        }
        lastAttempt = { at: attempt.at, sha: attempt.sha, result: attempt.result as ManagedSiteCiResult };
    }
    const nonces = parseMachineNonceList(record.nonces, MANAGED_SITE_CI_MAX_NONCES);
    if (!nonces) return null;
    return { version: 1, siteId, ref: record.ref, lastAttempt, nonces };
}

export async function readManagedSiteCiState(stackDir: string, siteId: string): Promise<ManagedSiteCiStateRead> {
    let read: { source: string } | null;
    try {
        read = await readMachineFileNoFollow(managedSiteCiStatePath(stackDir), MANAGED_SITE_CI_STATE_MAX_BYTES);
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "none" } : { kind: "unreadable" };
    }
    if (!read) return { kind: "unreadable" };
    const state = parseManagedSiteCiState(read.source, siteId);
    return state ? { kind: "ok", state } : { kind: "unreadable" };
}

/** Atomic 0600 replace. The CI directory is validated before any request. */
export function writeManagedSiteCiState(stackDir: string, state: ManagedSiteCiState): Promise<void> {
    return writeMachineJsonFile(managedSiteCiStatePath(stackDir), state);
}

/** Drop nonces outside the replay window and keep the newest bounded set. */
export function pruneManagedSiteCiNonces(
    state: ManagedSiteCiState,
    now = Date.now(),
    windowMs = MANAGED_SITE_CI_REPLAY_WINDOW_MS,
): ManagedSiteCiState {
    return { ...state, nonces: pruneMachineNonces(state.nonces, now, windowMs) };
}

export function managedSiteCiNonceSeen(state: ManagedSiteCiState, nonce: string): boolean {
    return machineNonceSeen(state.nonces, nonce);
}

/** Consume one nonce; the caller writes the returned state under the lock. */
export function acceptManagedSiteCiNonce(
    state: ManagedSiteCiState,
    nonce: string,
    at: string,
    now = Date.now(),
    windowMs = MANAGED_SITE_CI_REPLAY_WINDOW_MS,
): ManagedSiteCiState {
    return { ...state, nonces: acceptMachineNonce(state.nonces, nonce, at, now, windowMs) };
}

/** A fresh state for the first accepted request of a site. */
export function initialManagedSiteCiState(manifest: ManagedSiteManifest): ManagedSiteCiState {
    return { version: 1, siteId: manifest.siteId, ref: manifest.deploy.git.ref, lastAttempt: null, nonces: [] };
}
