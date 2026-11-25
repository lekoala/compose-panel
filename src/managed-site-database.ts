/**
 * The database env file contract (ADR 0048).
 *
 * The panel never reads, parses, logs or renders this file: Compose reads it at
 * container creation. The panel only checks that an operator-provisioned file
 * exists, is a regular file owned by the panel account and is not readable by
 * any other identity before a mutation can start the runtime.
 */
import { lstat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { MANAGED_SITE_DATABASE_ENV_MAX_BYTES, managedSiteDatabaseEnvPath, type ManagedSiteManifest } from "./managed-site.ts";

export type ManagedSiteDatabaseEnvCheck = { ok: true } | { ok: false; reason: string };

export interface ManagedSiteDatabaseEnvOptions {
    /** Test seam; production uses `lstat`. */
    lstat?: (path: string) => Promise<Stats>;
    /** Test seam; defaults to the panel process uid when the platform has one. */
    ownerUid?: number | null;
}

export async function checkManagedSiteDatabaseEnvFile(
    stackDir: string,
    manifest: ManagedSiteManifest,
    options: ManagedSiteDatabaseEnvOptions = {},
): Promise<ManagedSiteDatabaseEnvCheck> {
    if (!manifest.database) return { ok: true };
    const path = managedSiteDatabaseEnvPath(stackDir);
    let stat: Stats;
    try {
        stat = await (options.lstat ?? lstat)(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return {
                ok: false,
                reason: `The database env file "${path}" is missing. Provision it with mode 0600 before starting the site.`,
            };
        }
        return { ok: false, reason: `The database env file "${path}" cannot be checked.` };
    }
    if (stat.isSymbolicLink()) {
        return { ok: false, reason: `The database env file "${path}" is a symbolic link; it must be a regular file.` };
    }
    if (!stat.isFile()) {
        return { ok: false, reason: `The database env file "${path}" is not a regular file.` };
    }
    if (stat.size > MANAGED_SITE_DATABASE_ENV_MAX_BYTES) {
        return {
            ok: false,
            reason: `The database env file "${path}" is larger than ${MANAGED_SITE_DATABASE_ENV_MAX_BYTES} bytes.`,
        };
    }
    if ((stat.mode & 0o077) !== 0) {
        return {
            ok: false,
            reason: `The database env file "${path}" must not be readable or writable by group or others (mode 0600).`,
        };
    }
    const ownerUid = options.ownerUid !== undefined ? options.ownerUid : typeof process.getuid === "function" ? process.getuid() : null;
    if (ownerUid !== null && stat.uid !== ownerUid) {
        return {
            ok: false,
            reason: `The database env file "${path}" must be owned by the account that runs the panel.`,
        };
    }
    return { ok: true };
}
