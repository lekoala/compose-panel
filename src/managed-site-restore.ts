/**
 * Verified restore of one offsite snapshot (ADR 0049).
 *
 * The panel restores into a new private directory and, for a SQL snapshot, into
 * a fresh disposable MariaDB instance with no production credentials, no
 * production network and no published port. It never writes over `shared/`, a
 * release or the pointer. Extraction is validated against the inventory and
 * hashes recorded by the backup; the SQL file is imported with a fixed client
 * command and checked with one bounded query.
 */
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, open, readdir } from "node:fs/promises";
import { dirIdentity, type DirIdentity } from "./fs-safe.ts";
import { runCommand, type CommandResult, type DockerRunner } from "./docker.ts";
import {
    MANAGED_SITE_BACKUP_DUMP_IMAGES,
    MANAGED_SITE_BACKUP_LIMITS,
    MANAGED_SITE_BACKUP_MAX_DUMP_BYTES,
    MANAGED_SITE_BACKUP_RESTIC_PASSWORD_FILE,
    MANAGED_SITE_BACKUP_REST_ENV_FILE,
    checkManagedSiteBackupCredentials,
    managedSiteBackupCredentialPath,
    managedSiteBackupDir,
    readManagedSiteBackupAttempt,
    type ManagedSiteBackupCheck,
} from "./managed-site-backup.ts";
import {
    MANAGED_SITE_RESTIC_MANIFEST_MAX_BYTES,
    managedSiteResticCommand,
    parseResticListContains,
    parseResticSnapshotList,
    type ManagedSiteResticContext,
} from "./managed-site-restic.ts";
import { isManagedSiteBackupDatabase, type ManagedSiteManifest } from "./managed-site.ts";

export const MANAGED_SITE_RESTORE_DIR = "restore";
export const MANAGED_SITE_RESTORE_CONTAINER_TIMEOUT_MS = 15 * 60 * 1000;
export const MANAGED_SITE_RESTORE_OUTPUT_MAX_BYTES = 256 * 1024;
export const MANAGED_SITE_RESTORE_READY_TIMEOUT_MS = 60_000;
export const MANAGED_SITE_RESTORE_MAX_ENTRIES = MANAGED_SITE_BACKUP_LIMITS.maxEntries;

export interface ManagedSiteRestoreRequest {
    stackDir: string;
    manifest: ManagedSiteManifest;
    attemptId: string;
    snapshotId: string;
    onOutput?: (chunk: string) => void;
    signal?: AbortSignal;
}

export interface ManagedSiteRestoreDependencies {
    docker?: DockerRunner;
    timeoutMs?: number;
    /** Test seam only, like the backup runner's REST network. */
    resticNetwork?: string;
    checkCredentials?: (stackDir: string, manifest: ManagedSiteManifest) => Promise<ManagedSiteBackupCheck>;
    readyTimeoutMs?: number;
}

export interface ManagedSiteRestoreSqlResult {
    imported: true;
    database: string;
    tables: number;
    network: string;
    serverContainer: string;
}

export type ManagedSiteRestoreResult =
    | {
          ok: true;
          snapshotId: string;
          restoreDir: string;
          files: number;
          bytes: number;
          completed: ("files" | "sql")[];
          sql: ManagedSiteRestoreSqlResult | null;
      }
    | {
          ok: false;
          phase: "check" | "extract" | "verify" | "sql";
          reason: string;
          completed: ("files" | "sql")[];
          restoreDir: string | null;
      };

interface RestoreSnapshotManifest {
    mode: "files" | "files+sql";
    sql: { engine: "mariadb"; database: string; clientImage: string } | null;
    sqlBytes: number | null;
    inventory: { path: string; type: "file"; size: number; sha256: string }[];
}

export function managedSiteRestoreDir(stackDir: string, attemptId: string): string {
    return `${managedSiteBackupDir(stackDir)}/${MANAGED_SITE_RESTORE_DIR}/${attemptId}`;
}

export function isManagedSiteSnapshotId(value: string): boolean {
    return /^[0-9a-f]{64}$/.test(value);
}

/**
 * Parse and bound the snapshot manifest. It must describe this site, the
 * declared SQL shape and one coherent file inventory before anything is
 * extracted.
 */
export function parseRestoreSnapshotManifest(
    source: string,
    manifest: ManagedSiteManifest,
    limits = { maxEntries: MANAGED_SITE_BACKUP_LIMITS.maxEntries, maxBytes: MANAGED_SITE_BACKUP_LIMITS.maxBytes },
): { ok: true; snapshot: RestoreSnapshotManifest } | { ok: false; reason: string } {
    if (Buffer.byteLength(source, "utf8") > MANAGED_SITE_RESTIC_MANIFEST_MAX_BYTES) {
        return { ok: false, reason: "The snapshot manifest is larger than the panel accepts." };
    }
    let value: unknown;
    try {
        value = JSON.parse(source);
    } catch {
        return { ok: false, reason: "The snapshot manifest is not valid JSON." };
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return { ok: false, reason: "The snapshot manifest must be a JSON object." };
    }
    const record = value as Record<string, unknown>;
    if (record.version !== 1) return { ok: false, reason: "The snapshot manifest version is not supported." };
    if (record.siteId !== manifest.siteId) {
        return { ok: false, reason: "This snapshot belongs to another site; refusing to restore it here." };
    }
    if (record.mode !== "files" && record.mode !== "files+sql") {
        return { ok: false, reason: "The snapshot mode is not supported." };
    }
    let sql: RestoreSnapshotManifest["sql"] = null;
    let sqlBytes: number | null = null;
    if (record.mode === "files+sql") {
        const candidate = record.sql as Record<string, unknown> | null;
        if (
            !candidate ||
            candidate.engine !== "mariadb" ||
            typeof candidate.database !== "string" ||
            !isManagedSiteBackupDatabase(candidate.database)
        ) {
            return { ok: false, reason: "The snapshot SQL block is not a bounded MariaDB database." };
        }
        if (!manifest.backup?.sql || manifest.database?.engine !== "mariadb") {
            return { ok: false, reason: "This site no longer declares a compatible MariaDB backup; refusing to import the snapshot." };
        }
        if (manifest.backup.sql.engine !== "mariadb" || manifest.backup.sql.database !== candidate.database) {
            return { ok: false, reason: "The snapshot database does not match the declared backup database." };
        }
        if (
            typeof record.sqlBytes !== "number" ||
            !Number.isInteger(record.sqlBytes) ||
            record.sqlBytes <= 0 ||
            record.sqlBytes > MANAGED_SITE_BACKUP_MAX_DUMP_BYTES
        ) {
            return { ok: false, reason: "The snapshot SQL size is missing or out of bounds." };
        }
        sqlBytes = record.sqlBytes;
        sql = { engine: "mariadb", database: candidate.database, clientImage: String(candidate.clientImage ?? "unknown") };
    } else if (manifest.backup?.sql) {
        return { ok: false, reason: "The snapshot has no SQL, but the site declares a SQL backup; refusing to call this a full restore." };
    }
    if (!Array.isArray(record.inventory) || record.inventory.length === 0 || record.inventory.length > limits.maxEntries) {
        return { ok: false, reason: "The snapshot inventory is missing or out of bounds." };
    }
    const seen = new Set<string>();
    let bytes = 0;
    const inventory: RestoreSnapshotManifest["inventory"] = [];
    for (const entry of record.inventory) {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
            return { ok: false, reason: "The snapshot inventory contains an invalid entry." };
        }
        const item = entry as Record<string, unknown>;
        const path = item.path;
        if (
            typeof path !== "string" ||
            !path.startsWith("files/") ||
            path.includes("..") ||
            path.includes("\\") ||
            path.length > 1024 ||
            (item.type !== "file" && item.type !== "dir") ||
            typeof item.size !== "number" ||
            !Number.isInteger(item.size) ||
            item.size < 0
        ) {
            return { ok: false, reason: "The snapshot inventory contains an unsafe entry." };
        }
        if (item.type === "file" && (typeof item.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(item.sha256))) {
            return { ok: false, reason: "The snapshot inventory is missing a file hash." };
        }
        if (seen.has(path)) return { ok: false, reason: "The snapshot inventory repeats a path." };
        seen.add(path);
        if (item.type === "file") {
            bytes += item.size as number;
            if (bytes > limits.maxBytes) return { ok: false, reason: "The snapshot inventory exceeds the restore size limit." };
            inventory.push({ path, type: "file", size: item.size as number, sha256: item.sha256 as string });
        }
    }
    if (inventory.length === 0) return { ok: false, reason: "The snapshot inventory lists no file." };
    return { ok: true, snapshot: { mode: record.mode, sql, sqlBytes, inventory } };
}

interface RestoreTreeCheck {
    ok: true;
    files: number;
    bytes: number;
}

async function hashFile(path: string, maxBytes: number): Promise<{ size: number; sha256: string } | null> {
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > maxBytes) return null;
        const hash = createHash("sha256");
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let position = 0;
        for (;;) {
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
            if (bytesRead === 0) break;
            position += bytesRead;
            hash.update(buffer.subarray(0, bytesRead));
        }
        return position === info.size ? { size: position, sha256: hash.digest("hex") } : null;
    } finally {
        await handle.close().catch(() => {});
    }
}

/**
 * Validate the extracted `backup/files` tree against the inventory: only
 * regular files and directories, no links or special files, exact path set,
 * exact sizes and exact SHA-256.
 */
async function verifyRestoreTree(
    root: string,
    snapshot: RestoreSnapshotManifest,
    limits = { maxEntries: MANAGED_SITE_BACKUP_LIMITS.maxEntries, maxBytes: MANAGED_SITE_BACKUP_LIMITS.maxBytes },
): Promise<RestoreTreeCheck | { ok: false; reason: string }> {
    const expected = new Map(snapshot.inventory.map((entry) => [entry.path, entry]));
    const found = new Set<string>();
    let entries = 0;
    let bytes = 0;
    const walk = async (absolute: string, relative: string): Promise<RestoreTreeCheck | { ok: false; reason: string }> => {
        let info: Stats;
        try {
            info = await lstat(absolute);
        } catch {
            return { ok: false, reason: `The restored entry "${relative}" is missing.` };
        }
        if (info.isSymbolicLink()) return { ok: false, reason: `The restored entry "${relative}" is a symbolic link.` };
        entries += 1;
        if (entries > limits.maxEntries) return { ok: false, reason: "The restored tree contains too many entries." };
        if (info.isDirectory()) {
            const children = await readdir(absolute, { withFileTypes: true });
            for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
                const result = await walk(`${absolute}/${child.name}`, `${relative}/${child.name}`);
                if (result.ok === false) return result;
            }
            return { ok: true, files: 0, bytes: 0 };
        }
        if (!info.isFile()) return { ok: false, reason: `The restored entry "${relative}" is not a regular file.` };
        if (info.nlink !== 1) return { ok: false, reason: `The restored entry "${relative}" is a hard link.` };
        const expectedEntry = expected.get(relative);
        if (!expectedEntry) return { ok: false, reason: `The restored tree contains the unexpected file "${relative}".` };
        if (info.size !== expectedEntry.size) return { ok: false, reason: `The restored file "${relative}" has an unexpected size.` };
        const hashed = await hashFile(absolute, limits.maxBytes);
        if (!hashed || hashed.sha256 !== expectedEntry.sha256)
            return { ok: false, reason: `The restored file "${relative}" does not match its recorded hash.` };
        found.add(relative);
        bytes += info.size;
        return { ok: true, files: 1, bytes: info.size };
    };
    const treeRoot = `${root}/backup/files`;
    const treeInfo = await lstat(treeRoot).catch(() => null);
    if (!treeInfo || treeInfo.isSymbolicLink() || !treeInfo.isDirectory()) {
        return { ok: false, reason: "The snapshot contains no safe files directory." };
    }
    const result = await walk(treeRoot, "files");
    if (result.ok === false) return result;
    // `walk` returns per-call counters; recompute the accepted totals here.
    if (found.size !== expected.size) return { ok: false, reason: "The restored tree does not match the recorded inventory." };
    const total = snapshot.inventory.reduce((sum, entry) => sum + entry.size, 0);
    return { ok: true, files: found.size, bytes: total };
}

function containerFailure(label: string, result: CommandResult): string {
    if (result.timedOut) return `${label} did not finish before the timeout.`;
    if (result.truncated) return `${label} produced more output than the panel keeps.`;
    const detail = result.stderr.trim().split("\n")[0]?.slice(0, 300);
    return detail ? `${label} failed: ${detail}` : `${label} failed with exit code ${result.code}.`;
}

export async function runManagedSiteRestore(
    request: ManagedSiteRestoreRequest,
    dependencies: ManagedSiteRestoreDependencies = {},
): Promise<ManagedSiteRestoreResult> {
    const { stackDir, manifest, attemptId, snapshotId } = request;
    const docker = dependencies.docker ?? ((args, options) => runCommand("docker", args, options));
    const timeoutMs = dependencies.timeoutMs ?? MANAGED_SITE_RESTORE_CONTAINER_TIMEOUT_MS;
    const output = request.onOutput ?? (() => {});
    const completed: ("files" | "sql")[] = [];
    let phase: "check" | "extract" | "verify" | "sql" = "check";
    let restoreDir: string | null = null;
    let network: string | null = null;
    let server: string | null = null;
    const resticContainer = `cp-restore-restic-${attemptId}`;

    const fail = (reason: string): ManagedSiteRestoreResult => {
        output(`${reason}\n`);
        return { ok: false, phase, reason, completed: [...completed], restoreDir };
    };

    const backup = manifest.backup;
    if (!backup) return fail("This site declares no backup block.");
    if (!isManagedSiteSnapshotId(snapshotId)) return fail("Select one exact 64-character hexadecimal snapshot id; latest is refused.");
    const credentials = await (dependencies.checkCredentials ?? checkManagedSiteBackupCredentials)(stackDir, manifest);
    if (!credentials.ok) return fail(credentials.reason);
    const previous = await readManagedSiteBackupAttempt(stackDir);
    if (previous.kind !== "none") {
        return fail("A previous backup attempt has an unconfirmed outcome. Inspect the repository and acknowledge it before restoring.");
    }

    restoreDir = managedSiteRestoreDir(stackDir, attemptId);
    let identity: DirIdentity | undefined;
    try {
        await mkdir(restoreDir, { recursive: true, mode: 0o700 });
        identity = await dirIdentity(restoreDir);
        const restic: ManagedSiteResticContext = {
            repository: backup.repository,
            passwordPath: managedSiteBackupCredentialPath(stackDir, MANAGED_SITE_BACKUP_RESTIC_PASSWORD_FILE),
            restEnvPath: managedSiteBackupCredentialPath(stackDir, MANAGED_SITE_BACKUP_REST_ENV_FILE),
            restEnvExists: await lstat(managedSiteBackupCredentialPath(stackDir, MANAGED_SITE_BACKUP_REST_ENV_FILE))
                .then((info) => info.isFile())
                .catch(() => false),
        };
        const runRestic = (command: string[], mounts: string[] = [], maxBytes = MANAGED_SITE_RESTORE_OUTPUT_MAX_BYTES) =>
            docker(managedSiteResticCommand(restic, command, mounts, dependencies.resticNetwork, resticContainer), {
                timeoutMs,
                maxBytes,
                cwd: stackDir,
                ...(request.signal ? { signal: request.signal } : {}),
            });

        const listed = await runRestic(["snapshots", "--json", snapshotId]);
        if (listed.code !== 0 || listed.timedOut || listed.truncated) return fail(containerFailure("The snapshot check", listed));
        if (!parseResticSnapshotList(listed.stdout, snapshotId, manifest.siteId)) {
            return fail("This repository did not return exactly the selected snapshot for this site.");
        }
        const tree = await runRestic(["ls", "--json", snapshotId]);
        if (tree.code !== 0 || tree.timedOut || tree.truncated) return fail(containerFailure("The snapshot listing", tree));
        if (!parseResticListContains(tree.stdout, "/backup/backup.json")) {
            return fail("The snapshot does not contain its own manifest.");
        }
        const dumped = await runRestic(["dump", snapshotId, "/backup/backup.json"], [], MANAGED_SITE_RESTIC_MANIFEST_MAX_BYTES);
        if (dumped.code !== 0 || dumped.timedOut || dumped.truncated) return fail(containerFailure("The snapshot manifest read", dumped));
        const parsed = parseRestoreSnapshotManifest(dumped.stdout, manifest);
        if (!parsed.ok) return fail(parsed.reason);
        const snapshot = parsed.snapshot;

        phase = "extract";
        const includes = ["--include", "/backup/files", ...(snapshot.mode === "files+sql" ? ["--include", "/backup/database.sql"] : [])];
        const extracted = await runRestic(
            ["restore", snapshotId, "--target", "/restore", ...includes],
            [`${restoreDir}:/restore`],
            timeoutMs,
        );
        if (extracted.code !== 0 || extracted.timedOut || extracted.truncated) {
            return fail(containerFailure("The extraction", extracted));
        }

        phase = "verify";
        const verified = await verifyRestoreTree(restoreDir, snapshot);
        if (verified.ok === false) return fail(verified.reason);
        const files = verified.files;
        const bytes = verified.bytes;
        completed.push("files");
        output(`Restored ${files} files (${bytes} bytes) from ${snapshotId} into ${restoreDir}.\n`);

        let sql: ManagedSiteRestoreSqlResult | null = null;
        if (snapshot.mode === "files+sql" && snapshot.sql) {
            phase = "sql";
            const database = snapshot.sql.database;
            const dumpPath = `${restoreDir}/backup/database.sql`;
            const dumpInfo = await lstat(dumpPath).catch(() => null);
            if (!dumpInfo || !dumpInfo.isFile() || dumpInfo.size !== snapshot.sqlBytes) {
                return fail("The restored SQL file is missing or does not match its recorded size.");
            }
            network = `cp-restore-${attemptId}`;
            server = `cp-restore-db-${attemptId}`;
            const networkCreated = await docker(["network", "create", "--internal", network], {
                timeoutMs: 60_000,
                maxBytes: MANAGED_SITE_RESTORE_OUTPUT_MAX_BYTES,
            });
            if (networkCreated.code !== 0 || networkCreated.timedOut || networkCreated.truncated) {
                return fail(containerFailure("The disposable restore network", networkCreated));
            }
            const started = await docker(
                [
                    "run",
                    "-d",
                    "--rm",
                    "--name",
                    server,
                    "--network",
                    network,
                    "--tmpfs",
                    "/var/lib/mysql:rw",
                    "--tmpfs",
                    "/run/mysqld:rw",
                    "-e",
                    "MARIADB_ALLOW_EMPTY_ROOT_PASSWORD=1",
                    "-e",
                    "MARIADB_ROOT_HOST=%",
                    MANAGED_SITE_BACKUP_DUMP_IMAGES.mariadb,
                ],
                { timeoutMs: 120_000, maxBytes: MANAGED_SITE_RESTORE_OUTPUT_MAX_BYTES, cwd: stackDir },
            );
            if (started.code !== 0 || started.timedOut || started.truncated) {
                return fail(containerFailure("The disposable database start", started));
            }
            const readyDeadline = Date.now() + (dependencies.readyTimeoutMs ?? MANAGED_SITE_RESTORE_READY_TIMEOUT_MS);
            let ready = false;
            while (!ready && Date.now() < readyDeadline) {
                // Check readiness over the same TCP path the import uses, with
                // the same pinned client and no TLS (private attempt network).
                const ping = await docker(
                    [
                        "run",
                        "--rm",
                        "--network",
                        network,
                        MANAGED_SITE_BACKUP_DUMP_IMAGES.mariadb,
                        "mariadb",
                        "--host",
                        server,
                        "--user",
                        "root",
                        "--skip-ssl",
                        "-e",
                        "SELECT 1",
                    ],
                    { timeoutMs: 20_000, maxBytes: MANAGED_SITE_RESTORE_OUTPUT_MAX_BYTES, cwd: stackDir },
                );
                ready = ping.code === 0 && !ping.timedOut;
                if (!ready) await Bun.sleep(500);
            }
            if (!ready) return fail("The disposable database did not become ready.");
            const imported = await docker(
                [
                    "run",
                    "--rm",
                    "--network",
                    network,
                    "-v",
                    `${restoreDir}/backup:/backup:ro`,
                    MANAGED_SITE_BACKUP_DUMP_IMAGES.mariadb,
                    "mariadb",
                    "--host",
                    server,
                    "--user",
                    "root",
                    "--skip-ssl",
                    "--execute",
                    "source /backup/database.sql",
                ],
                { timeoutMs: 120_000, maxBytes: MANAGED_SITE_RESTORE_OUTPUT_MAX_BYTES, cwd: stackDir },
            );
            if (imported.code !== 0 || imported.timedOut || imported.truncated) {
                return fail(containerFailure("The SQL import", imported));
            }
            const checked = await docker(
                [
                    "run",
                    "--rm",
                    "--network",
                    network,
                    MANAGED_SITE_BACKUP_DUMP_IMAGES.mariadb,
                    "mariadb",
                    "--host",
                    server,
                    "--user",
                    "root",
                    "--skip-ssl",
                    "--skip-column-names",
                    "--execute",
                    `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '${database}'`,
                ],
                { timeoutMs: 60_000, maxBytes: MANAGED_SITE_RESTORE_OUTPUT_MAX_BYTES, cwd: stackDir },
            );
            if (checked.code !== 0 || checked.timedOut || checked.truncated) {
                return fail(containerFailure("The SQL verification", checked));
            }
            const tables = Number(checked.stdout.trim());
            if (!Number.isInteger(tables) || tables <= 0) {
                return fail("The restored database contains no table.");
            }
            completed.push("sql");
            sql = {
                imported: true,
                database,
                tables,
                network,
                serverContainer: server,
            };
            output(`Imported database "${database}" into a disposable MariaDB instance; ${tables} table(s) present.\n`);
        }

        return {
            ok: true,
            snapshotId,
            restoreDir,
            files,
            bytes,
            completed,
            sql,
        };
    } catch (error) {
        return fail(`The restore stopped unexpectedly: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
        // Disposable resources only. The restore directory stays private for
        // inspection, and nothing is written back to the live site.
        // A restic container whose client timed out keeps its name, so this is
        // the one place that proves it stopped.
        await docker(["rm", "-f", resticContainer], { timeoutMs: 60_000, maxBytes: MANAGED_SITE_RESTORE_OUTPUT_MAX_BYTES }).catch(() => {});
        if (server)
            await docker(["rm", "-f", server], { timeoutMs: 60_000, maxBytes: MANAGED_SITE_RESTORE_OUTPUT_MAX_BYTES }).catch(() => {});
        if (network)
            await docker(["network", "rm", network], { timeoutMs: 60_000, maxBytes: MANAGED_SITE_RESTORE_OUTPUT_MAX_BYTES }).catch(
                () => {},
            );
        if (identity) {
            // Keep the directory but prove its identity is still the one created.
            const current = await dirIdentity(restoreDir).catch(() => null);
            if (!current || current.dev !== identity.dev || current.ino !== identity.ino) {
                output("The restore directory changed identity while the restore ran; inspect it on the host.\n");
            }
        }
    }
}
