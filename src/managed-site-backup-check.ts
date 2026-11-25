/**
 * Read-only repository check for one managed site (ADR 0054).
 *
 * The snapshot inventory (ADR 0053) only says which id to restore. This module
 * asks the pinned Restic client whether the repository holding it is intact: one
 * fixed `check` with `--no-lock`, no deletion credential, no repair and no
 * stored result. It accepts only Restic's own clean answer and never renders
 * stdout or stderr, which name pack files and print repair commands.
 */
import { runCommand, type CommandResult, type DockerRunner } from "./docker.ts";
import { managedSiteResticContext } from "./managed-site-backup.ts";
import { managedSiteResticCommand } from "./managed-site-restic.ts";
import type { ManagedSiteManifest } from "./managed-site.ts";

export const MANAGED_SITE_BACKUP_CHECK_TIMEOUT_MS = 5 * 60 * 1000;
export const MANAGED_SITE_BACKUP_CHECK_OUTPUT_MAX_BYTES = 256 * 1024;
/**
 * A random share of pack data read in addition to the repository structure. A
 * smaller repository is read whole; the panel never asks for `--read-data`.
 */
export const MANAGED_SITE_BACKUP_CHECK_DATA_SUBSET = "32M";

/** Restic prints this exact line, last, when the check found no errors. */
const CONFIRMATION = "no errors were found";

export interface ManagedSiteBackupCheckRequest {
    stackDir: string;
    manifest: ManagedSiteManifest;
    signal?: AbortSignal;
}

export interface ManagedSiteBackupCheckDependencies {
    docker?: DockerRunner;
    timeoutMs?: number;
    /** Test seam only: a disposable REST endpoint on the lab daemon. */
    resticNetwork?: string;
}

export type ManagedSiteBackupCheckResult = { ok: true } | { ok: false; reason: string };

/**
 * `restic check` arguments. `--no-lock` keeps an append-only repository free of
 * lock objects the panel could not remove; the bounded data subset keeps the
 * read inside the operation budget. No `--read-data`, no repair, no unlock.
 */
export function managedSiteBackupCheckArgs(): string[] {
    return ["check", "--no-lock", "--read-data-subset", MANAGED_SITE_BACKUP_CHECK_DATA_SUBSET];
}

/** Only Restic's own confirmation turns exit code 0 into a clean result. */
export function managedSiteBackupCheckConfirmed(stdout: string): boolean {
    return stdout.split("\n").some((line) => line.trim() === CONFIRMATION);
}

function checkFailure(result: CommandResult): string {
    if (result.timedOut) {
        return "The repository check did not finish before the timeout; the panel makes no claim about the repository.";
    }
    if (result.truncated) {
        return "The repository check produced more output than the panel keeps; no result is claimed.";
    }
    switch (result.code) {
        case 1:
            return "Restic reported errors in the repository. Inspect it from the maintenance host; the panel changed nothing.";
        case 10:
            return "Restic could not find the repository at the configured address, so nothing could be checked.";
        case 11:
            return "Another Restic process holds the repository lock; nothing was checked.";
        case 12:
            return "The configured Restic password does not open the repository, so nothing could be checked.";
        default:
            return `The repository check failed with exit code ${String(result.code)}; the panel makes no claim about the repository.`;
    }
}

/**
 * Run one bounded read-only `restic check`. The command never passes a snapshot
 * id, `forget`, `prune`, `--read-data`, `unlock` or any repair command, and the
 * caller stores nothing.
 */
export async function runManagedSiteBackupCheck(
    request: ManagedSiteBackupCheckRequest,
    dependencies: ManagedSiteBackupCheckDependencies = {},
): Promise<ManagedSiteBackupCheckResult> {
    const { stackDir, manifest } = request;
    const backup = manifest.backup;
    if (!backup) return { ok: false, reason: "This site declares no backup block." };
    const docker: DockerRunner = dependencies.docker ?? ((args, options) => runCommand("docker", args, options));
    const restic = await managedSiteResticContext(stackDir, backup.repository);
    const checked = await docker(managedSiteResticCommand(restic, managedSiteBackupCheckArgs(), [], dependencies.resticNetwork), {
        timeoutMs: dependencies.timeoutMs ?? MANAGED_SITE_BACKUP_CHECK_TIMEOUT_MS,
        maxBytes: MANAGED_SITE_BACKUP_CHECK_OUTPUT_MAX_BYTES,
        cwd: stackDir,
        ...(request.signal ? { signal: request.signal } : {}),
    });
    if (checked.timedOut || checked.truncated || checked.code !== 0) return { ok: false, reason: checkFailure(checked) };
    if (!managedSiteBackupCheckConfirmed(checked.stdout)) {
        return {
            ok: false,
            reason: "The repository check exited without Restic's confirmation that no errors were found; no result is claimed.",
        };
    }
    return { ok: true };
}
