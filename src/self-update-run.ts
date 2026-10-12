import { join } from "node:path";
import type { DockerRunner } from "./docker.ts";
import type { ComposeProjectFiles, ComposeProvider } from "./compose-provider.ts";
import {
    UPDATER_EXIT,
    isImageId,
    isInside,
    isProjectName,
    isSafePath,
    isServiceName,
    isTagReference,
    imageRepository,
    isRepoDigest,
    isUpdaterContainerId,
    ROLLBACK_TAG,
    rollbackCommands,
    recoveryCommands,
} from "./self-update.ts";

/**
 * The updater half of ADR 0018: runs inside the one-shot updater container
 * (`src/scripts/self-update.ts`), never inside the panel. It re-verifies
 * everything the panel decided, recreates the panel service from the local
 * image, then waits for the new container before reporting success.
 */

export interface UpdaterArgs {
    panelContainer: string;
    imageRef: string;
    targetImage: string;
    /** `repository@sha256:…` the release published; must be in the target's RepoDigests. */
    expectedDigest: string;
    /** Image the panel ran before the update, kept as `ROLLBACK_TAG`. */
    previousImage: string;
    project: string;
    service: string;
    workingDir: string;
    composeFiles: string[];
    envFiles: string[];
}

export class UpdaterArgsError extends Error {}

const SINGLE = ["--panel-container", "--image-ref", "--target-image", "--expected-digest", "--previous-image", "--project", "--service", "--working-dir"] as const;

/** Strict argv parsing: every value validated, unknown or repeated flags refused. */
export function parseUpdaterArgs(argv: string[]): UpdaterArgs {
    const single = new Map<string, string>();
    const composeFiles: string[] = [];
    const envFiles: string[] = [];
    for (let index = 0; index < argv.length; index += 2) {
        const flag = argv[index]!;
        const value = argv[index + 1];
        if (value === undefined) throw new UpdaterArgsError(`Missing value for ${flag}.`);
        if (flag === "--compose-file") composeFiles.push(value);
        else if (flag === "--env-file") envFiles.push(value);
        else if ((SINGLE as readonly string[]).includes(flag) && !single.has(flag)) single.set(flag, value);
        else throw new UpdaterArgsError(`Unexpected argument ${flag}.`);
    }
    const get = (flag: typeof SINGLE[number]): string => {
        const value = single.get(flag);
        if (value === undefined) throw new UpdaterArgsError(`Missing ${flag}.`);
        return value;
    };
    const args: UpdaterArgs = {
        panelContainer: get("--panel-container"),
        imageRef: get("--image-ref"),
        targetImage: get("--target-image"),
        expectedDigest: get("--expected-digest"),
        previousImage: get("--previous-image"),
        project: get("--project"),
        service: get("--service"),
        workingDir: get("--working-dir"),
        composeFiles,
        envFiles,
    };
    if (!isUpdaterContainerId(args.panelContainer)) throw new UpdaterArgsError("Invalid --panel-container.");
    if (!isTagReference(args.imageRef)) throw new UpdaterArgsError("Invalid --image-ref.");
    if (!isImageId(args.targetImage)) throw new UpdaterArgsError("Invalid --target-image.");
    if (!isRepoDigest(args.expectedDigest) || imageRepository(args.expectedDigest) !== imageRepository(args.imageRef)) {
        throw new UpdaterArgsError("Invalid --expected-digest.");
    }
    if (!isImageId(args.previousImage)) throw new UpdaterArgsError("Invalid --previous-image.");
    if (!isProjectName(args.project)) throw new UpdaterArgsError("Invalid --project.");
    if (!isServiceName(args.service)) throw new UpdaterArgsError("Invalid --service.");
    if (!isSafePath(args.workingDir)) throw new UpdaterArgsError("Invalid --working-dir.");
    if (composeFiles.length === 0) throw new UpdaterArgsError("Missing --compose-file.");
    for (const file of [...composeFiles, ...envFiles]) {
        if (!isSafePath(file) || !isInside(args.workingDir, file)) throw new UpdaterArgsError(`Invalid file ${file}.`);
    }
    return args;
}

/**
 * Environment of the updater's Docker and Compose calls: `PATH`, `HOME` and,
 * when set, `DOCKER_HOST` (which daemon to talk to; unset in the updater
 * container, which uses the mounted socket). The updater runs in the panel
 * image, whose `ENV` (`STACKS_DIR`, `PORT`, …) would otherwise take
 * precedence over `--env-file` during interpolation and silently change the
 * recreated deployment.
 */
export function updaterEnvironment(env: Record<string, string | undefined>): Record<string, string> {
    const kept: Record<string, string> = {};
    for (const key of ["PATH", "HOME", "DOCKER_HOST"]) {
        const value = env[key];
        if (value !== undefined) kept[key] = value;
    }
    return kept;
}

export interface UpdaterDeps {
    runner: DockerRunner;
    provider: ComposeProvider;
    /** One line of progress for the administrator (container logs). */
    log: (line: string) => void;
    /** Raw Compose output, forwarded as it arrives. */
    write: (chunk: string) => void;
    fileExists: (path: string) => Promise<boolean>;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
    /** Bound for `compose up`. */
    upTimeoutMs?: number;
    /** Bound for the new container to become healthy (or stay up). */
    readyTimeoutMs?: number;
    /** Without a health check, how long the new container must keep running. */
    stableMs?: number;
    pollMs?: number;
}

interface ContainerState {
    id: string;
    image: string;
    status: string;
    health: string | null;
    startedAt: string;
    version: string | null;
}

function parseContainer(stdout: string): ContainerState | null {
    try {
        const row = (JSON.parse(stdout) as Record<string, any>[])[0];
        if (!row || typeof row.Id !== "string" || typeof row.Image !== "string") return null;
        const state = row.State ?? {};
        const version = row.Config?.Labels?.["org.opencontainers.image.version"];
        return {
            id: row.Id,
            image: row.Image,
            status: typeof state.Status === "string" ? state.Status : "",
            health: typeof state.Health?.Status === "string" ? state.Health.Status : null,
            startedAt: typeof state.StartedAt === "string" ? state.StartedAt : "",
            version: typeof version === "string" && version.length <= 64 ? version : null,
        };
    } catch {
        return null;
    }
}

/**
 * Run the update. Returns the process exit code: `refused` when nothing was
 * changed, `failed` once the recreate was attempted, `updated` on success.
 */
export async function runSelfUpdate(args: UpdaterArgs, deps: UpdaterDeps): Promise<number> {
    const { runner, provider, log } = deps;
    const refuse = (reason: string): number => {
        log(`Refused: ${reason} Nothing was changed.`);
        return UPDATER_EXIT.refused;
    };
    const rollback = (): void => {
        log(`Roll back to the previous image (${ROLLBACK_TAG}) from the host:`);
        for (const line of rollbackCommands(args)) log(`  ${line}`);
    };
    const fail = (reason: string): number => {
        log(`Failed: ${reason}`);
        log("Redo the update from the host:");
        for (const line of recoveryCommands(args)) log(`  ${line}`);
        rollback();
        return UPDATER_EXIT.failed;
    };
    const files: ComposeProjectFiles = { project: args.project, cwd: args.workingDir, composeFiles: args.composeFiles, envFiles: args.envFiles };

    log(`Updating Compose project ${args.project}, service ${args.service}.`);
    log(`Previous image: ${args.previousImage}`);
    log(`Target image:   ${args.targetImage} (${args.expectedDigest})`);

    // 1. The tag must still resolve locally to the approved image, and that
    //    image must carry the digest its release published.
    const tag = await runner(["image", "inspect", "--", args.imageRef]);
    let tagged: { Id?: unknown; RepoDigests?: unknown } | null = null;
    try { tagged = tag.code === 0 ? (JSON.parse(tag.stdout) as { Id?: unknown; RepoDigests?: unknown }[])[0] ?? null : null; } catch { tagged = null; }
    if (tagged?.Id !== args.targetImage) return refuse(`${args.imageRef} no longer points to the approved image. Check for updates again.`);
    const digests = Array.isArray(tagged.RepoDigests) ? tagged.RepoDigests : [];
    if (!digests.includes(args.expectedDigest)) return refuse(`The approved image does not carry the release digest ${args.expectedDigest}.`);

    // 2. Interpolation must be explicit: an unrecorded .env would be read implicitly.
    if (args.envFiles.length === 0 && await deps.fileExists(join(args.workingDir, ".env"))) {
        return refuse(`${args.workingDir}/.env exists but Docker did not record it for this deployment.`);
    }

    // 3. The deployment files must still resolve the service to the same tag.
    const image = await provider.serviceImage({ ...files, service: args.service });
    if (image === null) return refuse("docker compose config failed for the panel deployment.");
    if (image !== args.imageRef) return refuse(`The Compose file now sets image ${image} for ${args.service}, not ${args.imageRef}. Apply that change from the host.`);

    // 4. Keep the exact previous image reachable for a rollback.
    const kept = await runner(["image", "tag", "--", args.previousImage, ROLLBACK_TAG]);
    if (kept.code !== 0 || kept.timedOut) return refuse(`Docker could not tag the previous image as ${ROLLBACK_TAG}, so a rollback would not be possible.`);

    // 5. Recreate the panel service from the local image only.
    log("Recreating the panel container. The panel stops now.");
    const up = await provider.recreateService({ ...files, service: args.service, timeoutMs: deps.upTimeoutMs ?? 5 * 60 * 1000, onOutput: deps.write });
    if (up.timedOut) return fail("docker compose up did not finish in time.");
    if (up.code !== 0) return fail(`docker compose up exited with code ${up.code}.`);

    // 6. Wait for the new container: a different one, on the target image,
    //    healthy (or still running when the image has no health check).
    const deadline = deps.now() + (deps.readyTimeoutMs ?? 3 * 60 * 1000);
    const stableMs = deps.stableMs ?? 10_000;
    let firstSeen: { startedAt: string; at: number } | null = null;
    while (deps.now() < deadline) {
        await deps.sleep(deps.pollMs ?? 2000);
        const listed = await runner([
            "container", "ls", "--all", "--no-trunc", "--quiet",
            "--filter", `label=com.docker.compose.project=${args.project}`,
            "--filter", `label=com.docker.compose.service=${args.service}`,
        ]);
        if (listed.code !== 0) continue;
        const ids = listed.stdout.split("\n").map(line => line.trim()).filter(Boolean);
        if (ids.length !== 1 || !isUpdaterContainerId(ids[0]!)) continue;
        if (ids[0] === args.panelContainer) return fail("Compose kept the previous panel container.");
        const inspected = await runner(["container", "inspect", "--", ids[0]!]);
        const state = inspected.code === 0 ? parseContainer(inspected.stdout) : null;
        if (!state) continue;
        if (state.image !== args.targetImage) return fail("The new panel container does not run the expected image.");
        if (state.status === "exited" || state.status === "dead") return fail(`The new panel container stopped (${state.status}).`);
        if (state.health === "unhealthy") return fail("The new panel container is unhealthy.");
        if (state.status !== "running") continue;
        let ready = state.health === "healthy";
        if (state.health === null) {
            // No health check: the same start must last `stableMs` (a restart
            // loop changes StartedAt and resets the clock).
            const seen: { startedAt: string; at: number } | null = firstSeen;
            if (seen && seen.startedAt === state.startedAt) ready = deps.now() - seen.at >= stableMs;
            else firstSeen = { startedAt: state.startedAt, at: deps.now() };
        }
        if (ready) {
            log(`Updated${state.version ? ` to ${state.version}` : ""}. The new panel container is running.`);
            rollback();
            return UPDATER_EXIT.updated;
        }
    }
    return fail("The new panel container did not become ready in time.");
}
