import type { CommandResult } from "./docker.ts";
import { verifiesCandidateIdentity, type RolloutDeclaration, type RolloutInspect } from "./rollout.ts";

const POLL_INTERVAL_MS = 1000;
const WINDOW_SLICE_MS = 500;

export interface RolloutTarget {
    project: string;
    composeFile: string;
    cwd: string;
    envFile?: string;
}

/** The authoritative, locked preflight result. */
export interface RolloutPreparation {
    oldContainerId: string;
    declaration: RolloutDeclaration;
    image: string;
}

export type RolloutPreparationResult = { ok: true; preparation: RolloutPreparation } | { ok: false; reason: string };

export interface RolloutDependencies {
    pull(target: RolloutTarget, service: string, onOutput: (chunk: string) => void, timeoutMs: number): Promise<CommandResult>;
    scale(target: RolloutTarget, service: string, onOutput: (chunk: string) => void, timeoutMs: number): Promise<CommandResult>;
    /** Every container of the service, any state. `null` on any read failure. */
    listServiceContainers(target: RolloutTarget, service: string): Promise<string[] | null>;
    inspect(id: string): Promise<RolloutInspect | null>;
    /** Resolve the declared image reference to a local image ID. */
    imageId(reference: string): Promise<string | null>;
    stop(id: string, timeoutSeconds: number, onOutput: (chunk: string) => void, timeoutMs: number): Promise<CommandResult>;
    remove(id: string, onOutput: (chunk: string) => void, timeoutMs: number): Promise<CommandResult>;
    markDrain(id: string, path: string, onOutput: (chunk: string) => void, timeoutMs: number): Promise<CommandResult>;
    sleep(ms: number): Promise<void>;
    now(): number;
    isShuttingDown(): boolean;
}

export interface RolloutInput {
    target: RolloutTarget;
    service: string;
    /** Download the service image before starting the candidate. */
    pull: boolean;
    /** Per-command Docker timeout. */
    operationTimeoutMs: number;
    /** Overall budget for pull, health, settle, drain, stop and cleanup. */
    rolloutTimeoutMs: number;
    onOutput: (chunk: string) => void;
    /** Full locked revalidation; called before anything mutates. */
    prepare: () => Promise<RolloutPreparationResult>;
}

export type RolloutRunResult = CommandResult | { refused: string } | { intervention: string };

type WindowVerdict = { kind: "ok" } | { kind: "timeout" } | { kind: "failed"; reason: string } | { kind: "intervention"; reason: string };

/**
 * Native, opt-in rollout of one service (ADR 0035).
 *
 * The nominal path starts a second replica without recreating the first, waits
 * for it to become healthy, optionally drains the old one, then stops and
 * removes only that old container.
 *
 * Failure policy: the first drain attempt (the marker or the stop in a
 * marker-less rollout) is an irreversible boundary. Before it, the candidate
 * may be removed when its identity is proven. At or after it, nothing is
 * removed automatically: the candidate is kept and the operation reports an
 * intervention. A command whose exit could not be confirmed is `unknown` and
 * keeps the stack lock, like every other operation.
 */
export async function runRollout(deps: RolloutDependencies, input: RolloutInput): Promise<RolloutRunResult> {
    const startedAt = deps.now();
    const deadline = startedAt + Math.max(1, input.rolloutTimeoutMs);
    const initialIds: string[] = [];

    const say = (message: string): void => {
        input.onOutput(`\n[rollout] ${message}\n`);
    };
    const result = (code: number, terminationUnconfirmed?: boolean, timedOut = false): CommandResult => ({
        code,
        stdout: "",
        stderr: "",
        timedOut,
        truncated: false,
        ...(terminationUnconfirmed ? { terminationUnconfirmed: true } : {}),
    });
    const failed = (reason: string): CommandResult => {
        say(reason);
        return result(1);
    };
    const intervention = (reason: string): { intervention: string } => {
        say(`Intervention required: ${reason}`);
        return { intervention: reason };
    };
    const unknown = (command: CommandResult, reason: string): CommandResult => {
        say(`Outcome unknown: ${reason}`);
        return result(command.code, true, command.timedOut);
    };
    const shuttingDown = (): boolean => deps.isShuttingDown();
    const expired = (): boolean => deps.now() >= deadline;
    const commandTimeout = (): number => Math.max(1, Math.min(input.operationTimeoutMs, deadline - deps.now()));
    // Cleanup must be allowed a bounded grace even when the rollout budget has
    // expired: a 1 ms stop would turn a safe abort into an intervention.
    const cleanupTimeout = (declaration: RolloutDeclaration): number =>
        Math.max(1000, Math.min(input.operationTimeoutMs, (declaration.stopTimeoutSeconds + 5) * 1000));

    async function discover(): Promise<RolloutInspect[] | null> {
        const ids = await deps.listServiceContainers(input.target, input.service);
        if (ids === null) return null;
        const byId = new Map<string, RolloutInspect>();
        for (const id of ids) {
            const inspected = await deps.inspect(id);
            if (!inspected) return null;
            byId.set(inspected.id, inspected);
        }
        return [...byId.values()];
    }

    type CleanupOutcome = { kind: "ok" } | { kind: "refused"; reason: string; unconfirmed?: boolean };

    /** Before the boundary: remove only candidates whose identity is proven. */
    async function cleanupCandidates(ids: readonly string[], declaration: RolloutDeclaration): Promise<CleanupOutcome> {
        if (ids.length === 0) return { kind: "ok" };
        // Verify everything before touching anything.
        for (const id of ids) {
            const inspected = await deps.inspect(id);
            if (
                !inspected ||
                !verifiesCandidateIdentity({
                    inspect: inspected,
                    project: input.target.project,
                    service: input.service,
                    composeFile: input.target.composeFile,
                    cwd: input.target.cwd,
                    operationStartedAt: startedAt,
                    initialIds,
                })
            ) {
                return {
                    kind: "refused",
                    reason: "The new container could not be proven to be created by this operation, so it was not removed.",
                };
            }
        }
        for (const id of ids) {
            const stopped = await deps.stop(id, declaration.stopTimeoutSeconds, input.onOutput, cleanupTimeout(declaration));
            if (stopped.terminationUnconfirmed) {
                return { kind: "refused", reason: "Stopping the new container did not confirm its exit.", unconfirmed: true };
            }
            if (stopped.code !== 0 || stopped.timedOut) {
                return { kind: "refused", reason: "The new container could not be stopped cleanly." };
            }
            const removed = await deps.remove(id, input.onOutput, cleanupTimeout(declaration));
            if (removed.terminationUnconfirmed) {
                return { kind: "refused", reason: "Removing the new container did not confirm its exit.", unconfirmed: true };
            }
            if (removed.code !== 0 || removed.timedOut) {
                return { kind: "refused", reason: "The new container could not be removed cleanly." };
            }
        }
        return { kind: "ok" };
    }

    async function abortBeforeBoundary(ids: readonly string[], declaration: RolloutDeclaration, reason: string): Promise<RolloutRunResult> {
        const cleanup = await cleanupCandidates(ids, declaration);
        if (cleanup.kind === "refused") {
            if (cleanup.unconfirmed) return unknown(result(1, true), `${reason} ${cleanup.reason}`);
            return intervention(`${reason} ${cleanup.reason}`);
        }
        say(`${reason} Nothing was kept from the failed attempt.`);
        return result(1);
    }

    async function waitWindow(totalMs: number, check: () => Promise<WindowVerdict>): Promise<WindowVerdict> {
        if (expired()) return { kind: "timeout" };
        const end = Math.min(deadline, deps.now() + Math.max(0, totalMs));
        for (;;) {
            if (shuttingDown()) return { kind: "intervention", reason: "The panel is shutting down." };
            const verdict = await check();
            if (verdict.kind !== "ok") return verdict;
            const left = end - deps.now();
            if (left <= 0) return { kind: "ok" };
            if (expired()) return { kind: "timeout" };
            await deps.sleep(Math.min(WINDOW_SLICE_MS, left));
        }
    }

    const preparation = await input.prepare();
    if (!preparation.ok) return { refused: preparation.reason };
    const declaration = preparation.preparation.declaration;

    // Re-read the service before any mutation: exactly one container, in any
    // state, and it is the one the locked preflight described.
    const initial = await discover();
    if (!initial) return failed("Docker did not respond, so the service's containers could not be read. Nothing was changed.");
    if (initial.length !== 1) {
        return failed("The service does not have exactly one container (in any state) right now, so the rollout was not started.");
    }
    const old = initial[0]!;
    if (old.id !== preparation.preparation.oldContainerId) {
        return failed("The service's container changed since it was checked, so the rollout was not started.");
    }
    initialIds.push(old.id);
    if (!old.running || old.health !== "healthy") {
        return failed("The service's container is no longer running and healthy, so the rollout was not started.");
    }

    if (input.pull) {
        if (shuttingDown()) return failed("The panel is shutting down, so nothing was downloaded.");
        if (expired()) return failed("The rollout budget expired before the download started.");
        say("Downloading the service image.");
        const pulled = await deps.pull(input.target, input.service, input.onOutput, commandTimeout());
        if (pulled.terminationUnconfirmed) return unknown(pulled, "the image download did not confirm its exit.");
        if (pulled.code !== 0 || pulled.timedOut) return failed("The image download failed. Nothing was started.");
    }

    if (shuttingDown()) return failed("The panel is shutting down, so nothing was started.");
    if (expired()) return failed("The rollout budget expired before the new instance was started.");

    const expectedImageId = await deps.imageId(preparation.preparation.image);
    if (!expectedImageId) {
        return failed("The declared image is not available locally. Pull it first, or enable the download step.");
    }

    say("Starting the new instance alongside the current one.");
    const scaled = await deps.scale(input.target, input.service, input.onOutput, commandTimeout());
    if (scaled.terminationUnconfirmed) return unknown(scaled, "starting the new instance did not confirm its exit.");

    const afterScale = await discover();
    if (!afterScale) {
        return intervention("the new instance state could not be read after starting it. Check the stack before retrying.");
    }
    if (!afterScale.some((container) => container.id === old.id)) {
        return intervention("the original container disappeared during the rollout. Nothing was removed automatically.");
    }
    const created = afterScale.filter((container) => !initialIds.includes(container.id));

    if (scaled.code !== 0 || scaled.timedOut) {
        if (created.length === 0) return failed("Starting the new instance failed. Nothing was created.");
        if (created.length > 1 || afterScale.length !== 2) {
            return intervention(
                "Starting the new instance failed and left an ambiguous set of containers. Nothing was removed automatically.",
            );
        }
        return abortBeforeBoundary([created[0]!.id], declaration, "Starting the new instance failed after creating a container.");
    }
    if (created.length !== 1 || afterScale.length !== 2) {
        // More than one new container, or an extra container that was not in
        // the snapshot, is ambiguous: an external CLI may have acted too.
        return intervention(
            "The service has an unexpected number of containers after starting the new instance. Nothing was removed automatically.",
        );
    }
    const candidate = created[0]!;

    say("Waiting for the new instance to become healthy.");
    const healthDeadline = Math.min(deadline, deps.now() + declaration.timeoutSeconds * 1000);
    for (;;) {
        if (shuttingDown()) {
            return abortBeforeBoundary([candidate.id], declaration, "The panel is shutting down while the new instance starts.");
        }
        const inspected = await deps.inspect(candidate.id);
        if (inspected) {
            if (!inspected.running) {
                return abortBeforeBoundary([candidate.id], declaration, "The new instance exited before becoming healthy.");
            }
            if (inspected.health === null) {
                return abortBeforeBoundary([candidate.id], declaration, "The new instance has no effective healthcheck.");
            }
            if (inspected.health === "unhealthy") {
                return abortBeforeBoundary([candidate.id], declaration, "The new instance is unhealthy.");
            }
            if (inspected.health === "healthy") {
                if (inspected.imageId !== expectedImageId) {
                    return abortBeforeBoundary([candidate.id], declaration, "The new instance does not run the expected image.");
                }
                break;
            }
        }
        if (deps.now() >= healthDeadline) {
            return abortBeforeBoundary([candidate.id], declaration, "The new instance did not become healthy before its timeout.");
        }
        await deps.sleep(Math.max(1, Math.min(POLL_INTERVAL_MS, healthDeadline - deps.now())));
    }

    if (declaration.settleSeconds > 0) {
        say(`Waiting ${declaration.settleSeconds}s for the proxy to discover the new instance.`);
    }
    const settle = await waitWindow(declaration.settleSeconds * 1000, async () => {
        const candidateNow = await deps.inspect(candidate.id);
        if (!candidateNow || !candidateNow.running) return { kind: "failed", reason: "The new instance stopped during the settle window." };
        if (candidateNow.health === null)
            return { kind: "failed", reason: "The new instance lost its healthcheck during the settle window." };
        if (candidateNow.health !== "healthy") return { kind: "failed", reason: "The new instance is no longer healthy." };
        if (candidateNow.imageId !== expectedImageId) {
            return { kind: "failed", reason: "The new instance no longer runs the expected image." };
        }
        const oldNow = await deps.inspect(old.id);
        if (!oldNow || !oldNow.running) return { kind: "failed", reason: "The original container stopped during the settle window." };
        if (oldNow.health === null) return { kind: "failed", reason: "The original container lost its healthcheck." };
        if (oldNow.health !== "healthy") return { kind: "failed", reason: "The original container is no longer healthy." };
        return { kind: "ok" };
    });
    if (settle.kind === "timeout") {
        return abortBeforeBoundary([candidate.id], declaration, "The rollout budget expired during the settle window.");
    }
    if (settle.kind === "failed") {
        return abortBeforeBoundary([candidate.id], declaration, settle.reason);
    }
    if (settle.kind === "intervention") {
        return abortBeforeBoundary([candidate.id], declaration, settle.reason);
    }

    if (declaration.drainFile !== null) {
        // Boundary: from here a marker may have changed the old container, so
        // nothing is removed automatically if anything goes wrong.
        say("Marking the current instance for drainage.");
        const marked = await deps.markDrain(old.id, declaration.drainFile, input.onOutput, commandTimeout());
        if (marked.terminationUnconfirmed) return unknown(marked, "the drain marker could not be confirmed.");
        if (marked.code !== 0 || marked.timedOut) {
            return intervention("the drain marker could not be set. The old and new instances were kept.");
        }

        say(`Waiting up to ${declaration.drainDetectSeconds}s for the current instance to report unhealthy.`);
        const detectDeadline = Math.min(deadline, deps.now() + declaration.drainDetectSeconds * 1000);
        let drained = false;
        for (;;) {
            if (shuttingDown()) return intervention("the panel is shutting down during drainage. Both instances were kept.");
            const inspected = await deps.inspect(old.id);
            if (inspected) {
                if (!inspected.running) {
                    return intervention("the current instance stopped before its drainage was confirmed. The new instance was kept.");
                }
                if (inspected.health === "unhealthy") {
                    drained = true;
                    break;
                }
            }
            if (deps.now() >= detectDeadline) break;
            await deps.sleep(Math.max(1, Math.min(WINDOW_SLICE_MS, detectDeadline - deps.now())));
        }
        if (!drained) {
            return intervention("the current instance did not report unhealthy before the detection timeout. Both instances were kept.");
        }

        if (declaration.drainTimeSeconds > 0) {
            say(`Waiting ${declaration.drainTimeSeconds}s for propagation and in-flight requests.`);
        }
        const drainWindow = await waitWindow(declaration.drainTimeSeconds * 1000, async () => {
            const candidateNow = await deps.inspect(candidate.id);
            if (!candidateNow || !candidateNow.running || candidateNow.health !== "healthy") {
                return { kind: "intervention", reason: "the new instance failed during drainage. Nothing was removed." };
            }
            if (candidateNow.imageId !== expectedImageId) {
                return { kind: "intervention", reason: "the new instance no longer runs the expected image. Nothing was removed." };
            }
            const oldNow = await deps.inspect(old.id);
            if (!oldNow || !oldNow.running) {
                return { kind: "intervention", reason: "the current instance is no longer running. Nothing was removed." };
            }
            if (oldNow.health === "healthy") {
                return { kind: "intervention", reason: "the current instance became healthy again during drainage. Nothing was removed." };
            }
            return { kind: "ok" };
        });
        if (drainWindow.kind !== "ok") {
            return intervention(
                drainWindow.kind === "timeout"
                    ? "the rollout budget expired during drainage. Both instances were kept."
                    : drainWindow.reason,
            );
        }
    }

    if (shuttingDown()) {
        if (declaration.drainFile === null) {
            return abortBeforeBoundary([candidate.id], declaration, "The panel is shutting down before the switch.");
        }
        return intervention("the panel is shutting down before the current instance is stopped. Both instances were kept.");
    }

    const finalCandidate = await deps.inspect(candidate.id);
    if (!finalCandidate || !finalCandidate.running || finalCandidate.health !== "healthy") {
        if (declaration.drainFile === null) {
            return abortBeforeBoundary([candidate.id], declaration, "The new instance is not healthy just before the switch.");
        }
        return intervention("the new instance is not healthy just before the switch. Nothing was removed.");
    }
    if (finalCandidate.imageId !== expectedImageId) {
        if (declaration.drainFile === null) {
            return abortBeforeBoundary([candidate.id], declaration, "The new instance does not run the expected image.");
        }
        return intervention("the new instance does not run the expected image. Nothing was removed.");
    }

    // Marker-less rollouts become irreversible at the stop attempt.
    say("Stopping the current instance.");
    const stopped = await deps.stop(old.id, declaration.stopTimeoutSeconds, input.onOutput, cleanupTimeout(declaration));
    if (stopped.terminationUnconfirmed) return unknown(stopped, "stopping the current instance did not confirm its exit.");
    if (stopped.code !== 0 || stopped.timedOut) {
        return intervention("the current instance could not be stopped. The new instance was kept.");
    }

    const removed = await deps.remove(old.id, input.onOutput, cleanupTimeout(declaration));
    if (removed.terminationUnconfirmed) return unknown(removed, "removing the current instance did not confirm its exit.");
    if (removed.code !== 0 || removed.timedOut) {
        return intervention("the current instance could not be removed. The new instance was kept.");
    }

    const finalInspect = await deps.inspect(candidate.id);
    if (!finalInspect || !finalInspect.running || finalInspect.health !== "healthy" || finalInspect.imageId !== expectedImageId) {
        return intervention("the new instance is not healthy after the old one was removed. No further action was taken.");
    }

    say("Rollout completed: the new instance is healthy and the old one was removed.");
    return result(0);
}
