/**
 * Timer-triggered backup requests (ADR 0051).
 *
 * A host timer authenticates with one site-scoped bearer token whose SHA-256
 * digest the panel stores in a fixed private file. A request carries only a
 * nonce and a bounded timestamp; the repository, the roots and the scope always
 * come from the manifest. This module owns the verifier check, the request
 * parser and the durable facts (last attempt, last good snapshot, last verified
 * restore, consumed nonces). It starts no backup and runs no timer.
 */
import {
    MACHINE_MAX_NONCES,
    MACHINE_NONCE,
    MACHINE_TIMESTAMP,
    MACHINE_WINDOW_MS,
    acceptMachineNonce,
    checkMachineDigestFile,
    machineNonceSeen,
    parseMachineNonceList,
    parseMachineTimestamp,
    readMachineFileNoFollow,
    writeMachineJsonFile,
    type MachineDigestCheck,
    type MachineFsOptions,
    type MachineNonceEntry,
} from "./machine-credential.ts";
import { managedSiteBackupCredentialPath, managedSiteBackupDir } from "./managed-site-backup.ts";

export const MANAGED_SITE_BACKUP_TRIGGER_FILE = "trigger-token.sha256";
export const MANAGED_SITE_BACKUP_TRIGGER_STATE_FILE = "trigger-state.json";
export const MANAGED_SITE_BACKUP_TRIGGER_MAX_BODY_BYTES = 8 * 1024;
export const MANAGED_SITE_BACKUP_TRIGGER_STATE_MAX_BYTES = 16 * 1024;
export const MANAGED_SITE_BACKUP_TRIGGER_REPLAY_WINDOW_MS = MACHINE_WINDOW_MS;
export const MANAGED_SITE_BACKUP_TRIGGER_MAX_NONCES = MACHINE_MAX_NONCES;

export const MANAGED_SITE_BACKUP_TRIGGER_HOUR_MS = 60 * 60 * 1000;

const SNAPSHOT = /^[0-9a-f]{64}$/;
const RESULTS = ["accepted", "succeeded", "refused", "failed"] as const;

export type ManagedSiteBackupTriggerResult = (typeof RESULTS)[number];

export function managedSiteBackupTriggerVerifierPath(stackDir: string): string {
    return managedSiteBackupCredentialPath(stackDir, MANAGED_SITE_BACKUP_TRIGGER_FILE);
}

export function managedSiteBackupTriggerStatePath(stackDir: string): string {
    return managedSiteBackupCredentialPath(stackDir, MANAGED_SITE_BACKUP_TRIGGER_STATE_FILE);
}

/**
 * Check the fixed trigger verifier by metadata first, then read only the digest.
 * The backup credential directory is already required to be a real `0700`
 * directory owned by the panel account.
 */
export function checkManagedSiteBackupTriggerVerifier(stackDir: string, options: MachineFsOptions = {}): Promise<MachineDigestCheck> {
    return checkMachineDigestFile({
        ...options,
        dir: managedSiteBackupDir(stackDir),
        file: managedSiteBackupTriggerVerifierPath(stackDir),
        dirLabel: "backup credential",
        fileLabel: "backup trigger verifier",
        missingDirHint: "Create it with mode 0700 before enabling backup.trigger.",
    });
}

export interface ManagedSiteBackupTriggerRequestBody {
    nonce: string;
    /** The validated ISO 8601 string, stored as the attempt time. */
    timestamp: string;
    /** Milliseconds parsed from the request timestamp. */
    at: number;
}

/**
 * Parse the bounded request body: exactly one nonce and one timestamp. A
 * deploy-shaped or otherwise extra field is refused rather than ignored.
 */
export function parseManagedSiteBackupTriggerBody(
    source: string,
    now = Date.now(),
    windowMs = MANAGED_SITE_BACKUP_TRIGGER_REPLAY_WINDOW_MS,
): { ok: true; request: ManagedSiteBackupTriggerRequestBody } | { ok: false; reason: string } {
    if (Buffer.byteLength(source, "utf8") > MANAGED_SITE_BACKUP_TRIGGER_MAX_BODY_BYTES) {
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
    if (keys.length !== 2 || keys.join(",") !== "nonce,timestamp") {
        return { ok: false, reason: "The request body must contain exactly nonce and timestamp." };
    }
    const { nonce, timestamp } = record;
    if (typeof nonce !== "string" || !MACHINE_NONCE.test(nonce)) {
        return { ok: false, reason: "nonce must be 16-64 characters of letters, digits, underscore or dash." };
    }
    const parsedTimestamp = parseMachineTimestamp(timestamp, now, windowMs);
    if (!parsedTimestamp.ok) return parsedTimestamp;
    return {
        ok: true,
        request: { nonce, timestamp: parsedTimestamp.timestamp, at: parsedTimestamp.at },
    };
}

export interface ManagedSiteBackupTriggerAttempt {
    at: string;
    result: ManagedSiteBackupTriggerResult;
}

export interface ManagedSiteBackupTriggerSnapshot {
    /** When the panel recorded the fact, as one ISO 8601 UTC instant. */
    at: string;
    snapshotId: string;
}

export interface ManagedSiteBackupTriggerState {
    version: 1;
    siteId: string;
    lastAttempt: ManagedSiteBackupTriggerAttempt | null;
    lastSuccess: ManagedSiteBackupTriggerSnapshot | null;
    lastProof: ManagedSiteBackupTriggerSnapshot | null;
    /** Accepted nonces inside the replay window, oldest first. */
    nonces: MachineNonceEntry[];
}

export type ManagedSiteBackupTriggerStateRead =
    { kind: "none" } | { kind: "unreadable" } | { kind: "ok"; state: ManagedSiteBackupTriggerState };

/** A fresh record for the first request of a site. */
export function initialManagedSiteBackupTriggerState(siteId: string): ManagedSiteBackupTriggerState {
    return { version: 1, siteId, lastAttempt: null, lastSuccess: null, lastProof: null, nonces: [] };
}

function parseSnapshotFact(value: unknown): ManagedSiteBackupTriggerSnapshot | null | undefined {
    if (value === null || value === undefined) return null;
    if (typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).some((key) => key !== "at" && key !== "snapshotId")) return undefined;
    if (typeof record.at !== "string" || !MACHINE_TIMESTAMP.test(record.at)) return undefined;
    if (typeof record.snapshotId !== "string" || !SNAPSHOT.test(record.snapshotId)) return undefined;
    return { at: record.at, snapshotId: record.snapshotId };
}

export function parseManagedSiteBackupTriggerState(source: string, siteId: string): ManagedSiteBackupTriggerState | null {
    if (Buffer.byteLength(source, "utf8") > MANAGED_SITE_BACKUP_TRIGGER_STATE_MAX_BYTES) return null;
    let value: unknown;
    try {
        value = JSON.parse(source);
    } catch {
        return null;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const allowed = ["lastAttempt", "lastProof", "lastSuccess", "nonces", "siteId", "version"];
    if (Object.keys(record).some((key) => !allowed.includes(key))) return null;
    if (record.version !== 1 || record.siteId !== siteId) return null;

    let lastAttempt: ManagedSiteBackupTriggerAttempt | null = null;
    if (record.lastAttempt !== null && record.lastAttempt !== undefined) {
        if (typeof record.lastAttempt !== "object" || Array.isArray(record.lastAttempt)) return null;
        const attempt = record.lastAttempt as Record<string, unknown>;
        if (Object.keys(attempt).some((key) => key !== "at" && key !== "result")) return null;
        if (typeof attempt.at !== "string" || !MACHINE_TIMESTAMP.test(attempt.at)) return null;
        if (!RESULTS.includes(attempt.result as ManagedSiteBackupTriggerResult)) return null;
        lastAttempt = { at: attempt.at, result: attempt.result as ManagedSiteBackupTriggerResult };
    }

    const lastSuccess = parseSnapshotFact(record.lastSuccess);
    if (lastSuccess === undefined) return null;
    const lastProof = parseSnapshotFact(record.lastProof);
    if (lastProof === undefined) return null;

    const nonces = parseMachineNonceList(record.nonces, MANAGED_SITE_BACKUP_TRIGGER_MAX_NONCES);
    if (!nonces) return null;
    return { version: 1, siteId, lastAttempt, lastSuccess, lastProof, nonces };
}

export async function readManagedSiteBackupTriggerState(stackDir: string, siteId: string): Promise<ManagedSiteBackupTriggerStateRead> {
    let read: { source: string } | null;
    try {
        read = await readMachineFileNoFollow(managedSiteBackupTriggerStatePath(stackDir), MANAGED_SITE_BACKUP_TRIGGER_STATE_MAX_BYTES);
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "none" } : { kind: "unreadable" };
    }
    if (!read) return { kind: "unreadable" };
    const state = parseManagedSiteBackupTriggerState(read.source, siteId);
    return state ? { kind: "ok", state } : { kind: "unreadable" };
}

/** Atomic 0600 replace inside the checked private backup directory. */
export function writeManagedSiteBackupTriggerState(stackDir: string, state: ManagedSiteBackupTriggerState): Promise<void> {
    return writeMachineJsonFile(managedSiteBackupTriggerStatePath(stackDir), state);
}

/**
 * Read-modify-write one fact. The caller holds the stack lock, and an
 * unreadable record is refused rather than overwritten, because rewriting it
 * would forget the consumed nonces.
 */
export async function updateManagedSiteBackupTriggerState(
    stackDir: string,
    siteId: string,
    mutate: (state: ManagedSiteBackupTriggerState) => ManagedSiteBackupTriggerState,
): Promise<{ ok: true; state: ManagedSiteBackupTriggerState } | { ok: false; reason: string }> {
    const read = await readManagedSiteBackupTriggerState(stackDir, siteId);
    if (read.kind === "unreadable") {
        return { ok: false, reason: "The backup trigger record cannot be read; inspect it on the host." };
    }
    const next = mutate(read.kind === "ok" ? read.state : initialManagedSiteBackupTriggerState(siteId));
    await writeManagedSiteBackupTriggerState(stackDir, next);
    return { ok: true, state: next };
}

export function managedSiteBackupTriggerNonceSeen(state: ManagedSiteBackupTriggerState, nonce: string): boolean {
    return machineNonceSeen(state.nonces, nonce);
}

/** Consume one nonce; the caller writes the returned state under the lock. */
export function acceptManagedSiteBackupTriggerNonce(
    state: ManagedSiteBackupTriggerState,
    nonce: string,
    at: string,
    now = Date.now(),
    windowMs = MANAGED_SITE_BACKUP_TRIGGER_REPLAY_WINDOW_MS,
): ManagedSiteBackupTriggerState {
    return { ...state, nonces: acceptMachineNonce(state.nonces, nonce, at, now, windowMs) };
}

export interface ManagedSiteBackupFreshness {
    overdue: boolean;
    /** When the declared interval elapses, or null when no backup succeeded yet. */
    dueAt: string | null;
}

/**
 * Freshness is computed from the durable last-success fact, never from memory or
 * a timer, so a panel that was down over the interval still reports overdue.
 */
export function managedSiteBackupFreshness(
    state: ManagedSiteBackupTriggerState,
    everyHours: number,
    now = Date.now(),
): ManagedSiteBackupFreshness {
    if (!state.lastSuccess) return { overdue: true, dueAt: null };
    const at = Date.parse(state.lastSuccess.at);
    if (!Number.isFinite(at)) return { overdue: true, dueAt: null };
    const dueAt = at + everyHours * MANAGED_SITE_BACKUP_TRIGGER_HOUR_MS;
    return { overdue: now > dueAt, dueAt: new Date(dueAt).toISOString() };
}
