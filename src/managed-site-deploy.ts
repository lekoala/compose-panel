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
import {
    MANAGED_SITE_PATHS,
    isManagedSiteAttemptId,
    isManagedSiteReleaseId,
    type ManagedSiteManifest,
    type ManagedSiteManifestResult,
} from "./managed-site.ts";

export const MANAGED_SITE_ATTEMPT_FILE = "deploy-attempt.json";
export const MANAGED_SITE_PROBE_PATH = "/.compose-panel/revision";
export const MANAGED_SITE_PROBE_DEADLINE_MS = 5000;
const PROBE_INTERVAL_MS = 250;
const METADATA_BYTES_MAX = 4096;
const REVISION_BYTES_MAX = 1024;
const ATTEMPT_BYTES_MAX = 4096;

export const MANAGED_SITE_DEPLOY_PHASES = [
    "validate",
    "baseline",
    "fetch",
    "publish",
    "stop",
    "switch",
    "recreate",
    "start",
    "probe",
    "rollback",
] as const;
export type ManagedSiteDeployPhase = (typeof MANAGED_SITE_DEPLOY_PHASES)[number];
export const MANAGED_SITE_DEPLOY_OUTCOMES = ["pending", "deployed", "rolled-back", "intervention"] as const;
export type ManagedSiteDeployOutcome = (typeof MANAGED_SITE_DEPLOY_OUTCOMES)[number];

export interface ManagedSiteDeployAttempt {
    version: 1;
    siteId: string;
    attemptId: string;
    release: string;
    prior: string;
    phase: ManagedSiteDeployPhase;
    outcome: ManagedSiteDeployOutcome;
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

/** Strict parse of the bounded attempt record; anything unexpected is `null`. */
export function parseDeployAttempt(source: string): ManagedSiteDeployAttempt | null {
    if (Buffer.byteLength(source, "utf8") > ATTEMPT_BYTES_MAX) return null;
    let value: unknown;
    try {
        value = JSON.parse(source);
    } catch {
        return null;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).sort().join(",") !== "attemptId,outcome,phase,prior,release,siteId,version") return null;
    if (record.version !== 1) return null;
    const { siteId, attemptId, release, prior, phase, outcome } = record;
    if (typeof siteId !== "string" || siteId.length === 0 || siteId.length > 64) return null;
    if (typeof attemptId !== "string" || !isManagedSiteAttemptId(attemptId)) return null;
    if (typeof release !== "string" || !isManagedSiteReleaseId(release)) return null;
    if (typeof prior !== "string" || !isManagedSiteReleaseId(prior)) return null;
    if (typeof phase !== "string" || !(MANAGED_SITE_DEPLOY_PHASES as readonly string[]).includes(phase)) return null;
    if (typeof outcome !== "string" || !(MANAGED_SITE_DEPLOY_OUTCOMES as readonly string[]).includes(outcome)) return null;
    return {
        version: 1,
        siteId,
        attemptId,
        release,
        prior,
        phase: phase as ManagedSiteDeployPhase,
        outcome: outcome as ManagedSiteDeployOutcome,
    };
}

export type PendingDeployAttemptRead = { kind: "none" } | { kind: "unreadable" } | { kind: "pending"; attempt: ManagedSiteDeployAttempt };

/**
 * Read the marker for display and acknowledgement. A marker that cannot be
 * parsed is still present: it blocks mutations and is reported as unreadable,
 * never silently ignored.
 */
export async function readPendingDeployAttempt(stackDir: string): Promise<PendingDeployAttemptRead> {
    const path = managedSiteAttemptPath(stackDir);
    try {
        await lstat(path);
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "none" } : { kind: "unreadable" };
    }
    try {
        const file = await readFileSafe(path, ATTEMPT_BYTES_MAX);
        if (!file) return { kind: "unreadable" };
        const attempt = parseDeployAttempt(file.source);
        return attempt ? { kind: "pending", attempt } : { kind: "unreadable" };
    } catch {
        return { kind: "unreadable" };
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
        /** `current` now points at the release this deploy intended. */
        pointerChanged: boolean;
        /** The stop command was attempted: the site may be down. */
        gatewayStopAttempted: boolean;
    } = {
        phase: "validate",
        siteId: null,
        releaseId: null,
        prior: null,
        markerWritten: false,
        pointerChanged: false,
        gatewayStopAttempted: false,
    };

    /** Immutable facts captured once the baseline is proven. */
    let plan: {
        manifest: ManagedSiteManifest;
        files: ComposeProjectFiles;
        target: DeployTarget;
        port: number;
        declaredImage: string;
        runtime: ServiceIdentity;
        gatewayId: string;
        baselineRelease: string;
        runtimeDir: string;
    } | null = null;
    /** The runtime container created by the activation, for the rollback check. */
    let activatedRuntimeId: string | null = null;

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
    /**
     * From the first stop attempt, the marker is evidence of a site that may be
     * down or split between the pointer and the PHP process. It is kept until
     * the service is confirmed back and probed, or the operator intervenes.
     */
    const intervene = async (reason: string): Promise<ManagedSiteDeployResult> => {
        if (state.gatewayStopAttempted || state.pointerChanged) await writeMarker("intervention").catch(() => {});
        return { kind: "intervention", reason, phase: state.phase, ...(state.releaseId ? { releaseId: state.releaseId } : {}) };
    };

    /** Stop the gateway; `running` is Docker's answer after the command. */
    const stopGateway = async (): Promise<{ ok: true } | { ok: false; unconfirmed: boolean; running: string[] | null }> => {
        if (!plan) return { ok: false, unconfirmed: false, running: null };
        state.gatewayStopAttempted = true;
        try {
            const stopped = await deps.provider.stopService({
                ...plan.files,
                service: plan.manifest.services.gateway,
                timeoutMs: deps.commandTimeoutMs,
                onOutput,
            });
            if (stopped.terminationUnconfirmed) return { ok: false, unconfirmed: true, running: null };
            const running = await deps.provider
                .runningContainerIds({ ...plan.target, service: plan.manifest.services.gateway })
                .catch(() => null);
            if (stopped.code !== 0 || stopped.timedOut) return { ok: false, unconfirmed: false, running };
            if (running === null || running.length > 0) return { ok: false, unconfirmed: false, running };
            return { ok: true };
        } catch {
            return { ok: false, unconfirmed: false, running: null };
        }
    };

    /** The gateway is running its original container and serves the baseline. */
    const confirmBaselineServing = async (): Promise<boolean> => {
        if (!plan) return false;
        const gateway = await serviceIdentity(deps, plan.target, plan.manifest.services.gateway);
        if (!gateway || gateway.containerId !== plan.gatewayId) return false;
        return (await probeFor(deps, plan.port)) === plan.baselineRelease;
    };

    /** Start the gateway (idempotent) and confirm its original container is back. */
    const startGateway = async (): Promise<"started" | "unconfirmed" | "failed"> => {
        if (!plan) return "failed";
        try {
            const started = await deps.provider.startService({
                ...plan.files,
                service: plan.manifest.services.gateway,
                timeoutMs: deps.commandTimeoutMs,
                onOutput,
            });
            if (started.terminationUnconfirmed) return "unconfirmed";
            if (started.code !== 0 || started.timedOut) return "failed";
            const gateway = await serviceIdentity(deps, plan.target, plan.manifest.services.gateway);
            if (!gateway || gateway.containerId !== plan.gatewayId) return "failed";
            return "started";
        } catch {
            return "failed";
        }
    };

    /**
     * The pointer is still the baseline but the gateway may be stopped: restore
     * the service, prove the baseline revision, then report a failure.
     */
    const restoreBaseline = async (reason: string): Promise<ManagedSiteDeployResult> => {
        if (!plan) return intervene(reason);
        const started = await startGateway();
        if (started === "unconfirmed") return fail("The gateway start could not be confirmed to have exited.", true);
        if (started === "failed") return intervene(`${reason} The gateway could not be restarted; the site needs inspection.`);
        const served = await probeFor(deps, plan.port);
        if (served === plan.baselineRelease) {
            await clearMarker(state, marker);
            return { kind: "failed", reason: `${reason} The gateway is serving the verified baseline again.`, phase: state.phase };
        }
        return intervene(`${reason} The gateway did not confirm the baseline revision${served ? ` (it serves ${served})` : ""}.`);
    };

    /**
     * The pointer is new but the runtime may not be: start the gateway so the
     * site is not left down, then report an intervention. Never claim success.
     */
    const startAfterPointerChange = async (reason: string): Promise<ManagedSiteDeployResult> => {
        if (!plan) return intervene(reason);
        const started = await startGateway();
        if (started === "unconfirmed") return fail("The gateway start could not be confirmed to have exited.", true);
        const served = started === "started" ? await probeFor(deps, plan.port) : null;
        if (started === "failed") return intervene(`${reason} The gateway could not be restarted.`);
        return intervene(`${reason} The gateway is running, but the served revision is ${served ?? "unavailable"}.`);
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
        const runtimeDir = join(deps.stackDir, ...MANAGED_SITE_PATHS.runtime.split("/"));
        plan = {
            manifest,
            files,
            target,
            port,
            declaredImage,
            runtime,
            gatewayId: gateway.containerId,
            baselineRelease: baseline.releaseId,
            runtimeDir,
        };

        // ---- fetch and publish (the active release is untouched until stop) ----
        state.phase = "fetch";
        const fetched = await deps.fetchRelease({ manifest, attemptId: deps.attemptId, onOutput });
        if (!fetched.ok) {
            const detail = fetched.detail ? ` ${fetched.detail}` : "";
            return fail(`${fetched.reason}${detail}`, fetched.unconfirmed);
        }
        state.releaseId = fetched.releaseId;

        // The fetch can be long: re-prove the pointer and the probe so a
        // concurrent external switch can never be overwritten blindly. A repeat
        // of the served SHA is a no-op only after this proof, never before it.
        const recheck = await readActive(deps.stackDir, manifest.siteId);
        if (!recheck.ok || recheck.releaseId !== baseline.releaseId) {
            return { kind: "refused", reason: "The active pointer changed while the release was being fetched; nothing was stopped." };
        }
        if ((await probeFor(deps, port)) !== baseline.releaseId) {
            return { kind: "refused", reason: "The served revision changed while the release was being fetched; nothing was stopped." };
        }
        if (fetched.releaseId === baseline.releaseId) {
            onOutput(`The probe already serves ${fetched.releaseId}; nothing to change.\n`);
            return { kind: "noop", releaseId: fetched.releaseId };
        }
        if (deps.isShuttingDown()) return fail("The panel is shutting down; nothing was stopped.");

        // ---- attempt record before any serving change ----
        state.phase = "publish";
        if (!(await writeMarker("pending"))) {
            return fail("The attempt record could not be written; nothing was stopped.");
        }

        // ---- stop the gateway and confirm ----
        state.phase = "stop";
        const stopped = await stopGateway();
        if (!stopped.ok) {
            if (stopped.unconfirmed) return fail("The gateway stop could not be confirmed to have exited.", true);
            if (stopped.running !== null && stopped.running.length === 0) {
                // The command failed after the stop: the site is down.
                return restoreBaseline("The gateway stop failed after the service stopped.");
            }
            if (await confirmBaselineServing()) {
                await clearMarker(state, marker);
                return fail("The gateway could not be stopped; it is still serving the verified baseline.");
            }
            return intervene("The gateway could not be stopped; the site needs inspection.");
        }

        // ---- atomic pointer switch ----
        state.phase = "switch";
        const switched = await switchPointer(runtimeDir, fetched.releaseId);
        if (!switched.ok) {
            const actual = await readPointerTarget(runtimeDir);
            // The gateway is stopped. If the pointer is still the baseline, put
            // the site back; if it is new, start it and require inspection.
            if (actual === `releases/${baseline.releaseId}`) return restoreBaseline(switched.reason);
            state.pointerChanged = true;
            return startAfterPointerChange(`${switched.reason} The pointer must be inspected.`);
        }
        state.pointerChanged = true;

        // ---- force-recreate the runtime ----
        state.phase = "recreate";
        // The fetch and the switch happened since the eligibility check. If the
        // tag moved, a forced recreation would silently apply another
        // already-pulled image under the same tag: refuse instead.
        const imageBeforeRecreate = await localImageId(deps.provider, declaredImage);
        if (!imageBeforeRecreate || imageBeforeRecreate !== runtime.details.imageId) {
            return startAfterPointerChange("The runtime image reference changed during the deploy; the runtime was not recreated.");
        }
        const recreated = await deps.provider.recreateService({
            ...files,
            service: manifest.services.runtime,
            force: true,
            timeoutMs: deps.commandTimeoutMs,
            onOutput,
        });
        if (recreated.terminationUnconfirmed) return fail("The runtime recreation could not be confirmed to have exited.", true);
        if (recreated.code !== 0 || recreated.timedOut) {
            return startAfterPointerChange("The runtime was not recreated; the pointer is new.");
        }
        const runtimeAfter = await serviceIdentity(deps, target, manifest.services.runtime);
        if (
            !runtimeAfter ||
            runtimeAfter.containerId === runtime.containerId ||
            runtimeAfter.details.imageId !== runtime.details.imageId ||
            runtimeAfter.details.image !== declaredImage
        ) {
            return startAfterPointerChange("The runtime container identity or image did not match after recreation.");
        }
        activatedRuntimeId = runtimeAfter.containerId;

        // ---- start the gateway and confirm its identity ----
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

        // ---- probed rollback: repeat the full activation sequence ----
        state.phase = "rollback";
        // The gateway is open on the new release. Never switch the pointer
        // underneath live traffic: stop it, switch, recreate the runtime, start
        // it, then probe, exactly like the activation.
        const imageBeforeRollback = await localImageId(deps.provider, declaredImage);
        if (!imageBeforeRollback || imageBeforeRollback !== runtime.details.imageId) {
            return intervene("The runtime image reference changed before the rollback; nothing was switched.");
        }
        const rollbackStop = await stopGateway();
        if (!rollbackStop.ok) {
            if (rollbackStop.unconfirmed) return fail("The rollback gateway stop could not be confirmed to have exited.", true);
            return startAfterPointerChange("The rollback could not stop the gateway; the site is still on the new release.");
        }
        const restored = await switchPointer(runtimeDir, baseline.releaseId);
        const pointerAfterRollback = await readPointerTarget(runtimeDir);
        if (!restored.ok && pointerAfterRollback !== `releases/${baseline.releaseId}`) {
            return startAfterPointerChange(`${restored.reason} The pointer could not be returned to the baseline.`);
        }
        const imageBeforeRollbackRecreate = await localImageId(deps.provider, declaredImage);
        if (!imageBeforeRollbackRecreate || imageBeforeRollbackRecreate !== runtime.details.imageId) {
            return startAfterPointerChange("The runtime image reference changed during the rollback; the runtime was not recreated.");
        }
        const recreatedBack = await deps.provider.recreateService({
            ...files,
            service: manifest.services.runtime,
            force: true,
            timeoutMs: deps.commandTimeoutMs,
            onOutput,
        });
        if (recreatedBack.terminationUnconfirmed) return fail("The rollback recreation could not be confirmed to have exited.", true);
        if (recreatedBack.code !== 0 || recreatedBack.timedOut) {
            return startAfterPointerChange("The rollback could not recreate the runtime.");
        }
        const runtimeBack = await serviceIdentity(deps, target, manifest.services.runtime);
        const previousRuntimeId = activatedRuntimeId ?? runtime.containerId;
        if (
            !runtimeBack ||
            runtimeBack.containerId === previousRuntimeId ||
            runtimeBack.details.imageId !== runtime.details.imageId ||
            runtimeBack.details.image !== declaredImage
        ) {
            return startAfterPointerChange("The runtime container identity or image did not match after the rollback recreation.");
        }
        const startedBack = await deps.provider.startService({
            ...files,
            service: manifest.services.gateway,
            timeoutMs: deps.commandTimeoutMs,
            onOutput,
        });
        if (startedBack.terminationUnconfirmed) return fail("The rollback gateway start could not be confirmed to have exited.", true);
        if (startedBack.code !== 0 || startedBack.timedOut) return intervene("The rollback could not start the gateway.");
        const gatewayBack = await serviceIdentity(deps, target, manifest.services.gateway);
        if (!gatewayBack || gatewayBack.containerId !== gateway.containerId) {
            return intervene("The gateway container identity changed during the rollback.");
        }
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
        // From the first stop attempt the site may be down or split between the
        // pointer and the PHP process. Restore the baseline when it is still the
        // target; otherwise start what there is and require inspection. The
        // marker is never cleared by an exception.
        try {
            if (state.gatewayStopAttempted && plan) {
                const actual = await readPointerTarget(plan.runtimeDir);
                if (actual === `releases/${plan.baselineRelease}`) return await restoreBaseline(reason);
                return await startAfterPointerChange(reason);
            }
        } catch {
            /* fall through to the marker-preserving result */
        }
        if (state.gatewayStopAttempted || state.pointerChanged) {
            await writeMarker("intervention").catch(() => {});
            return { kind: "intervention", reason, phase: state.phase, ...(state.releaseId ? { releaseId: state.releaseId } : {}) };
        }
        // Nothing was stopped or switched: the attempt marker, if any, is not
        // evidence of an ambiguous serving state and is removed.
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
