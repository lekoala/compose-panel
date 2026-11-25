/**
 * One manual backup run (ADR 0049): stage the declared roots, optionally dump
 * one MariaDB database, upload with a pinned Restic container and verify the
 * exact snapshot. Every container runs from a fixed executable and an explicit
 * argument array. This module never uses a shell, never reads a credential
 * value and never starts a scheduler.
 */
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { runCommand, type CommandResult, type DockerRunner } from "./docker.ts";
import { dirIdentity, type DirIdentity } from "./fs-safe.ts";
import {
    MANAGED_SITE_BACKUP_DUMP_IMAGES,
    MANAGED_SITE_BACKUP_LIMITS,
    MANAGED_SITE_BACKUP_MAX_DUMP_BYTES,
    MANAGED_SITE_BACKUP_RESTIC_IMAGE,
    MANAGED_SITE_BACKUP_RESTIC_PASSWORD_FILE,
    MANAGED_SITE_BACKUP_REST_ENV_FILE,
    checkManagedSiteBackupCredentials,
    managedSiteBackupCredentialPath,
    managedSiteBackupDumpDatabase,
    managedSiteBackupStagingDir,
    readManagedSiteBackupAttempt,
    removeManagedSiteBackupAttempt,
    removeManagedSiteBackupStaging,
    stageManagedSiteBackup,
    writeManagedSiteBackupAttempt,
    type ManagedSiteBackupAttempt,
    type ManagedSiteBackupCheck,
    type ManagedSiteBackupInventoryEntry,
    type ManagedSiteBackupLimits,
    type ManagedSiteBackupPhase,
} from "./managed-site-backup.ts";
import type { ManagedSiteManifest } from "./managed-site.ts";

export const MANAGED_SITE_BACKUP_CONTAINER_TIMEOUT_MS = 30 * 60 * 1000;
export const MANAGED_SITE_BACKUP_OUTPUT_MAX_BYTES = 256 * 1024;

export interface ManagedSiteBackupRequest {
    stackDir: string;
    manifest: ManagedSiteManifest;
    attemptId: string;
    /** Release the site was serving when the backup started, if known. */
    releaseId: string | null;
    runtimeImage: { reference: string; id: string | null } | null;
    onOutput?: (chunk: string) => void;
    signal?: AbortSignal;
}

export interface ManagedSiteBackupDependencies {
    docker?: DockerRunner;
    now?: () => Date;
    limits?: ManagedSiteBackupLimits;
    timeoutMs?: number;
    /**
     * Test seam only: a disposable REST endpoint on the lab daemon can be
     * reached through host networking. Production callers never set it.
     */
    resticNetwork?: string;
    /** Test seam; production checks the fixed private files on disk. */
    checkCredentials?: (stackDir: string, manifest: ManagedSiteManifest) => Promise<ManagedSiteBackupCheck>;
}

export type ManagedSiteBackupResult =
    | {
          ok: true;
          snapshotId: string;
          entries: number;
          bytes: number;
          sqlBytes: number | null;
          stagingRemoved: boolean;
      }
    | { ok: false; reason: string; outcome: "failed" | "unknown" };

interface BackupSnapshotManifest {
    version: 1;
    siteId: string;
    attemptId: string;
    createdAt: string;
    release: string | null;
    runtimeImage: { reference: string; id: string | null } | null;
    mode: "files" | "files+sql";
    sql: { engine: "mariadb"; database: string; clientImage: string } | null;
    sqlBytes: number | null;
    consistency: "running";
    window: { startedAt: string; endedAt: string };
    inventory: ManagedSiteBackupInventoryEntry[];
}

function dockerRunner(dependencies: ManagedSiteBackupDependencies): DockerRunner {
    return dependencies.docker ?? ((args, options) => runCommand("docker", args, options));
}

function containerFailure(label: string, result: CommandResult): string {
    if (result.timedOut) return `${label} did not finish before the timeout.`;
    if (result.truncated) return `${label} produced more output than the panel keeps.`;
    const detail = result.stderr.trim().split("\n")[0]?.slice(0, 300);
    return detail ? `${label} failed: ${detail}` : `${label} failed with exit code ${result.code}.`;
}

/** Restic emits one JSON line per event; the summary carries the snapshot id. */
export function parseResticBackupSnapshot(stdout: string): string | null {
    for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) continue;
        try {
            const value = JSON.parse(trimmed) as Record<string, unknown>;
            if (value.message_type === "summary" && typeof value.snapshot_id === "string" && /^[0-9a-f]{64}$/.test(value.snapshot_id)) {
                return value.snapshot_id;
            }
        } catch {
            // A partial line is ignored; only a complete summary is accepted.
        }
    }
    return null;
}

/** `restic snapshots --json <id>` must return exactly that one snapshot. */
export function parseResticSnapshotList(stdout: string, snapshotId: string, siteId: string): boolean {
    let value: unknown;
    try {
        value = JSON.parse(stdout);
    } catch {
        return false;
    }
    if (!Array.isArray(value) || value.length !== 1) return false;
    const entry = value[0] as Record<string, unknown>;
    if (entry.id !== snapshotId) return false;
    const tags = entry.tags;
    return Array.isArray(tags) && tags.includes(`site:${siteId}`);
}

/** `restic ls --json <id>` must contain the snapshot manifest. */
export function parseResticListContains(stdout: string, path: string): boolean {
    for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) continue;
        try {
            const value = JSON.parse(trimmed) as Record<string, unknown>;
            if (value.path === path) return true;
        } catch {
            // Ignore partial lines.
        }
    }
    return false;
}

interface ResticContext {
    repository: string;
    passwordPath: string;
    restEnvPath: string;
    restEnvExists: boolean;
    stagingDir: string;
}

function resticCommand(context: ResticContext, command: string[], network?: string): string[] {
    return [
        "run",
        "--rm",
        ...(network ? ["--network", network] : []),
        "--read-only",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid",
        "--env",
        `RESTIC_REPOSITORY=${context.repository}`,
        "--env",
        "RESTIC_PASSWORD_FILE=/run/secrets/restic-password",
        "--env",
        "HOME=/tmp",
        ...(context.restEnvExists ? ["--env-file", context.restEnvPath] : []),
        "-v",
        `${context.stagingDir}:/backup:ro`,
        "-v",
        `${context.passwordPath}:/run/secrets/restic-password:ro`,
        MANAGED_SITE_BACKUP_RESTIC_IMAGE,
        ...command,
    ];
}

export async function runManagedSiteBackup(
    request: ManagedSiteBackupRequest,
    dependencies: ManagedSiteBackupDependencies = {},
): Promise<ManagedSiteBackupResult> {
    const { stackDir, manifest, attemptId } = request;
    const docker = dockerRunner(dependencies);
    const now = dependencies.now ?? (() => new Date());
    const limits = dependencies.limits ?? MANAGED_SITE_BACKUP_LIMITS;
    const timeoutMs = dependencies.timeoutMs ?? MANAGED_SITE_BACKUP_CONTAINER_TIMEOUT_MS;
    const output = request.onOutput ?? (() => {});
    const backup = manifest.backup;
    if (!backup) return { ok: false, reason: "This site declares no backup block.", outcome: "failed" };

    const credentials: ManagedSiteBackupCheck = await (dependencies.checkCredentials ?? checkManagedSiteBackupCredentials)(
        stackDir,
        manifest,
    );
    if (!credentials.ok) return { ok: false, reason: credentials.reason, outcome: "failed" };

    const previous = await readManagedSiteBackupAttempt(stackDir);
    if (previous.kind !== "none") {
        return {
            ok: false,
            reason: "A previous backup attempt has an unconfirmed outcome. Inspect the repository and acknowledge it before backing up again.",
            outcome: "failed",
        };
    }

    const startedAt = now().toISOString();
    let stagingIdentity: DirIdentity | undefined;
    let phase: ManagedSiteBackupPhase = "check";
    const attempt = (
        outcome: ManagedSiteBackupAttempt["outcome"],
        extra: Partial<ManagedSiteBackupAttempt> = {},
    ): ManagedSiteBackupAttempt => ({
        version: 1,
        siteId: manifest.siteId,
        attemptId,
        repository: backup.repository,
        startedAt,
        phase,
        outcome,
        ...(stagingIdentity ? { staging: stagingIdentity } : {}),
        ...extra,
    });

    const fail = async (reason: string, outcome: "failed" | "unknown" = "failed"): Promise<ManagedSiteBackupResult> => {
        output(`${reason}\n`);
        if (outcome === "unknown") {
            // A possibly-completed upload keeps its marker until acknowledged.
            await writeManagedSiteBackupAttempt(stackDir, attempt("failed", { reason })).catch(() => {});
        } else {
            await removeManagedSiteBackupAttempt(stackDir).catch(() => {});
        }
        if (stagingIdentity) await removeManagedSiteBackupStaging(stackDir, attemptId, stagingIdentity).catch(() => {});
        return { ok: false, reason, outcome };
    };

    try {
        await writeManagedSiteBackupAttempt(stackDir, attempt("pending"));
        // Create and anchor the staging tree before walking it, so a refusal
        // during the walk can still remove exactly the directory it created.
        const stagingDir = managedSiteBackupStagingDir(stackDir, attemptId);
        await mkdir(stagingDir, { recursive: true, mode: 0o700 });
        const identity = await dirIdentity(stagingDir);
        stagingIdentity = identity;
        const staged = await stageManagedSiteBackup(stackDir, manifest, attemptId, {
            maxEntries: limits.maxEntries,
            maxBytes: limits.maxBytes,
        });
        if (!staged.ok) return await fail(staged.reason);

        let sqlBytes: number | null = null;
        const dump = backup.sql ? managedSiteBackupDumpDatabase(manifest) : null;
        if (backup.sql && !dump?.ok) return await fail(dump?.reason ?? "The backup declares no valid database to dump.");
        if (backup.sql && dump?.ok) {
            phase = "dump";
            await writeManagedSiteBackupAttempt(stackDir, attempt("pending"));
            const database = manifest.database;
            if (!database) return await fail("A SQL backup requires an attached database.");
            const name = `cp-backup-dump-${attemptId}`;
            const dumpArgs = [
                "run",
                "--rm",
                "--name",
                name,
                "--network",
                database.network,
                "--env-file",
                managedSiteBackupCredentialPath(stackDir, "database.env"),
                "--tmpfs",
                "/tmp:rw,noexec,nosuid",
                "-v",
                `${staged.stagingDir}:/backup:rw`,
                MANAGED_SITE_BACKUP_DUMP_IMAGES.mariadb,
                "mariadb-dump",
                "--single-transaction",
                "--quick",
                "--skip-lock-tables",
                "--routines",
                "--events",
                "--triggers",
                "--result-file=/backup/database.sql",
                "--databases",
                dump.database,
            ];
            const result = await docker(dumpArgs, {
                timeoutMs,
                maxBytes: MANAGED_SITE_BACKUP_OUTPUT_MAX_BYTES,
                cwd: stackDir,
                ...(request.signal ? { signal: request.signal } : {}),
            });
            if (result.code !== 0 || result.timedOut || result.truncated) {
                await docker(["rm", "-f", name], { timeoutMs: 60_000, maxBytes: MANAGED_SITE_BACKUP_OUTPUT_MAX_BYTES }).catch(() => {});
                return await fail(containerFailure("The database dump", result));
            }
            const dumpPath = `${staged.stagingDir}/database.sql`;
            const dumpInfo = await lstat(dumpPath).catch(() => null);
            if (!dumpInfo || !dumpInfo.isFile() || dumpInfo.size === 0) {
                return await fail("The database dump produced no file.");
            }
            if (dumpInfo.size > MANAGED_SITE_BACKUP_MAX_DUMP_BYTES) {
                return await fail(`The database dump is larger than ${MANAGED_SITE_BACKUP_MAX_DUMP_BYTES} bytes.`);
            }
            sqlBytes = dumpInfo.size;
        }

        const endedAt = now().toISOString();
        const snapshotManifest: BackupSnapshotManifest = {
            version: 1,
            siteId: manifest.siteId,
            attemptId,
            createdAt: endedAt,
            release: request.releaseId,
            runtimeImage: request.runtimeImage,
            mode: backup.sql ? "files+sql" : "files",
            sql: backup.sql
                ? { engine: "mariadb", database: backup.sql.database, clientImage: MANAGED_SITE_BACKUP_DUMP_IMAGES.mariadb }
                : null,
            sqlBytes,
            consistency: "running",
            window: { startedAt, endedAt },
            inventory: staged.inventory,
        };
        await writeFile(`${staged.stagingDir}/backup.json`, `${JSON.stringify(snapshotManifest)}\n`, { mode: 0o600 });

        const restic: ResticContext = {
            repository: backup.repository,
            passwordPath: managedSiteBackupCredentialPath(stackDir, MANAGED_SITE_BACKUP_RESTIC_PASSWORD_FILE),
            restEnvPath: managedSiteBackupCredentialPath(stackDir, MANAGED_SITE_BACKUP_REST_ENV_FILE),
            stagingDir: staged.stagingDir,
            restEnvExists: await lstat(managedSiteBackupCredentialPath(stackDir, MANAGED_SITE_BACKUP_REST_ENV_FILE))
                .then((info) => info.isFile())
                .catch(() => false),
        };

        phase = "upload";
        await writeManagedSiteBackupAttempt(stackDir, attempt("pending"));
        const resticName = `cp-backup-restic-${attemptId}`;
        const uploaded = await docker(
            resticCommand(
                restic,
                ["backup", "--json", "--tag", `site:${manifest.siteId}`, "--tag", `attempt:${attemptId}`, "/backup"],
                dependencies.resticNetwork,
            ),
            {
                timeoutMs,
                maxBytes: MANAGED_SITE_BACKUP_OUTPUT_MAX_BYTES,
                cwd: stackDir,
                ...(request.signal ? { signal: request.signal } : {}),
            },
        );
        if (uploaded.code !== 0 || uploaded.timedOut || uploaded.truncated) {
            await docker(["rm", "-f", resticName], { timeoutMs: 60_000, maxBytes: MANAGED_SITE_BACKUP_OUTPUT_MAX_BYTES }).catch(() => {});
            return await fail(containerFailure("The upload", uploaded), uploaded.timedOut ? "unknown" : "failed");
        }
        const snapshotId = parseResticBackupSnapshot(uploaded.stdout);
        if (!snapshotId) return await fail("The upload returned no snapshot id.", "unknown");

        phase = "verify";
        await writeManagedSiteBackupAttempt(stackDir, attempt("pending", { snapshotId }));
        const listed = await docker(resticCommand(restic, ["snapshots", "--json", snapshotId], dependencies.resticNetwork), {
            timeoutMs,
            maxBytes: MANAGED_SITE_BACKUP_OUTPUT_MAX_BYTES,
            cwd: stackDir,
            ...(request.signal ? { signal: request.signal } : {}),
        });
        if (listed.code !== 0 || listed.timedOut || listed.truncated) {
            return await fail(containerFailure("The snapshot check", listed), "unknown");
        }
        if (!parseResticSnapshotList(listed.stdout, snapshotId, manifest.siteId)) {
            return await fail("The repository did not return the exact uploaded snapshot.", "unknown");
        }
        const contents = await docker(resticCommand(restic, ["ls", "--json", snapshotId], dependencies.resticNetwork), {
            timeoutMs,
            maxBytes: MANAGED_SITE_BACKUP_OUTPUT_MAX_BYTES,
            cwd: stackDir,
            ...(request.signal ? { signal: request.signal } : {}),
        });
        if (contents.code !== 0 || contents.timedOut || contents.truncated) {
            return await fail(containerFailure("The snapshot content check", contents), "unknown");
        }
        if (!parseResticListContains(contents.stdout, "/backup/backup.json")) {
            return await fail("The snapshot does not contain its own manifest.", "unknown");
        }

        phase = "complete";
        await writeManagedSiteBackupAttempt(stackDir, attempt("complete", { snapshotId }));
        const removed = await removeManagedSiteBackupStaging(stackDir, attemptId, identity).catch(() => false);
        if (removed) await removeManagedSiteBackupAttempt(stackDir).catch(() => {});
        output(`Snapshot ${snapshotId} accepted.\n`);
        return { ok: true, snapshotId, entries: staged.entries, bytes: staged.bytes, sqlBytes, stagingRemoved: removed };
    } catch (error) {
        const detail = error instanceof Error ? error.message : "unknown error";
        return await fail(`The backup stopped unexpectedly: ${detail}`, "unknown");
    }
}
