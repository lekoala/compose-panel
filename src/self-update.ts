import { posix } from "node:path";
import type { CommandResult, DockerRunner } from "./docker.ts";
import { isImageReference, type ComposeProvider } from "./compose-provider.ts";
import { parseImageInspect } from "./compose-state.ts";
import { findByTag, linkFor, versionOf, type ImageLink, type ImageVersion } from "./updates.ts";

/**
 * Panel self-update (ADR 0018). The panel identifies its own container from
 * Docker, pulls its own tag on request, and hands the recreate to a one-shot
 * updater container so the process being replaced never runs the replacement.
 * The updater's outcome stays in Docker and is read back by the next panel.
 *
 * Every Docker call here uses fixed argument arrays built from validated
 * values read from Docker itself, never from the browser, and never a shell.
 */

/** Fixed name: Docker refuses a second updater while one exists. */
export const UPDATER_NAME = "compose-panel-updater";
/** Marks the updater the panel created; a same-named foreign container is never touched. */
export const UPDATER_LABEL = "io.github.lekoala.compose-panel.updater";
/** Updater exit codes, shared with `src/self-update-run.ts`. */
export const UPDATER_EXIT = { updated: 0, failed: 1, refused: 2 } as const;
/** The socket path inside the panel and updater containers. */
export const DOCKER_SOCKET = "/var/run/docker.sock";

const CONTAINER_ID = /^[0-9a-f]{64}$/;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const PROJECT_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const SERVICE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
/** `--mount` values are CSV: no comma or quote, and nothing unusual in a path. */
const SAFE_PATH = /^\/[A-Za-z0-9._/@+ -]{0,1023}$/;
const USER_SPEC = /^[A-Za-z0-9_.-]{1,64}(:[A-Za-z0-9_.-]{1,64})?$/;
const GROUP = /^[A-Za-z0-9_.-]{1,64}$/;

export class SelfUpdateError extends Error {
    constructor(message: string, readonly status = 409) {
        super(message);
        this.name = "SelfUpdateError";
    }
}

/** What the panel learned about its own deployment. Values are validated. */
export interface SelfIdentity {
    containerId: string;
    /** Image ID the container runs (also the image the updater starts from). */
    imageId: string;
    /** Image reference the service was started from, e.g. `ghcr.io/lekoala/compose-panel:latest`. */
    imageRef: string;
    project: string;
    service: string;
    workingDir: string;
    composeFiles: string[];
    envFiles: string[];
    /** Host path of the Docker socket mounted into the panel. */
    socketSource: string;
    /** `--user` of the panel container, if any. */
    user: string | null;
    groupAdd: string[];
}

export type SelfSupport =
    | { kind: "ready"; identity: SelfIdentity }
    | { kind: "unsupported"; reason: string };

export function isUpdaterContainerId(value: string): boolean {
    return CONTAINER_ID.test(value);
}

export function isImageId(value: string): boolean {
    return IMAGE_ID.test(value);
}

export function isProjectName(value: string): boolean {
    return PROJECT_NAME.test(value);
}

export function isServiceName(value: string): boolean {
    return SERVICE_NAME.test(value);
}

/** Absolute, already normalized (no `.`/`..`/`//`), and safe in a `--mount` value. */
export function isSafePath(value: string): boolean {
    return SAFE_PATH.test(value) && posix.normalize(value) === value && !value.endsWith("/");
}

/** A path strictly below `dir`. Both must already be safe paths. */
export function isInside(dir: string, path: string): boolean {
    return path.startsWith(`${dir}/`);
}

/** A pullable tag, never an image ID or a digest-pinned reference. */
export function isTagReference(value: string): boolean {
    return isImageReference(value) && !value.includes("@") && !value.startsWith("sha256:");
}

/**
 * The panel's own container ID. Docker bind-mounts `/etc/hostname` (and
 * `hosts`, `resolv.conf`) from `<data-root>/containers/<id>/`, and that source
 * path appears in `/proc/self/mountinfo` whatever the network mode.
 */
export function containerIdFromMountinfo(text: string): string | null {
    const match = /\/containers\/([0-9a-f]{64})\/(?:hostname|hosts|resolv\.conf) /.exec(text);
    return match ? match[1]! : null;
}

function commaList(value: string | undefined): string[] {
    if (!value) return [];
    return value.split(",").map(part => part.trim()).filter(Boolean);
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringRecord(value: unknown): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, item] of Object.entries(record(value))) {
        if (typeof item === "string") out[key] = item;
    }
    return out;
}

const unsupported = (reason: string): SelfSupport => ({ kind: "unsupported", reason });

/**
 * Validate `docker container inspect` of the panel's own container. Anything
 * missing or unexpected makes self-update unavailable with a reason; nothing is
 * guessed or defaulted.
 */
export function parseSelfInspect(stdout: string, expectedId: string): SelfSupport {
    let rows: unknown;
    try { rows = JSON.parse(stdout); }
    catch { return unsupported("Docker returned an unreadable description of the panel container."); }
    const row = record(Array.isArray(rows) ? rows[0] : null);
    if (row.Id !== expectedId) return unsupported("Docker did not describe the panel's own container.");
    const config = record(row.Config);
    const labels = stringRecord(config.Labels);
    const imageId = typeof row.Image === "string" ? row.Image : "";
    const imageRef = typeof config.Image === "string" ? config.Image : "";

    const project = labels["com.docker.compose.project"] ?? "";
    const service = labels["com.docker.compose.service"] ?? "";
    const workingDir = labels["com.docker.compose.project.working_dir"] ?? "";
    if (!project || !service || !workingDir) {
        return unsupported("The panel was not started by Docker Compose, so it cannot tell how to recreate itself. Update it from the host.");
    }
    if (labels["com.docker.compose.oneoff"] !== "False") return unsupported("The panel runs in a one-off container (compose run). Update it from the host.");
    if (!isProjectName(project) || !isServiceName(service)) return unsupported("The panel's Compose project or service name has an unexpected format.");
    if (!isImageId(imageId)) return unsupported("Docker did not report which image the panel runs.");
    if (!isTagReference(imageRef)) {
        return unsupported("The panel runs from an image pinned by digest or ID, so there is no tag to update. Change the image reference on the host.");
    }
    if (!isSafePath(workingDir)) return unsupported("The panel's deployment directory is not a plain absolute path.");
    const composeFiles = commaList(labels["com.docker.compose.project.config_files"]);
    const envFiles = commaList(labels["com.docker.compose.project.environment_file"]);
    if (composeFiles.length === 0) return unsupported("Docker did not record which Compose files started the panel.");
    for (const file of [...composeFiles, ...envFiles]) {
        if (!isSafePath(file) || !isInside(workingDir, file)) {
            return unsupported("A Compose or env file of the panel's deployment is outside its deployment directory, or not a plain absolute path. Update it from the host.");
        }
    }

    const mounts = Array.isArray(row.Mounts) ? row.Mounts.map(record) : [];
    const socket = mounts.find(mount => mount.Destination === DOCKER_SOCKET && mount.Type === "bind");
    const socketSource = typeof socket?.Source === "string" ? socket.Source : "";
    if (!isSafePath(socketSource)) return unsupported(`The Docker socket is not bind-mounted at ${DOCKER_SOCKET} in the panel container.`);

    const user = typeof config.User === "string" && config.User !== "" ? config.User : null;
    if (user !== null && !USER_SPEC.test(user)) return unsupported("The panel container's user has an unexpected format.");
    const hostConfig = record(row.HostConfig);
    const groupAdd = Array.isArray(hostConfig.GroupAdd) ? hostConfig.GroupAdd.filter((group): group is string => typeof group === "string") : [];
    if (!groupAdd.every(group => GROUP.test(group))) return unsupported("The panel container's extra groups have an unexpected format.");

    return {
        kind: "ready",
        identity: { containerId: expectedId, imageId, imageRef, project, service, workingDir, composeFiles, envFiles, socketSource, user, groupAdd },
    };
}

/** POSIX single-quoting for copy-paste: plain words stay bare, anything else is quoted. */
export function shellQuote(value: string): string {
    return /^[A-Za-z0-9._/@:+=-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Host commands that redo the update by hand, shown both in the updater output
 * and on the About page so the two never disagree. A manual `pull` + `up` is
 * the documented recovery (docs/deployment.md, "Upgrade and rollback").
 */
export function recoveryCommands(target: { workingDir: string; project: string; service: string; composeFiles: string[]; envFiles: string[] }): string[] {
    const compose = [
        "docker", "compose", "-p", target.project,
        ...target.envFiles.flatMap(file => ["--env-file", file]),
        ...target.composeFiles.flatMap(file => ["-f", file]),
    ].map(shellQuote).join(" ");
    return [
        `cd ${shellQuote(target.workingDir)}`,
        `${compose} pull ${shellQuote(target.service)}`,
        `${compose} up -d --no-deps ${shellQuote(target.service)}`,
    ];
}

/** Arguments of the updater script, in the order `parseUpdaterArgs` reads them. */
export function updaterCommand(identity: SelfIdentity, targetImageId: string): string[] {
    const args = [
        "--panel-container", identity.containerId,
        "--image-ref", identity.imageRef,
        "--target-image", targetImageId,
        "--project", identity.project,
        "--service", identity.service,
        "--working-dir", identity.workingDir,
    ];
    for (const file of identity.composeFiles) args.push("--compose-file", file);
    for (const file of identity.envFiles) args.push("--env-file", file);
    return args;
}

/**
 * `docker container run` for the updater: started from the image the panel
 * runs now, no network (the daemon pulls, not the updater), the socket and the
 * deployment directory read-only at the same path, same user and groups.
 */
export function updaterRunArgs(identity: SelfIdentity, targetImageId: string): string[] {
    if (!isImageId(targetImageId)) throw new SelfUpdateError("The target image is not a valid image ID.", 400);
    const args = [
        "container", "run", "--detach",
        "--name", UPDATER_NAME,
        "--label", `${UPDATER_LABEL}=1`,
        "--network", "none",
        "--pull", "never",
        "--restart", "no",
        "--mount", `type=bind,source=${identity.socketSource},target=${DOCKER_SOCKET}`,
        "--mount", `type=bind,source=${identity.workingDir},target=${identity.workingDir},readonly`,
        "--entrypoint", "bun",
    ];
    if (identity.user) args.push("--user", identity.user);
    for (const group of identity.groupAdd) args.push("--group-add", group);
    args.push(identity.imageId, "src/scripts/self-update.ts", ...updaterCommand(identity, targetImageId));
    return args;
}

export type UpdaterOutcome = "running" | "updated" | "refused" | "failed";

export interface UpdaterRun {
    outcome: UpdaterOutcome;
    exitCode: number | null;
    startedAt: string | null;
    finishedAt: string | null;
}

export type UpdaterLookup =
    | { kind: "none" }
    | { kind: "foreign" }
    | { kind: "run"; run: UpdaterRun };

function isoTime(value: unknown): string | null {
    // Docker reports "0001-01-01T00:00:00Z" for a time that never happened.
    return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && !value.startsWith("0001-") ? value : null;
}

/** `docker container inspect` of the updater name. A container without the label is foreign. */
export function parseUpdaterInspect(stdout: string): UpdaterLookup {
    let rows: unknown;
    try { rows = JSON.parse(stdout); }
    catch { return { kind: "none" }; }
    if (!Array.isArray(rows) || rows.length === 0) return { kind: "none" };
    const row = record(rows[0]);
    if (stringRecord(record(row.Config).Labels)[UPDATER_LABEL] !== "1") return { kind: "foreign" };
    const state = record(row.State);
    const status = typeof state.Status === "string" ? state.Status : "";
    const exitCode = typeof state.ExitCode === "number" ? state.ExitCode : null;
    let outcome: UpdaterOutcome;
    if (status === "running" || status === "restarting" || status === "created") outcome = "running";
    else if (status === "exited" && exitCode === UPDATER_EXIT.updated) outcome = "updated";
    else if (status === "exited" && exitCode === UPDATER_EXIT.refused) outcome = "refused";
    else outcome = "failed";
    return {
        kind: "run",
        run: { outcome, exitCode: outcome === "running" ? null : exitCode, startedAt: isoTime(state.StartedAt), finishedAt: outcome === "running" ? null : isoTime(state.FinishedAt) },
    };
}

export interface AvailableUpdate {
    imageId: string;
    version: ImageVersion;
    link: ImageLink | null;
}

export interface SelfUpdateStatus {
    support: SelfSupport;
    /** Version of the image the panel runs; null when unknown. */
    current: ImageVersion | null;
    /** The tag now points to another image than the one running. */
    available: AvailableUpdate | null;
    /** The last updater container, if one is still in Docker. */
    lastRun: UpdaterLookup;
}

export interface SelfUpdaterOptions {
    runner: DockerRunner;
    provider: ComposeProvider;
    /** Reads `/proc/self/mountinfo`; null when unreadable (not Linux, no /proc). */
    readMountinfo?: () => Promise<string | null>;
    /** Bound for the image pull. */
    pullTimeoutMs: number;
    /** Bound for one updater run, used by `wait`. */
    updaterTimeoutMs?: number;
    /** Cap on captured output. */
    maxBytes: number;
}

async function defaultMountinfo(): Promise<string | null> {
    try { return await Bun.file("/proc/self/mountinfo").text(); }
    catch { return null; }
}

function firstLine(text: string): string {
    const line = text.split("\n").map(part => part.trim()).find(Boolean) ?? "";
    return line.length > 300 ? `${line.slice(0, 300)}…` : line;
}

const UNAVAILABLE = "Docker did not respond. Nothing was changed.";

/** The panel-side half of ADR 0018. */
export class SelfUpdater {
    private readonly readMountinfo: () => Promise<string | null>;

    constructor(private readonly options: SelfUpdaterOptions) {
        this.readMountinfo = options.readMountinfo ?? defaultMountinfo;
    }

    private run(args: string[], extra: { timeoutMs?: number; maxBytes?: number } = {}): Promise<CommandResult> {
        return this.options.runner(args, { maxBytes: this.options.maxBytes, ...extra });
    }

    /** Find and validate the panel's own deployment. Never throws. */
    async identify(): Promise<SelfSupport> {
        try {
            const mountinfo = await this.readMountinfo();
            const id = mountinfo ? containerIdFromMountinfo(mountinfo) : null;
            if (!id) return unsupported("The panel is not running in a Docker container, so it cannot update itself. Update it from the host.");
            const result = await this.run(["container", "inspect", "--", id]);
            if (result.code !== 0 || result.timedOut || result.truncated) return unsupported("Docker could not describe the panel container.");
            const support = parseSelfInspect(result.stdout, id);
            if (support.kind !== "ready") return support;
            const images = await this.options.provider.inspectImages([support.identity.imageId]);
            const current = images.timedOut || images.truncated
                ? undefined
                : parseImageInspect(images.stdout).find(detail => detail.id === support.identity.imageId);
            // Fail closed: without the image description the panel cannot tell
            // a pulled image from a local build.
            if (!current) return unsupported("Docker could not describe the image the panel runs.");
            // An image with no registry digest was built locally: pulling the tag
            // cannot bring a newer build.
            if (current.repoDigests.length === 0) {
                return unsupported("The panel runs a locally built image. Rebuild it from the host to update.");
            }
            return support;
        } catch {
            return unsupported("Docker could not describe the panel container.");
        }
    }

    /** Read-only: identity, running and tagged image, last updater. */
    async status(): Promise<SelfUpdateStatus> {
        const support = await this.identify();
        const lastRun = await this.lookup().catch((): UpdaterLookup => ({ kind: "none" }));
        if (support.kind !== "ready") return { support, current: null, available: null, lastRun };
        const { imageId, imageRef } = support.identity;
        let current: ImageVersion | null = null;
        let available: AvailableUpdate | null = null;
        try {
            const inspected = await this.options.provider.inspectImages([imageId, imageRef]);
            if (!inspected.timedOut && !inspected.truncated) {
                const details = parseImageInspect(inspected.stdout);
                const running = details.find(detail => detail.id === imageId);
                current = running ? versionOf(running) : null;
                const tagged = findByTag(details, imageRef);
                if (tagged && tagged.id !== imageId && isImageId(tagged.id)) {
                    available = { imageId: tagged.id, version: versionOf(tagged), link: linkFor(imageRef, tagged.labels) };
                }
            }
        } catch { /* no information, never an invented update */ }
        return { support, current, available, lastRun };
    }

    /** Download the panel's own tag. Touches no container. */
    async pull(identity: SelfIdentity): Promise<CommandResult> {
        if (!isTagReference(identity.imageRef)) throw new SelfUpdateError("The panel image reference is not a tag.", 400);
        // `--` ends option parsing: a reference can never be read as a flag.
        return this.run(["image", "pull", "--quiet", "--", identity.imageRef], { timeoutMs: this.options.pullTimeoutMs });
    }

    async lookup(): Promise<UpdaterLookup> {
        const result = await this.run(["container", "inspect", "--", UPDATER_NAME]);
        if (result.code === 0 && !result.timedOut) return parseUpdaterInspect(result.stdout);
        if (!result.timedOut && /no such (container|object)/i.test(result.stderr)) return { kind: "none" };
        throw new SelfUpdateError(UNAVAILABLE, 503);
    }

    /** Bounded output of the last updater. Null when Docker cannot read it. */
    async output(): Promise<string | null> {
        const result = await this.run(["container", "logs", "--tail", "300", "--", UPDATER_NAME]).catch(() => null);
        if (!result || result.code !== 0 || result.timedOut) return null;
        // The updater writes to both streams; order across them is not kept.
        return `${result.stdout}${result.stderr}`;
    }

    /**
     * Remove a finished updater of the panel, then start a new one. Refuses a
     * running updater and never touches a same-named foreign container.
     */
    async launch(identity: SelfIdentity, targetImageId: string): Promise<void> {
        const args = updaterRunArgs(identity, targetImageId);
        const previous = await this.lookup();
        if (previous.kind === "foreign") {
            throw new SelfUpdateError(`A container named ${UPDATER_NAME} exists and was not created by the panel. Remove or rename it on the host, then try again.`);
        }
        if (previous.kind === "run" && previous.run.outcome === "running") {
            throw new SelfUpdateError("An update is already running.");
        }
        if (previous.kind === "run") {
            const removed = await this.run(["container", "rm", "--", UPDATER_NAME]);
            if (removed.code !== 0 || removed.timedOut) throw new SelfUpdateError("Docker could not remove the previous updater container. Nothing was changed.", 503);
        }
        const started = await this.run(args);
        if (started.code !== 0 || started.timedOut) {
            const reason = firstLine(started.stderr);
            throw new SelfUpdateError(`Docker could not start the updater${reason ? `: ${reason}` : "."} Nothing was changed.`, 503);
        }
    }

    /** Resolves when the updater container stops (or the bound elapses). */
    async wait(): Promise<void> {
        await this.run(["container", "wait", "--", UPDATER_NAME], { timeoutMs: this.options.updaterTimeoutMs ?? 20 * 60 * 1000 }).catch(() => undefined);
    }
}
