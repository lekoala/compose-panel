/**
 * Read-only snapshot inventory for restore selection (ADR 0053).
 *
 * The restore form needs one exact snapshot id (ADR 0049). This module lists
 * this site's tagged snapshots with the same pinned Restic image, argument
 * builder and parser as the retention preview (ADR 0052). It deletes nothing,
 * stores nothing and takes no maintenance credential.
 */
import { runCommand, type CommandResult, type DockerRunner } from "./docker.ts";
import { managedSiteResticContext } from "./managed-site-backup.ts";
import {
    MANAGED_SITE_BACKUP_RETENTION_OUTPUT_MAX_BYTES,
    managedSiteBackupInventoryArgs,
    parseManagedSiteBackupInventory,
    type ManagedSiteBackupSnapshot,
} from "./managed-site-backup-retention.ts";
import { managedSiteResticCommand } from "./managed-site-restic.ts";
import type { ManagedSiteManifest } from "./managed-site.ts";

export const MANAGED_SITE_BACKUP_SNAPSHOT_LIST_TIMEOUT_MS = 2 * 60 * 1000;
export const MANAGED_SITE_BACKUP_SNAPSHOT_LIST_OUTPUT_MAX_BYTES = MANAGED_SITE_BACKUP_RETENTION_OUTPUT_MAX_BYTES;

export interface ManagedSiteBackupSnapshotListRequest {
    stackDir: string;
    manifest: ManagedSiteManifest;
    signal?: AbortSignal;
}

export interface ManagedSiteBackupSnapshotListDependencies {
    docker?: DockerRunner;
    timeoutMs?: number;
    /** Test seam only: a disposable REST endpoint on the lab daemon. */
    resticNetwork?: string;
}

export type ManagedSiteBackupSnapshotListResult = { ok: true; snapshots: ManagedSiteBackupSnapshot[] } | { ok: false; reason: string };

/**
 * Restic's timestamp is authoritative for display. The id breaks a tie so the
 * page order is deterministic even when two snapshots share a second.
 */
export function managedSiteBackupSnapshotsNewestFirst(snapshots: readonly ManagedSiteBackupSnapshot[]): ManagedSiteBackupSnapshot[] {
    const time = (snapshot: ManagedSiteBackupSnapshot): number => {
        const parsed = Date.parse(snapshot.at);
        return Number.isFinite(parsed) ? parsed : 0;
    };
    return [...snapshots].sort((left, right) => time(right) - time(left) || left.id.localeCompare(right.id));
}

function commandFailure(result: CommandResult): string {
    if (result.timedOut) return "The snapshot list did not finish before the timeout; no snapshot was read.";
    if (result.truncated) return "The snapshot list produced more output than the panel keeps; no snapshot was shown.";
    const detail = result.stderr.trim().split("\n")[0]?.slice(0, 300);
    return detail ? `The snapshot list failed: ${detail}` : `The snapshot list failed with exit code ${result.code}.`;
}

/**
 * Read this site's tagged snapshots and return them newest first. The call is
 * one fixed `snapshots --json --no-lock --tag site:<id>`; it never passes a
 * snapshot id, `forget`, `prune` or any other repository mutation.
 */
export async function runManagedSiteBackupSnapshotList(
    request: ManagedSiteBackupSnapshotListRequest,
    dependencies: ManagedSiteBackupSnapshotListDependencies = {},
): Promise<ManagedSiteBackupSnapshotListResult> {
    const { stackDir, manifest } = request;
    const backup = manifest.backup;
    if (!backup) return { ok: false, reason: "This site declares no backup block." };
    const docker: DockerRunner = dependencies.docker ?? ((args, options) => runCommand("docker", args, options));
    const restic = await managedSiteResticContext(stackDir, backup.repository);
    const listed = await docker(
        managedSiteResticCommand(restic, managedSiteBackupInventoryArgs(manifest.siteId), [], dependencies.resticNetwork),
        {
            timeoutMs: dependencies.timeoutMs ?? MANAGED_SITE_BACKUP_SNAPSHOT_LIST_TIMEOUT_MS,
            maxBytes: MANAGED_SITE_BACKUP_SNAPSHOT_LIST_OUTPUT_MAX_BYTES,
            cwd: stackDir,
            ...(request.signal ? { signal: request.signal } : {}),
        },
    );
    if (listed.code !== 0 || listed.timedOut || listed.truncated) return { ok: false, reason: commandFailure(listed) };
    const inventory = parseManagedSiteBackupInventory(listed.stdout, manifest.siteId);
    if (!inventory.ok) return { ok: false, reason: inventory.reason };
    return { ok: true, snapshots: managedSiteBackupSnapshotsNewestFirst(inventory.snapshots) };
}
