/**
 * Read-only retention measurement for one managed site (ADR 0052).
 *
 * The panel forwards the declared `backup.retention` counts to the pinned Restic
 * client and reads its own answer: `snapshots` for the site inventory and
 * `forget --dry-run` for the keep/remove split. Nothing here deletes a snapshot,
 * takes a maintenance credential or reimplements Restic's calendar rules. The
 * real `forget`/`prune` stays an operator procedure on the maintenance host.
 */
import { runCommand, type CommandResult, type DockerRunner } from "./docker.ts";
import { managedSiteResticContext } from "./managed-site-backup.ts";
import { managedSiteResticCommand } from "./managed-site-restic.ts";
import { MANAGED_SITE_BACKUP_RETENTION_KEYS, type ManagedSiteBackupRetention, type ManagedSiteManifest } from "./managed-site.ts";

export const MANAGED_SITE_BACKUP_RETENTION_TIMEOUT_MS = 5 * 60 * 1000;
export const MANAGED_SITE_BACKUP_RETENTION_OUTPUT_MAX_BYTES = 2 * 1024 * 1024;
export const MANAGED_SITE_BACKUP_RETENTION_MAX_SNAPSHOTS = 2000;

const SNAPSHOT_ID = /^[0-9a-f]{64}$/;
/** Restic marshals Go `time.Time` as RFC 3339 with an optional nanosecond part. */
const RESTIC_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** One snapshot reference the preview reports; never a path or a tag list. */
export interface ManagedSiteBackupSnapshot {
    id: string;
    /** Restic's own timestamp string, bounded and unparsed for display. */
    at: string;
}

export function managedSiteBackupRetentionFlag(key: (typeof MANAGED_SITE_BACKUP_RETENTION_KEYS)[number]): string {
    return `keep-${key.slice("keep".length).toLowerCase()}`;
}

/** Compact summary of the declared counts, e.g. `keep-last 7, keep-daily 14`. */
export function managedSiteBackupRetentionSummary(policy: ManagedSiteBackupRetention): string {
    return MANAGED_SITE_BACKUP_RETENTION_KEYS.filter((key) => policy[key] !== undefined)
        .map((key) => `${managedSiteBackupRetentionFlag(key)} ${String(policy[key])}`)
        .join(", ");
}

/** The site tag that scopes every retention call to this site's snapshots. */
function siteTag(siteId: string): string {
    return `site:${siteId}`;
}

/**
 * `restic snapshots` arguments. `--no-lock` never creates (or fails to remove) a
 * lock object in an append-only repository; the panel stack lock already
 * serializes its own operations.
 */
export function managedSiteBackupInventoryArgs(siteId: string): string[] {
    return ["snapshots", "--json", "--no-lock", "--tag", siteTag(siteId)];
}

/**
 * `restic forget` arguments. `--dry-run` is always present and `--prune` never
 * is: the panel measures a policy, it does not apply it.
 */
export function managedSiteBackupRetentionArgs(policy: ManagedSiteBackupRetention, siteId: string): string[] {
    return [
        "forget",
        "--dry-run",
        "--json",
        "--no-lock",
        "--tag",
        siteTag(siteId),
        ...MANAGED_SITE_BACKUP_RETENTION_KEYS.flatMap((key) => {
            const value = policy[key];
            return value === undefined ? [] : [`--${managedSiteBackupRetentionFlag(key)}`, String(value)];
        }),
    ];
}

function snapshotRef(value: unknown, siteId: string): ManagedSiteBackupSnapshot | null {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (typeof record.id !== "string" || !SNAPSHOT_ID.test(record.id)) return null;
    if (typeof record.time !== "string" || record.time.length > 40 || !RESTIC_TIME.test(record.time)) return null;
    if (!Array.isArray(record.tags)) return null;
    if (!record.tags.every((tag) => typeof tag === "string" && tag.length > 0 && tag.length <= 255)) return null;
    if (!record.tags.includes(siteTag(siteId))) return null;
    return { id: record.id, at: record.time };
}

export type ManagedSiteBackupInventoryResult = { ok: true; snapshots: ManagedSiteBackupSnapshot[] } | { ok: false; reason: string };

/**
 * Parse `snapshots --json`. Only this site's tagged snapshots are accepted, each
 * id appears once, and a set larger than the bound is refused rather than
 * partially measured.
 */
export function parseManagedSiteBackupInventory(
    source: string,
    siteId: string,
    max = MANAGED_SITE_BACKUP_RETENTION_MAX_SNAPSHOTS,
): ManagedSiteBackupInventoryResult {
    let value: unknown;
    try {
        value = JSON.parse(source);
    } catch {
        return { ok: false, reason: "The repository did not return a JSON snapshot list." };
    }
    if (!Array.isArray(value)) {
        return { ok: false, reason: "The repository did not return a JSON snapshot list." };
    }
    if (value.length > max) {
        return {
            ok: false,
            reason: `The repository holds more than ${max} snapshots for this site; the panel refuses to preview such a set.`,
        };
    }
    const snapshots: ManagedSiteBackupSnapshot[] = [];
    const seen = new Set<string>();
    for (const entry of value) {
        const ref = snapshotRef(entry, siteId);
        if (!ref) {
            return {
                ok: false,
                reason: "The repository returned a snapshot the panel cannot read or that does not belong to this site.",
            };
        }
        if (seen.has(ref.id)) return { ok: false, reason: "The repository returned a duplicate snapshot id." };
        seen.add(ref.id);
        snapshots.push(ref);
    }
    return { ok: true, snapshots };
}

export interface ManagedSiteBackupRetentionPreview {
    total: number;
    keep: ManagedSiteBackupSnapshot[];
    remove: ManagedSiteBackupSnapshot[];
}

export type ManagedSiteBackupRetentionPreviewResult =
    { ok: true; preview: ManagedSiteBackupRetentionPreview } | { ok: false; reason: string };

/**
 * Parse `forget --json --dry-run` and check it against the inventory. Restic
 * groups snapshots (by host and paths by default), so the caller may receive
 * one group or several; the union must account for every listed snapshot
 * exactly once. A partial or foreign answer is refused rather than shown as a
 * removal set the operator might act on.
 */
export function parseManagedSiteBackupRetentionPreview(
    source: string,
    inventory: readonly ManagedSiteBackupSnapshot[],
    siteId: string,
): ManagedSiteBackupRetentionPreviewResult {
    if (inventory.length === 0) {
        return source.trim() === ""
            ? { ok: true, preview: { total: 0, keep: [], remove: [] } }
            : { ok: false, reason: "The repository returned a preview for an empty snapshot list." };
    }
    let value: unknown;
    try {
        value = JSON.parse(source);
    } catch {
        return { ok: false, reason: "The repository did not return a JSON retention preview." };
    }
    const groups = Array.isArray(value) ? value : [value];
    if (groups.length === 0 || groups.length > 256) {
        return { ok: false, reason: "The repository returned an unexpected number of retention groups." };
    }
    const listed = new Map(inventory.map((snapshot) => [snapshot.id, snapshot]));
    const keepIds = new Set<string>();
    const removeIds = new Set<string>();
    const collect = (entries: unknown, target: Set<string>): string | null => {
        // Restic 0.18 writes `null` for an empty keep or remove list instead of
        // an empty array. An absent or malformed list stays an error: only the
        // explicitly empty answer is accepted.
        if (entries === null) return null;
        if (!Array.isArray(entries)) return "The retention preview is missing its keep or remove list.";
        for (const entry of entries) {
            const ref = snapshotRef(entry, siteId);
            if (!ref) return "The retention preview contains a snapshot the panel cannot read.";
            if (!listed.has(ref.id)) return "The retention preview contains a snapshot the panel did not list.";
            if (keepIds.has(ref.id) || removeIds.has(ref.id)) {
                return "The retention preview reports the same snapshot twice.";
            }
            target.add(ref.id);
        }
        return null;
    };
    for (const group of groups) {
        if (typeof group !== "object" || group === null || Array.isArray(group)) {
            return { ok: false, reason: "The retention preview is not one group object." };
        }
        const record = group as Record<string, unknown>;
        const keepError = collect(record.keep, keepIds);
        if (keepError) return { ok: false, reason: keepError };
        const removeError = collect(record.remove, removeIds);
        if (removeError) return { ok: false, reason: removeError };
    }
    if (keepIds.size + removeIds.size !== inventory.length) {
        return { ok: false, reason: "The retention preview did not account for every snapshot of this site." };
    }
    return {
        ok: true,
        preview: {
            total: inventory.length,
            keep: inventory.filter((snapshot) => keepIds.has(snapshot.id)),
            remove: inventory.filter((snapshot) => removeIds.has(snapshot.id)),
        },
    };
}

export interface ManagedSiteRetentionProtection {
    removesLastSuccess: boolean;
    removesLastProof: boolean;
}

/** Which recorded facts the declared policy would remove, if any. */
export function managedSiteRetentionProtection(
    remove: readonly ManagedSiteBackupSnapshot[],
    facts: { lastSuccess: string | null; lastProof: string | null },
): ManagedSiteRetentionProtection {
    const ids = new Set(remove.map((snapshot) => snapshot.id));
    return {
        removesLastSuccess: facts.lastSuccess !== null && ids.has(facts.lastSuccess),
        removesLastProof: facts.lastProof !== null && ids.has(facts.lastProof),
    };
}

export interface ManagedSiteBackupRetentionRequest {
    stackDir: string;
    manifest: ManagedSiteManifest;
    onOutput?: (chunk: string) => void;
    signal?: AbortSignal;
}

export interface ManagedSiteBackupRetentionDependencies {
    docker?: DockerRunner;
    timeoutMs?: number;
    /** Test seam only: a disposable REST endpoint on the lab daemon. */
    resticNetwork?: string;
}

export type ManagedSiteBackupRetentionResult =
    { ok: true; total: number; keep: ManagedSiteBackupSnapshot[]; remove: ManagedSiteBackupSnapshot[] } | { ok: false; reason: string };

function commandFailure(label: string, result: CommandResult): string {
    if (result.timedOut) return `${label} did not finish before the timeout; nothing was deleted.`;
    if (result.truncated) return `${label} produced more output than the panel keeps; nothing was deleted.`;
    const detail = result.stderr.trim().split("\n")[0]?.slice(0, 300);
    return detail
        ? `${label} failed: ${detail}. Nothing was deleted.`
        : `${label} failed with exit code ${result.code}. Nothing was deleted.`;
}

/**
 * Run the two read-only Restic calls for one site and return Restic's own
 * keep/remove split. It never adds `--prune`, never passes a snapshot id and
 * never writes to the repository.
 */
export async function runManagedSiteBackupRetentionPreview(
    request: ManagedSiteBackupRetentionRequest,
    dependencies: ManagedSiteBackupRetentionDependencies = {},
): Promise<ManagedSiteBackupRetentionResult> {
    const { stackDir, manifest } = request;
    const backup = manifest.backup;
    if (!backup?.retention) return { ok: false, reason: "This site declares no backup.retention policy." };
    const docker: DockerRunner = dependencies.docker ?? ((args, options) => runCommand("docker", args, options));
    const timeoutMs = dependencies.timeoutMs ?? MANAGED_SITE_BACKUP_RETENTION_TIMEOUT_MS;
    const output = request.onOutput ?? (() => {});
    const restic = await managedSiteResticContext(stackDir, backup.repository);
    const options = {
        timeoutMs,
        maxBytes: MANAGED_SITE_BACKUP_RETENTION_OUTPUT_MAX_BYTES,
        cwd: stackDir,
        ...(request.signal ? { signal: request.signal } : {}),
    };

    output("Reading this site's snapshots from the repository.\n");
    const listed = await docker(
        managedSiteResticCommand(restic, managedSiteBackupInventoryArgs(manifest.siteId), [], dependencies.resticNetwork),
        options,
    );
    if (listed.code !== 0 || listed.timedOut || listed.truncated) {
        return { ok: false, reason: commandFailure("The snapshot list", listed) };
    }
    const inventory = parseManagedSiteBackupInventory(listed.stdout, manifest.siteId);
    if (!inventory.ok) return { ok: false, reason: inventory.reason };
    if (inventory.snapshots.length === 0) {
        output("The repository holds no snapshot tagged for this site.\n");
        return { ok: true, total: 0, keep: [], remove: [] };
    }

    output(
        `Applying the declared policy (${managedSiteBackupRetentionSummary(backup.retention)}) to ${String(inventory.snapshots.length)} snapshot(s) in dry-run mode; nothing is deleted.\n`,
    );
    const previewed = await docker(
        managedSiteResticCommand(restic, managedSiteBackupRetentionArgs(backup.retention, manifest.siteId), [], dependencies.resticNetwork),
        options,
    );
    if (previewed.code !== 0 || previewed.timedOut || previewed.truncated) {
        return { ok: false, reason: commandFailure("The retention preview", previewed) };
    }
    const parsed = parseManagedSiteBackupRetentionPreview(previewed.stdout, inventory.snapshots, manifest.siteId);
    if (!parsed.ok) return { ok: false, reason: parsed.reason };
    output(
        `Restic would keep ${String(parsed.preview.keep.length)} and remove ${String(parsed.preview.remove.length)} of ${String(parsed.preview.total)} snapshot(s).\n`,
    );
    for (const snapshot of parsed.preview.remove) {
        output(`would remove ${snapshot.id.slice(0, 12)} ${snapshot.at}\n`);
    }
    return {
        ok: true,
        total: parsed.preview.total,
        keep: parsed.preview.keep,
        remove: parsed.preview.remove,
    };
}
