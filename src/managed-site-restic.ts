/**
 * The pinned Restic client contract shared by backup and restore (ADR 0049).
 * Every invocation is one fixed image, one explicit argument list, a read-only
 * root filesystem, a bounded tmpfs and the operator-owned password file. The
 * panel never reads the password or the REST environment values.
 */
export const MANAGED_SITE_RESTIC_IMAGE = "restic/restic:0.18.0";
/** Restore reads a snapshot manifest; keep the dump bounded. */
export const MANAGED_SITE_RESTIC_MANIFEST_MAX_BYTES = 8 * 1024 * 1024;

export interface ManagedSiteResticContext {
    repository: string;
    passwordPath: string;
    restEnvPath: string;
    restEnvExists: boolean;
}

export function managedSiteResticCommand(
    context: ManagedSiteResticContext,
    command: string[],
    mounts: string[] = [],
    network?: string,
): string[] {
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
        `${context.passwordPath}:/run/secrets/restic-password:ro`,
        ...mounts.flatMap((mount) => ["-v", mount]),
        MANAGED_SITE_RESTIC_IMAGE,
        ...command,
    ];
}

/** Restic emits one JSON line per event; the backup summary carries the id. */
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
