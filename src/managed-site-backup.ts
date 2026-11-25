/**
 * Offsite backup of one managed site (ADR 0049).
 *
 * This module owns everything that touches the filesystem and the fixed private
 * credential directory: path derivation, metadata-only credential checks, the
 * bounded staging copy and the attempt marker. It never reads a credential
 * value, never contacts a database and never talks to Docker, so the one-shot
 * container orchestration stays in `managed-site-backup-run.ts` and remains
 * replaceable in tests.
 */
import { constants } from "node:fs";
import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readFile, rename, rm, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirIdentity, randomSuffix, sameDirIdentity, type DirIdentity } from "./fs-safe.ts";
import {
    MANAGED_SITE_BACKUP_DATABASE_MAX,
    MANAGED_SITE_PATHS,
    isManagedSiteBackupDatabase,
    managedSitePersistentPath,
    type ManagedSiteManifest,
} from "./managed-site.ts";

/** Fixed private layout, outside releases, generated files and service mounts. */
export const MANAGED_SITE_BACKUP_DIR = "backup";
export const MANAGED_SITE_BACKUP_RESTIC_PASSWORD_FILE = "restic-password";
export const MANAGED_SITE_BACKUP_REST_ENV_FILE = "rest.env";
export const MANAGED_SITE_BACKUP_DATABASE_ENV_FILE = "database.env";
export const MANAGED_SITE_BACKUP_ATTEMPT_FILE = "backup-attempt.json";

export const MANAGED_SITE_BACKUP_CREDENTIAL_MAX_BYTES = 4 * 1024;
export const MANAGED_SITE_BACKUP_ATTEMPT_MAX_BYTES = 16 * 1024;
export const MANAGED_SITE_BACKUP_MAX_ENTRIES = 20_000;
export const MANAGED_SITE_BACKUP_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const MANAGED_SITE_BACKUP_MAX_DUMP_BYTES = 2 * 1024 * 1024 * 1024;

/** Pinned one-shot tooling. The panel image gains neither client. */
export const MANAGED_SITE_BACKUP_RESTIC_IMAGE = "restic/restic:0.18.0";
export const MANAGED_SITE_BACKUP_DUMP_IMAGES = { mariadb: "mariadb:11" } as const;

export type ManagedSiteBackupCheck = { ok: true } | { ok: false; reason: string };

export interface ManagedSiteBackupFsOptions {
    /** Test seam; production uses `lstat`. */
    lstat?: (path: string) => Promise<Stats>;
    /** Test seam; defaults to the panel process uid when the platform has one. */
    ownerUid?: number | null;
}

export function managedSiteBackupDir(stackDir: string): string {
    return `${stackDir}/${MANAGED_SITE_PATHS.private}/${MANAGED_SITE_BACKUP_DIR}`;
}

export function managedSiteBackupCredentialPath(stackDir: string, file: string): string {
    return `${managedSiteBackupDir(stackDir)}/${file}`;
}

export function managedSiteBackupStagingDir(stackDir: string, attemptId: string): string {
    return `${managedSiteBackupDir(stackDir)}/staging/${attemptId}`;
}

export function managedSiteBackupAttemptPath(stackDir: string): string {
    return `${managedSiteBackupDir(stackDir)}/${MANAGED_SITE_BACKUP_ATTEMPT_FILE}`;
}

export function managedSiteBackupDatabaseName(manifest: ManagedSiteManifest): string | null {
    return manifest.backup?.sql?.database ?? null;
}

function panelUid(options: ManagedSiteBackupFsOptions): number | null {
    if (options.ownerUid !== undefined) return options.ownerUid;
    return typeof process.getuid === "function" ? process.getuid() : null;
}

async function privateFileCheck(
    path: string,
    label: string,
    options: ManagedSiteBackupFsOptions,
    required: boolean,
): Promise<ManagedSiteBackupCheck> {
    let info: Stats;
    try {
        info = await (options.lstat ?? lstat)(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return required
                ? { ok: false, reason: `The ${label} file "${path}" is missing. Provision it as a regular 0600 file before backing up.` }
                : { ok: true };
        }
        return { ok: false, reason: `The ${label} file "${path}" cannot be checked.` };
    }
    if (info.isSymbolicLink()) return { ok: false, reason: `The ${label} file "${path}" is a symbolic link; it must be a regular file.` };
    if (!info.isFile()) return { ok: false, reason: `The ${label} file "${path}" is not a regular file.` };
    if (info.nlink !== 1) return { ok: false, reason: `The ${label} file "${path}" must not be a hard link.` };
    if (info.size === 0 || info.size > MANAGED_SITE_BACKUP_CREDENTIAL_MAX_BYTES) {
        return {
            ok: false,
            reason: `The ${label} file "${path}" must be between 1 and ${MANAGED_SITE_BACKUP_CREDENTIAL_MAX_BYTES} bytes.`,
        };
    }
    if ((info.mode & 0o077) !== 0) {
        return { ok: false, reason: `The ${label} file "${path}" must not be accessible by group or others (mode 0600).` };
    }
    const uid = panelUid(options);
    if (uid !== null && info.uid !== uid) {
        return { ok: false, reason: `The ${label} file "${path}" must be owned by the account that runs the panel.` };
    }
    return { ok: true };
}

/**
 * Check the fixed credential directory before any backup container runs. Only
 * metadata is inspected; the values are never read by the panel.
 */
export async function checkManagedSiteBackupCredentials(
    stackDir: string,
    manifest: ManagedSiteManifest,
    options: ManagedSiteBackupFsOptions = {},
): Promise<ManagedSiteBackupCheck> {
    if (!manifest.backup) return { ok: true };
    const dir = managedSiteBackupDir(stackDir);
    let info: Stats;
    try {
        info = await (options.lstat ?? lstat)(dir);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return {
                ok: false,
                reason: `The backup credential directory "${dir}" is missing. Create it with mode 0700 before backing up.`,
            };
        }
        return { ok: false, reason: `The backup credential directory "${dir}" cannot be checked.` };
    }
    if (info.isSymbolicLink())
        return { ok: false, reason: `The backup credential directory "${dir}" is a symbolic link; it must be a real directory.` };
    if (!info.isDirectory()) return { ok: false, reason: `The backup credential directory "${dir}" is not a directory.` };
    if ((info.mode & 0o077) !== 0) {
        return { ok: false, reason: `The backup credential directory "${dir}" must not be accessible by group or others (mode 0700).` };
    }
    const uid = panelUid(options);
    if (uid !== null && info.uid !== uid) {
        return { ok: false, reason: `The backup credential directory "${dir}" must be owned by the account that runs the panel.` };
    }

    const password = await privateFileCheck(
        managedSiteBackupCredentialPath(stackDir, MANAGED_SITE_BACKUP_RESTIC_PASSWORD_FILE),
        "Restic password",
        options,
        true,
    );
    if (!password.ok) return password;
    const rest = await privateFileCheck(
        managedSiteBackupCredentialPath(stackDir, MANAGED_SITE_BACKUP_REST_ENV_FILE),
        "REST environment",
        options,
        false,
    );
    if (!rest.ok) return rest;
    if (manifest.backup.sql) {
        const database = await privateFileCheck(
            managedSiteBackupCredentialPath(stackDir, MANAGED_SITE_BACKUP_DATABASE_ENV_FILE),
            "backup database credentials",
            options,
            true,
        );
        if (!database.ok) return database;
    }
    return { ok: true };
}

/** Refuse nested or duplicate declared roots: copying both would double the same bytes. */
export function managedSiteBackupRoots(manifest: ManagedSiteManifest): { ok: true; roots: string[] } | { ok: false; reason: string } {
    const roots = [...(manifest.paths ?? [])].sort();
    for (let index = 1; index < roots.length; index += 1) {
        const previous = roots[index - 1]!;
        const current = roots[index]!;
        if (current === previous || current.startsWith(`${previous}/`)) {
            return {
                ok: false,
                reason: `The declared persistent roots "${previous}" and "${current}" overlap; a backup would duplicate their content.`,
            };
        }
    }
    return { ok: true, roots };
}

export interface ManagedSiteBackupInventoryEntry {
    /** Relative to the staging directory, e.g. `files/shared/uploads/a.jpg`. */
    path: string;
    type: "file";
    size: number;
    sha256: string;
}

export interface ManagedSiteBackupLimits {
    maxEntries: number;
    maxBytes: number;
}

export const MANAGED_SITE_BACKUP_LIMITS: ManagedSiteBackupLimits = {
    maxEntries: MANAGED_SITE_BACKUP_MAX_ENTRIES,
    maxBytes: MANAGED_SITE_BACKUP_MAX_BYTES,
};

export type ManagedSiteBackupStagingResult =
    | { ok: true; stagingDir: string; inventory: ManagedSiteBackupInventoryEntry[]; bytes: number; entries: number }
    | { ok: false; reason: string };

export interface ManagedSiteBackupStagingOptions extends ManagedSiteBackupLimits {
    /** Test seam; defaults to the real `lstat`. */
    lstat?: (path: string) => Promise<Stats>;
}

interface CopyBudget {
    entries: number;
    bytes: number;
}

async function writeAll(handle: Awaited<ReturnType<typeof open>>, chunk: Buffer): Promise<void> {
    let offset = 0;
    while (offset < chunk.length) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset, null);
        if (bytesWritten <= 0) throw new Error("The staged file could not be written.");
        offset += bytesWritten;
    }
}

async function copyRegularFile(
    source: string,
    destination: string,
    relative: string,
    budget: CopyBudget,
    limits: ManagedSiteBackupLimits,
    options: Pick<ManagedSiteBackupStagingOptions, "lstat">,
    inventory: ManagedSiteBackupInventoryEntry[],
): Promise<ManagedSiteBackupCheck> {
    const before = await (options.lstat ?? lstat)(source);
    if (before.isSymbolicLink()) return { ok: false, reason: `The backup refuses the symbolic link "${relative}".` };
    if (!before.isFile())
        return { ok: false, reason: `The backup refuses "${relative}": only regular files and directories may be copied.` };
    if (before.nlink !== 1) return { ok: false, reason: `The backup refuses the hard link "${relative}".` };
    if (before.size > limits.maxBytes - budget.bytes) {
        return { ok: false, reason: `The declared persistent roots exceed the ${limits.maxBytes}-byte backup limit.` };
    }
    const sourceHandle = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let destinationHandle: Awaited<ReturnType<typeof open>> | null = null;
    try {
        const opened = await sourceHandle.stat();
        if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
            return { ok: false, reason: `The file "${relative}" changed while it was being backed up.` };
        }
        destinationHandle = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
        const hash = createHash("sha256");
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let position = 0;
        for (;;) {
            const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, position);
            if (bytesRead === 0) break;
            position += bytesRead;
            if (position > limits.maxBytes - budget.bytes) {
                return { ok: false, reason: `The declared persistent roots exceed the ${limits.maxBytes}-byte backup limit.` };
            }
            const chunk = buffer.subarray(0, bytesRead);
            hash.update(chunk);
            await writeAll(destinationHandle, chunk);
        }
        if (position !== before.size) return { ok: false, reason: `The file "${relative}" changed while it was being backed up.` };
        await destinationHandle.sync();
        await destinationHandle.close();
        destinationHandle = null;
        await chmod(destination, before.mode & 0o777);
        budget.bytes += position;
        inventory.push({ path: relative, type: "file", size: position, sha256: hash.digest("hex") });
        return { ok: true };
    } finally {
        await sourceHandle.close().catch(() => {});
        if (destinationHandle) await destinationHandle.close().catch(() => {});
    }
}

async function copyTree(
    sourceDir: string,
    destinationDir: string,
    relativeDir: string,
    budget: CopyBudget,
    limits: ManagedSiteBackupLimits,
    options: Pick<ManagedSiteBackupStagingOptions, "lstat">,
    inventory: ManagedSiteBackupInventoryEntry[],
): Promise<ManagedSiteBackupCheck> {
    await mkdir(destinationDir, { recursive: true, mode: 0o700 });
    const entries = await readdir(sourceDir, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        budget.entries += 1;
        if (budget.entries > limits.maxEntries) {
            return { ok: false, reason: `The declared persistent roots contain more than ${limits.maxEntries} entries.` };
        }
        const relative = `${relativeDir}/${entry.name}`;
        const source = `${sourceDir}/${entry.name}`;
        const destination = `${destinationDir}/${entry.name}`;
        const info = await (options.lstat ?? lstat)(source);
        if (info.isSymbolicLink()) return { ok: false, reason: `The backup refuses the symbolic link "${relative}".` };
        if (info.isDirectory()) {
            const copied = await copyTree(source, destination, relative, budget, limits, options, inventory);
            if (!copied.ok) return copied;
            await chmod(destination, info.mode & 0o777);
            continue;
        }
        if (info.isFile()) {
            const copied = await copyRegularFile(source, destination, relative, budget, limits, options, inventory);
            if (!copied.ok) return copied;
            continue;
        }
        return { ok: false, reason: `The backup refuses "${relative}": only regular files and directories may be copied.` };
    }
    return { ok: true };
}

/**
 * Copy every declared persistent root into a private staging tree, refusing
 * links, special files, escapes, duplicates and quota overruns. The caller owns
 * removal and the attempt marker.
 */
export async function stageManagedSiteBackup(
    stackDir: string,
    manifest: ManagedSiteManifest,
    attemptId: string,
    options: Partial<ManagedSiteBackupStagingOptions> = {},
): Promise<ManagedSiteBackupStagingResult> {
    if (!manifest.backup) return { ok: false, reason: "This site declares no backup block." };
    if (!manifest.paths || manifest.paths.length === 0) {
        return { ok: false, reason: "This site declares no persistent roots, so there is nothing to back up." };
    }
    const roots = managedSiteBackupRoots(manifest);
    if (!roots.ok) return roots;

    const limits: ManagedSiteBackupLimits = {
        maxEntries: options.maxEntries ?? MANAGED_SITE_BACKUP_LIMITS.maxEntries,
        maxBytes: options.maxBytes ?? MANAGED_SITE_BACKUP_LIMITS.maxBytes,
    };
    const stagingDir = managedSiteBackupStagingDir(stackDir, attemptId);
    await mkdir(`${stagingDir}/files`, { recursive: true, mode: 0o700 });
    const budget: CopyBudget = { entries: 0, bytes: 0 };
    const inventory: ManagedSiteBackupInventoryEntry[] = [];
    for (const root of roots.roots) {
        const source = managedSitePersistentPath(stackDir, root);
        let info: Stats;
        try {
            info = await (options.lstat ?? lstat)(source);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                return { ok: false, reason: `The declared persistent root "${root}" is missing. Recreate it before backing up.` };
            }
            throw error;
        }
        if (info.isSymbolicLink()) return { ok: false, reason: `The declared persistent root "${root}" is a symbolic link.` };
        if (!info.isDirectory()) return { ok: false, reason: `The declared persistent root "${root}" is not a directory.` };
        const destination = `${stagingDir}/files/${root}`;
        await mkdir(destination, { recursive: true, mode: 0o700 });
        const copied = await copyTree(source, destination, `files/${root}`, budget, limits, options, inventory);
        if (!copied.ok) return copied;
        await chmod(destination, info.mode & 0o777);
    }
    return { ok: true, stagingDir, inventory, bytes: budget.bytes, entries: budget.entries };
}

export type ManagedSiteBackupAttemptOutcome = "pending" | "complete" | "failed";

export interface ManagedSiteBackupAttempt {
    version: 1;
    siteId: string;
    attemptId: string;
    repository: string;
    startedAt: string;
    phase: string;
    outcome: ManagedSiteBackupAttemptOutcome;
    staging?: DirIdentity;
    snapshotId?: string;
    reason?: string;
}

export type ManagedSiteBackupAttemptRead =
    { kind: "none" } | { kind: "unreadable" } | { kind: "pending"; attempt: ManagedSiteBackupAttempt };

const BACKUP_PHASES = ["check", "stage", "dump", "upload", "verify", "complete"] as const;
export type ManagedSiteBackupPhase = (typeof BACKUP_PHASES)[number];

export function parseManagedSiteBackupAttempt(source: string): ManagedSiteBackupAttempt | null {
    if (Buffer.byteLength(source, "utf8") > MANAGED_SITE_BACKUP_ATTEMPT_MAX_BYTES) return null;
    let value: unknown;
    try {
        value = JSON.parse(source);
    } catch {
        return null;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const allowed = ["attemptId", "outcome", "phase", "repository", "siteId", "snapshotId", "staging", "startedAt", "version"];
    if (Object.keys(record).some((key) => !allowed.includes(key))) return null;
    if (record.version !== 1) return null;
    const { siteId, attemptId, repository, startedAt, phase, outcome } = record;
    if (typeof siteId !== "string" || siteId.length === 0 || siteId.length > 64) return null;
    if (typeof attemptId !== "string" || !/^[a-z0-9]{8,40}$/.test(attemptId)) return null;
    if (typeof repository !== "string" || repository.length === 0 || repository.length > 512) return null;
    if (typeof startedAt !== "string" || startedAt.length === 0 || startedAt.length > 40) return null;
    if (typeof phase !== "string" || !(BACKUP_PHASES as readonly string[]).includes(phase)) return null;
    if (outcome !== "pending" && outcome !== "complete" && outcome !== "failed") return null;
    let staging: DirIdentity | undefined;
    if (record.staging !== undefined) {
        const candidate = record.staging as Record<string, unknown> | null;
        if (
            !candidate ||
            typeof candidate.dev !== "number" ||
            typeof candidate.ino !== "number" ||
            !Number.isSafeInteger(candidate.dev) ||
            !Number.isSafeInteger(candidate.ino)
        ) {
            return null;
        }
        staging = { dev: candidate.dev, ino: candidate.ino };
    }
    if (record.snapshotId !== undefined && (typeof record.snapshotId !== "string" || !/^[0-9a-f]{64}$/.test(record.snapshotId)))
        return null;
    if (record.reason !== undefined && (typeof record.reason !== "string" || record.reason.length > 2000)) return null;
    return {
        version: 1,
        siteId,
        attemptId,
        repository,
        startedAt,
        phase: phase as ManagedSiteBackupPhase,
        outcome,
        ...(staging ? { staging } : {}),
        ...(typeof record.snapshotId === "string" ? { snapshotId: record.snapshotId } : {}),
        ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
    };
}

/** A marker blocks a new backup until the operator acknowledges it. */
export async function readManagedSiteBackupAttempt(stackDir: string): Promise<ManagedSiteBackupAttemptRead> {
    let source: string;
    try {
        const info = await lstat(managedSiteBackupAttemptPath(stackDir));
        if (info.isSymbolicLink() || !info.isFile() || info.size > MANAGED_SITE_BACKUP_ATTEMPT_MAX_BYTES) return { kind: "unreadable" };
        source = await readFile(managedSiteBackupAttemptPath(stackDir), "utf8");
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "none" } : { kind: "unreadable" };
    }
    const attempt = parseManagedSiteBackupAttempt(source);
    return attempt ? { kind: "pending", attempt } : { kind: "unreadable" };
}

/** Atomic, bounded attempt record in the private directory. */
export async function writeManagedSiteBackupAttempt(stackDir: string, attempt: ManagedSiteBackupAttempt): Promise<void> {
    const path = managedSiteBackupAttemptPath(stackDir);
    const temp = `${path}.${randomSuffix()}.tmp`;
    const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
        await handle.writeFile(`${JSON.stringify(attempt)}\n`, "utf8");
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

export async function removeManagedSiteBackupAttempt(stackDir: string): Promise<void> {
    await rm(managedSiteBackupAttemptPath(stackDir), { force: true });
}

/**
 * Remove one staging tree only when its device/inode pair is the one recorded
 * by the attempt. A replaced directory is left alone and reported.
 */
export async function removeManagedSiteBackupStaging(stackDir: string, attemptId: string, identity?: DirIdentity): Promise<boolean> {
    const staging = managedSiteBackupStagingDir(stackDir, attemptId);
    if (identity) {
        const current = await dirIdentity(staging).catch(() => null);
        if (!current || !sameDirIdentity(current, identity)) return false;
    } else {
        const info = await lstat(staging).catch(() => null);
        if (info?.isSymbolicLink()) return false;
    }
    await rm(staging, { recursive: true, force: true });
    return true;
}

/** The bounded database name or a refusal, shared by the dump adapter. */
export function managedSiteBackupDumpDatabase(
    manifest: ManagedSiteManifest,
): { ok: true; database: string } | { ok: false; reason: string } {
    const name = managedSiteBackupDatabaseName(manifest);
    if (!name || !isManagedSiteBackupDatabase(name) || name.length > MANAGED_SITE_BACKUP_DATABASE_MAX) {
        return { ok: false, reason: "The backup declares no valid database to dump." };
    }
    return { ok: true, database: name };
}
