/**
 * Publish the first immutable release of a managed site and point `current` at
 * it (ADR 0042, ADR 0043).
 *
 * This is the creation-time baseline, not a deployment: no container is
 * stopped, recreated or probed, so there is no serving change to roll back. It
 * is separate and retryable, because a Git or SSH failure must not force the
 * operator to recreate the whole stack folder.
 */
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { fetchAndPublishGitRelease, type GitReleasePrepare, type GitReleaseResult } from "./git-release.ts";
import { MANAGED_SITE_PATHS, type ManagedSiteManifest } from "./managed-site.ts";
import { readBaseline, switchCurrent } from "./managed-site-deploy.ts";

export interface ManagedSiteBaselineRequest {
    /** Canonical absolute stack directory. */
    stackDir: string;
    manifest: ManagedSiteManifest;
    attemptId: string;
    onOutput?: (chunk: string) => void;
    /** Panel shutdown; the fetch and any preparation must stop and clean up. */
    signal?: AbortSignal;
    /** Fixed preparation (Composer, ADR 0045) applied before publication. */
    prepare?: GitReleasePrepare;
    releaseLimits?: { maxFiles: number; maxTreeBytes: number; maxDepth: number };
    /** Test seam: production always fetches into a staging directory. */
    publish?: typeof fetchAndPublishGitRelease;
}

export type ManagedSiteBaselineResult =
    | { kind: "published"; releaseId: string; reused: boolean }
    | { kind: "refused"; reason: string }
    | { kind: "failed"; reason: string }
    | { kind: "unknown"; reason: string };

/** The caller holds the stack lock. */
export async function publishManagedSiteBaseline(request: ManagedSiteBaselineRequest): Promise<ManagedSiteBaselineResult> {
    const runtimeDir = join(request.stackDir, ...MANAGED_SITE_PATHS.runtime.split("/"));
    const current = join(runtimeDir, "current");
    const existing = await lstat(current).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
    });
    if (existing) {
        return {
            kind: "refused",
            reason: "This site already has a current pointer. Use Deploy; the baseline is published only once.",
        };
    }

    const publish = request.publish ?? fetchAndPublishGitRelease;
    const result = await publish({
        stackDir: request.stackDir,
        siteId: request.manifest.siteId,
        url: request.manifest.deploy.git.url,
        ref: request.manifest.deploy.git.ref,
        attemptId: request.attemptId,
        ...(request.onOutput ? { onOutput: request.onOutput } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
        ...(request.prepare ? { prepare: request.prepare } : {}),
        ...(request.releaseLimits ? { releaseLimits: request.releaseLimits } : {}),
    });
    if (!result.ok) {
        if (result.unconfirmed) return { kind: "unknown", reason: result.reason };
        return { kind: "failed", reason: result.reason };
    }

    const switched = await switchCurrent(runtimeDir, result.releaseId);
    if (!switched.ok) {
        return {
            kind: "failed",
            reason: `${switched.reason} The published release ${result.releaseId} was kept; retry the baseline or inspect the pointer on the host.`,
        };
    }
    const proven = await readBaseline(request.stackDir, request.manifest.siteId);
    if (!proven.ok) {
        return {
            kind: "failed",
            reason: `The baseline pointer was switched to ${result.releaseId}, but it is not provable: ${proven.reason}`,
        };
    }
    return { kind: "published", releaseId: result.releaseId, reused: result.reused };
}
