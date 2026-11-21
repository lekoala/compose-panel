/**
 * Managed-site deploy (ADR 0042, ADR 0043): one manual, bounded activation of
 * one fetched release, with a verified baseline, an atomic pointer switch, a
 * forced runtime recreation, a fixed revision probe and a probed rollback.
 *
 * Every step is revalidated under the caller's per-stack lock. The module owns
 * the phase machine and the decision table; Docker, Git, the probe and the
 * clock are injected so the table can be tested without a daemon.
 */
import { constants } from "node:fs";
import { lstat, open, readlink, rename, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { CommandResult } from "./docker.ts";
import type { ComposeProjectFiles } from "./compose-provider.ts";
import { parseContainerInspect, type ContainerDetails } from "./container-state.ts";
import { parseImageInspect } from "./compose-state.ts";
import { randomSuffix, readFileSafe } from "./fs-safe.ts";
import { parseReleaseMetadata, revisionScript, type GitReleaseResult } from "./git-release.ts";
import type { ManagedSiteComposeFacts } from "./managed-site-profile.ts";
import { MANAGED_SITE_PATHS, type ManagedSiteManifest, type ManagedSiteManifestResult } from "./managed-site.ts";

export const MANAGED_SITE_ATTEMPT_FILE = "deploy-attempt.json";
export const MANAGED_SITE_PROBE_PATH = "/.compose-panel/revision";
export const MANAGED_SITE_PROBE_DEADLINE_MS = 5000;
const PROBE_INTERVAL_MS = 250;
const METADATA_BYTES_MAX = 4096;
const REVISION_BYTES_MAX = 1024;

export type ManagedSiteDeployPhase =
    "validate" | "baseline" | "fetch" | "publish" | "stop" | "switch" | "recreate" | "start" | "probe" | "rollback";

export interface ManagedSiteDeployAttempt {
    version: 1;
    siteId: string;
    attemptId: string;
    release: string;
    prior: string;
    phase: ManagedSiteDeployPhase;
    outcome: "pending" | "deployed" | "rolled-back" | "intervention";
}

/** The narrow provider surface the deploy uses; the real provider fits it. */
export interface DeployProvider {
    runningContainerIds(input: {
        project: string;
        composeFile: string;
        cwd: string;
        service: string;
        envFile?: string;
    }): Promise<string[] | null>;
    inspectImages(refs: string[]): Promise<CommandResult>;
    stopService(
        input: ComposeProjectFiles & { service: string; timeoutMs?: number; onOutput?: (chunk: string) => void },
    ): Promise<CommandResult>;
    startService(
        input: ComposeProjectFiles & { service: string; timeoutMs?: number; onOutput?: (chunk: string) => void },
    ): Promise<CommandResult>;
    recreateService(
        input: ComposeProjectFiles & {
            service: string;
            force?: boolean;
            timeoutMs?: number;
            onOutput?: (chunk: string) => void;
        },
    ): Promise<CommandResult>;
}

export interface DeployInspector {
    inspect(id: string): Promise<CommandResult>;
}

export interface ProbeAnswer {
    status: number;
    /** Raw body; only the fixed 41-byte shape is ever accepted. */
    body: string;
}

export type ManagedSiteProbe = (port: number) => Promise<ProbeAnswer | null>;

export interface ManagedSiteDeployDependencies {
    stackDir: string;
    attemptId: string;
    /** Bounded re-read of the manifest, under the lock. */
    loadManifest: () => Promise<ManagedSiteManifestResult>;
    /** Effective config without `-p`, projected and checked against the manifest. */
    inspectProfile: (
        manifest: ManagedSiteManifest,
    ) => Promise<{ ok: true; facts: ManagedSiteComposeFacts } | { ok: false; reason: string }>;
    provider: DeployProvider;
    inspector: DeployInspector;
    /** Exact project files used by every service-scoped mutation. */
    files: (manifest: ManagedSiteManifest) => ComposeProjectFiles;
    fetchRelease: (input: {
        manifest: ManagedSiteManifest;
        attemptId: string;
        onOutput: (chunk: string) => void;
    }) => Promise<GitReleaseResult>;
    probe: ManagedSiteProbe;
    now: () => number;
    sleep: (ms: number) => Promise<void>;
    isShuttingDown: () => boolean;
    onOutput: (chunk: string) => void;
    signal?: AbortSignal;
    /** Per-command timeout; Compose's `up` may take longer than a read. */
    commandTimeoutMs: number;
    probeDeadlineMs?: number;
    /** Pointer boundary; production uses the real symlink helpers (tests inject). */
    readBaseline?: (stackDir: string, siteId: string) => Promise<BaselineRead>;
    switchPointer?: (runtimeDir: string, releaseId: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
    readPointerTarget?: (runtimeDir: string) => Promise<string | null>;
}

export type ManagedSiteDeployResult =
    | { kind: "refused"; reason: string }
    | { kind: "failed"; reason: string; phase: ManagedSiteDeployPhase }
    | { kind: "noop"; releaseId: string }
    | { kind: "deployed"; releaseId: string; priorReleaseId: string }
    | { kind: "rolled-back"; releaseId: string; priorReleaseId: string; servedReleaseId: string }
    | { kind: "intervention"; reason: string; phase: ManagedSiteDeployPhase; releaseId?: string }
    | { kind: "unknown"; reason: string; phase: ManagedSiteDeployPhase; releaseId?: string };

export type BaselineRead = { ok: true; releaseId: string; releasePath: string } | { ok: false; reason: string };

/**
 * Accept only HTTP 200 with a body of exactly 40 lowercase hex characters and
 * one newline. Any other status, size or encoding is a failed verification.
 */
export function parseProbeAnswer(status: number, body: string): string | null {
    if (status !== 200) return null;
    if (Buffer.byteLength(body, "utf8") !== 41) return null;
    if (!body.endsWith("\n")) return null;
    const revision = body.slice(0, 40);
    return /^[0-9a-f]{40}$/.test(revision) ? revision : null;
}

export function managedSiteAttemptPath(stackDir: string): string {
    return join(stackDir, ...MANAGED_SITE_PATHS.private.split("/"), MANAGED_SITE_ATTEMPT_FILE);
}

/** Any marker, including an unexpected one, blocks every modifying operation. */
export async function pendingDeployAttempt(stackDir: string): Promise<boolean> {
    try {
        await lstat(managedSiteAttemptPath(stackDir));
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ENOENT";
    }
}

/**
 * Verify the active pointer, its release directory, its completed metadata and
 * its revision script. The served SHA is proven separately by the probe.
 */
export async function readBaseline(stackDir: string, siteId: string): Promise<BaselineRead> {
    const runtime = join(stackDir, ...MANAGED_SITE_PATHS.runtime.split("/"));
    const current = join(runtime, "current");
    let target: string;
    try {
        target = await readlink(current);
    } catch {
        return { ok: false, reason: `${MANAGED_SITE_PATHS.current} is missing or is not a symbolic link.` };
    }
    const match = /^releases\/([0-9a-f]{40})$/.exec(target);
    if (!match) return { ok: false, reason: `${MANAGED_SITE_PATHS.current} does not point at releases/<full-sha>.` };
    const releaseId = match[1]!;
    const releasePath = join(runtime, "releases", releaseId);
    let info;
    try {
        info = await lstat(releasePath);
    } catch {
        return { ok: false, reason: `The release ${releaseId} pointed to by ${MANAGED_SITE_PATHS.current} is missing.` };
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
        return { ok: false, reason: `The release ${releaseId} is not a real directory.` };
    }
    const metadataPath = join(stackDir, ...MANAGED_SITE_PATHS.private.split("/"), "releases", `${releaseId}.json`);
    let metadataSource: string;
    try {
        const metadata = await readFileSafe(metadataPath, METADATA_BYTES_MAX);
        if (!metadata) return { ok: false, reason: `The release ${releaseId} has no completed-release metadata.` };
        metadataSource = metadata.source;
    } catch {
        return { ok: false, reason: `The release ${releaseId} metadata cannot be read as a regular file.` };
    }
    const metadata = parseReleaseMetadata(metadataSource);
    if (!metadata || metadata.release !== releaseId || metadata.siteId !== siteId) {
        return { ok: false, reason: `The release ${releaseId} metadata does not mark it complete for this site.` };
    }
    try {
        const revision = await readFileSafe(join(releasePath, ".compose-panel", "revision.php"), REVISION_BYTES_MAX);
        if (!revision || revision.source !== revisionScript(releaseId)) {
            return { ok: false, reason: `The release ${releaseId} does not carry the expected revision script.` };
        }
    } catch {
        return { ok: false, reason: `The release ${releaseId} revision script cannot be read.` };
    }
    return { ok: true, releaseId, releasePath };
}

/**
 * Atomically point `current` at `releases/<releaseId>`. The caller must already
 * hold the stack lock. A crash leaves either the old or the new target.
 */
export async function switchCurrent(runtimeDir: string, releaseId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const target = `releases/${releaseId}`;
    const current = join(runtimeDir, "current");
    const temp = join(runtimeDir, `.current-${randomSuffix()}`);
    try {
        await symlink(target, temp);
    } catch {
        return { ok: false, reason: "The new pointer could not be created." };
    }
    try {
        await rename(temp, current);
    } catch {
        await unlink(temp).catch(() => {});
        return { ok: false, reason: "The pointer switch could not be confirmed." };
    }
    const actual = await readlink(current).catch(() => null);
    if (actual !== target) return { ok: false, reason: "The pointer switch did not leave the expected target." };
    return { ok: true };
}

interface ServiceIdentity {
    containerId: string;
    details: ContainerDetails;
}

interface DeployTarget {
    project: string;
    composeFile: string;
    cwd: string;
    envFile?: string;
}

/**
 * Run the deploy. The caller holds the per-stack lock and has already resolved
 * the Compose project without injecting `-p`.
 */
export async function runManagedSiteDeploy(deps: ManagedSiteDeployDependencies): Promise<ManagedSiteDeployResult> {
    const onOutput = deps.onOutput;
    const marker = managedSiteAttemptPath(deps.stackDir);
    const readActive = deps.readBaseline ?? readBaseline;
    const switchPointer = deps.switchPointer ?? switchCurrent;
    const readPointerTarget = deps.readPointerTarget ?? ((runtimeDir: string) => readlink(join(runtimeDir, "current")).catch(() => null));
    const state: {
        phase: ManagedSiteDeployPhase;
        siteId: string | null;
        releaseId: string | null;
        prior: string | null;
        markerWritten: boolean;
        servingChanged: boolean;
    } = {
        phase: "validate",
        siteId: null,
        releaseId: null,
        prior: null,
        markerWritten: false,
        servingChanged: false,
    };

    const record = (outcome: ManagedSiteDeployAttempt["outcome"]): ManagedSiteDeployAttempt => ({
        version: 1,
        siteId: state.siteId!,
        attemptId: deps.attemptId,
        release: state.releaseId!,
        prior: state.prior!,
        phase: state.phase,
        outcome,
    });
    const writeMarker = async (outcome: ManagedSiteDeployAttempt["outcome"]): Promise<boolean> => {
        if (!state.siteId || !state.releaseId || !state.prior) return false;
        try {
            await writeAttempt(marker, record(outcome));
            state.markerWritten = true;
            return true;
        } catch {
            return false;
        }
    };
    const fail = (reason: string, unconfirmed = false): ManagedSiteDeployResult =>
        unconfirmed
            ? { kind: "unknown", reason, phase: state.phase, ...(state.releaseId ? { releaseId: state.releaseId } : {}) }
            : { kind: "failed", reason, phase: state.phase };
    const intervene = async (reason: string): Promise<ManagedSiteDeployResult> => {
        if (state.servingChanged) await writeMarker("intervention").catch(() => {});
        return { kind: "intervention", reason, phase: state.phase, ...(state.releaseId ? { releaseId: state.releaseId } : {}) };
    };

    try {
        // ---- validate: manifest, profile, identity, mounts, image drift ----
        const manifestResult = await deps.loadManifest();
        if (!manifestResult.ok) return { kind: "refused", reason: manifestResult.reason };
        const manifest = manifestResult.manifest;
        state.siteId = manifest.siteId;

        if (deps.isShuttingDown()) return { kind: "refused", reason: "The panel is shutting down." };
        if (deps.signal?.aborted) return { kind: "refused", reason: "The operation was cancelled before anything ran." };

        const profile = await deps.inspectProfile(manifest);
        if (!profile.ok) return { kind: "refused", reason: profile.reason };
        const facts = profile.facts;
        const files = deps.files(manifest);

        const target: DeployTarget = {
            project: files.project,
            composeFile: files.composeFiles[0]!,
            cwd: files.cwd,
            ...(files.envFiles[0] ? { envFile: files.envFiles[0] } : {}),
        };
        const gatewayFacts = facts.services.get(manifest.services.gateway);
        const runtimeFacts = facts.services.get(manifest.services.runtime);
        if (!gatewayFacts || !runtimeFacts) {
            return { kind: "refused", reason: "The declared services are not in the effective Compose configuration." };
        }
        const port = gatewayFacts.ports[0]?.published ?? null;
        if (port === null) return { kind: "refused", reason: "The gateway has no explicit loopback port." };
        const declaredImage = runtimeFacts.image;
        if (!declaredImage) return { kind: "refused", reason: "The runtime service declares no explicit image." };

        // ---- baseline: pointer, metadata and probe must agree ----
        state.phase = "baseline";
        const baseline = await readActive(deps.stackDir, manifest.siteId);
        if (!baseline.ok) return { kind: "refused", reason: baseline.reason };
        state.prior = baseline.releaseId;

        const gateway = await serviceIdentity(deps, target, manifest.services.gateway);
        const runtime = await serviceIdentity(deps, target, manifest.services.runtime);
        if (!gateway) return { kind: "refused", reason: "The gateway service is not running as exactly one container." };
        if (!runtime) return { kind: "refused", reason: "The runtime service is not running as exactly one container." };
        if (gateway.details.imageId === null || runtime.details.imageId === null) {
            return { kind: "refused", reason: "A service container image cannot be inspected." };
        }
        if (!gateway.details.ports.some((entry) => entry.host === `127.0.0.1:${port}`)) {
            return { kind: "refused", reason: "The gateway does not publish its declared loopback port on the running container." };
        }
        if (runtime.details.image !== declaredImage) {
            return { kind: "refused", reason: "The running runtime container was not created from the declared image reference." };
        }
        const localImage = await localImageId(deps.provider, declaredImage);
        if (!localImage || localImage !== runtime.details.imageId) {
            return {
                kind: "refused",
                reason: "The runtime image reference no longer resolves to the running container's image; refusing to switch.",
            };
        }

        const servedBaseline = await probeFor(deps, port);
        if (servedBaseline === null) {
            return { kind: "refused", reason: `The revision probe did not answer with one full SHA on 127.0.0.1:${port}.` };
        }
        if (servedBaseline !== baseline.releaseId) {
            return {
                kind: "refused",
                reason: `${MANAGED_SITE_PATHS.current} points at ${baseline.releaseId} but the probe serves ${servedBaseline}; the baseline is not provable.`,
            };
        }

        // ---- fetch and publish (the active release is untouched until stop) ----
        state.phase = "fetch";
        const fetched = await deps.fetchRelease({ manifest, attemptId: deps.attemptId, onOutput });
        if (!fetched.ok) {
            const detail = fetched.detail ? ` ${fetched.detail}` : "";
            return fail(`${fetched.reason}${detail}`, fetched.unconfirmed);
        }
        state.releaseId = fetched.releaseId;

        if (fetched.releaseId === baseline.releaseId) {
            onOutput(`The probe already serves ${fetched.releaseId}; nothing to change.\n`);
            return { kind: "noop", releaseId: fetched.releaseId };
        }

        // The fetch can be long: re-prove the pointer and the probe so a
        // concurrent external switch can never be overwritten blindly.
        const recheck = await readActive(deps.stackDir, manifest.siteId);
        if (!recheck.ok || recheck.releaseId !== baseline.releaseId) {
            return { kind: "refused", reason: "The active pointer changed while the release was being fetched; nothing was stopped." };
        }
        if ((await probeFor(deps, port)) !== baseline.releaseId) {
            return { kind: "refused", reason: "The served revision changed while the release was being fetched; nothing was stopped." };
        }
        if (deps.isShuttingDown()) return fail("The panel is shutting down; nothing was stopped.");

        // ---- attempt record before any serving change ----
        state.phase = "publish";
        if (!(await writeMarker("pending"))) {
            return fail("The attempt record could not be written; nothing was stopped.");
        }

        // ---- stop the gateway and confirm ----
        state.phase = "stop";
        const stopped = await deps.provider.stopService({
            ...files,
            service: manifest.services.gateway,
            timeoutMs: deps.commandTimeoutMs,
            onOutput,
        });
        if (stopped.terminationUnconfirmed) return fail("The gateway stop could not be confirmed to have exited.", true);
        if (stopped.code !== 0 || stopped.timedOut) return intervene("The gateway could not be stopped; nothing was switched.");
        const stillRunning = await deps.provider.runningContainerIds({ ...target, service: manifest.services.gateway });
        if (stillRunning === null || stillRunning.length > 0) {
            return intervene("The gateway stop could not be confirmed by Docker; nothing was switched.");
        }

        // ---- atomic pointer switch ----
        state.phase = "switch";
        const runtimeDir = join(deps.stackDir, ...MANAGED_SITE_PATHS.runtime.split("/"));
        const switched = await switchPointer(runtimeDir, fetched.releaseId);
        if (!switched.ok) {
            const actual = await readPointerTarget(runtimeDir);
            if (actual === `releases/${baseline.releaseId}`) {
                await clearMarker(state, marker);
                return fail(`${switched.reason} The previous release is still current.`);
            }
            state.servingChanged = true;
            return intervene(`${switched.reason} The pointer must be inspected.`);
        }
        state.servingChanged = true;

        // ---- force-recreate the runtime, then start the gateway ----
        state.phase = "recreate";
        // A long fetch happened since the eligibility check. If the tag moved
        // in the meantime, a forced recreation would silently apply another
        // already-pulled image under the same tag: refuse instead.
        const imageBeforeRecreate = await localImageId(deps.provider, declaredImage);
        if (!imageBeforeRecreate || imageBeforeRecreate !== runtime.details.imageId) {
            return intervene("The runtime image reference changed during the deploy; the runtime was not recreated.");
        }
        const recreated = await deps.provider.recreateService({
            ...files,
            service: manifest.services.runtime,
            force: true,
            timeoutMs: deps.commandTimeoutMs,
            onOutput,
        });
        if (recreated.terminationUnconfirmed) return fail("The runtime recreation could not be confirmed to have exited.", true);
        if (recreated.code !== 0 || recreated.timedOut)
            return intervene("The runtime was not recreated; the pointer is new and needs inspection.");
        const runtimeAfter = await serviceIdentity(deps, target, manifest.services.runtime);
        if (!runtimeAfter || runtimeAfter.containerId === runtime.containerId) {
            return intervene("The runtime container identity did not change after recreation.");
        }

        state.phase = "start";
        const started = await deps.provider.startService({
            ...files,
            service: manifest.services.gateway,
            timeoutMs: deps.commandTimeoutMs,
            onOutput,
        });
        if (started.terminationUnconfirmed) return fail("The gateway start could not be confirmed to have exited.", true);
        if (started.code !== 0 || started.timedOut) return intervene("The gateway was not started; the site needs inspection.");
        const gatewayAfter = await serviceIdentity(deps, target, manifest.services.gateway);
        if (!gatewayAfter || gatewayAfter.containerId !== gateway.containerId) {
            return intervene("The gateway container identity changed unexpectedly.");
        }

        // ---- probe the intended SHA ----
        state.phase = "probe";
        const served = await probeFor(deps, port);
        if (served === fetched.releaseId) {
            await clearMarker(state, marker);
            return { kind: "deployed", releaseId: fetched.releaseId, priorReleaseId: baseline.releaseId };
        }

        // ---- probed rollback to the verified baseline ----
        state.phase = "rollback";
        const restored = await switchPointer(runtimeDir, baseline.releaseId);
        if (!restored.ok) return intervene(`${restored.reason} The served revision is unknown.`);
        const imageBeforeRollback = await localImageId(deps.provider, declaredImage);
        if (!imageBeforeRollback || imageBeforeRollback !== runtime.details.imageId) {
            return intervene("The runtime image reference changed before the rollback; the runtime was not recreated.");
        }
        const recreatedBack = await deps.provider.recreateService({
            ...files,
            service: manifest.services.runtime,
            force: true,
            timeoutMs: deps.commandTimeoutMs,
            onOutput,
        });
        if (recreatedBack.terminationUnconfirmed) return fail("The rollback recreation could not be confirmed to have exited.", true);
        if (recreatedBack.code !== 0 || recreatedBack.timedOut) return intervene("The rollback could not recreate the runtime.");
        const startedBack = await deps.provider.startService({
            ...files,
            service: manifest.services.gateway,
            timeoutMs: deps.commandTimeoutMs,
            onOutput,
        });
        if (startedBack.terminationUnconfirmed) return fail("The rollback gateway start could not be confirmed to have exited.", true);
        if (startedBack.code !== 0 || startedBack.timedOut) return intervene("The rollback could not start the gateway.");
        const servedBaselineAgain = await probeFor(deps, port);
        if (servedBaselineAgain === baseline.releaseId) {
            await clearMarker(state, marker);
            return {
                kind: "rolled-back",
                releaseId: fetched.releaseId,
                priorReleaseId: baseline.releaseId,
                servedReleaseId: servedBaselineAgain,
            };
        }
        return intervene(`The probe did not confirm the rolled-back release ${baseline.releaseId}.`);
    } catch (error) {
        const reason = error instanceof Error ? error.message : "The deploy failed unexpectedly.";
        if (state.servingChanged) {
            await writeMarker("intervention").catch(() => {});
            return { kind: "intervention", reason, phase: state.phase, ...(state.releaseId ? { releaseId: state.releaseId } : {}) };
        }
        // Nothing was switched: the attempt marker, if any, is not evidence of
        // an ambiguous serving state and is removed.
        await clearMarker(state, marker);
        return { kind: "failed", reason, phase: state.phase };
    }
}

async function clearMarker(state: { markerWritten: boolean }, marker: string): Promise<void> {
    if (!state.markerWritten) return;
    await unlink(marker).catch(() => {});
    state.markerWritten = false;
}

async function serviceIdentity(
    deps: ManagedSiteDeployDependencies,
    target: { project: string; composeFile: string; cwd: string; envFile?: string },
    service: string,
): Promise<ServiceIdentity | null> {
    const ids = await deps.provider.runningContainerIds({ ...target, service });
    if (!ids || ids.length !== 1) return null;
    const containerId = ids[0]!;
    try {
        const result = await deps.inspector.inspect(containerId);
        if (result.code !== 0 || result.timedOut || result.truncated) return null;
        const details = parseContainerInspect(result.stdout);
        if (!details.running) return null;
        return { containerId, details };
    } catch {
        return null;
    }
}

async function localImageId(provider: DeployProvider, reference: string): Promise<string | null> {
    try {
        const result = await provider.inspectImages([reference]);
        if (result.code !== 0 || result.timedOut || result.truncated) return null;
        return parseImageInspect(result.stdout)[0]?.id ?? null;
    } catch {
        return null;
    }
}

/** One probe answer within the fixed total deadline; `null` when none parsed. */
async function probeFor(deps: ManagedSiteDeployDependencies, port: number): Promise<string | null> {
    const deadlineMs = deps.probeDeadlineMs ?? MANAGED_SITE_PROBE_DEADLINE_MS;
    const started = deps.now();
    for (;;) {
        if (deps.signal?.aborted) return null;
        const answer = await deps.probe(port);
        const revision = answer ? parseProbeAnswer(answer.status, answer.body) : null;
        if (revision) return revision;
        if (deps.now() - started >= deadlineMs) return null;
        await deps.sleep(PROBE_INTERVAL_MS);
    }
}

/** Atomic, bounded attempt record. The parent (`site/private`) is validated. */
async function writeAttempt(path: string, record: ManagedSiteDeployAttempt): Promise<void> {
    const temp = `${path}.${randomSuffix()}.tmp`;
    const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
        await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
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
