import { posix } from "node:path";

export class ContainerStateError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ContainerStateError";
    }
}

/**
 * Number of tab-separated fields emitted by `CONTAINER_LIST_FORMAT`
 * (`src/containers.ts`). Kept here so a test can assert the two stay in sync.
 */
export const CONTAINER_LIST_FIELD_COUNT = 13;

/**
 * One row of `docker container ls`, projected onto the fields the panel uses.
 * Only `id` is trusted enough to be passed back to Docker; every other value is
 * untrusted text and must be escaped before display.
 */
export interface ContainerSummary {
    id: string;
    name: string;
    image: string;
    state: string;
    status: string;
    health: string | null;
    createdAt: string;
    runningFor: string;
    ports: string;
    /** `com.docker.compose.project`, or null when absent. */
    project: string | null;
    /** `com.docker.compose.service`, or null when absent. */
    service: string | null;
    /** `com.docker.compose.project.config_files`, split on commas. */
    configFiles: string[];
    /** `com.docker.compose.project.working_dir`, or null when absent. */
    workingDir: string | null;
}

export type ContainerCategory = "managed" | "external" | "standalone";

export interface ClassifiedContainer extends ContainerSummary {
    category: ContainerCategory;
    /** Name of the managed stack this container belongs to, when `managed`. */
    stack: string | null;
}

/** A stack the panel discovered, used to classify containers as Managed. */
export interface ManagedStack {
    name: string;
    /** Canonical absolute Compose file path, as known to the panel. */
    composeFile: string;
    /** Deployed Docker Compose project name, when known. */
    project: string | null;
}

/**
 * Prefix remapping for host/panel path differences (for example a Dockge
 * migration where the host path is `/opt/stacks` and the panel mounts it at
 * `/app/stacks`). `from` is the Docker-side prefix, `to` the panel-side one.
 */
export interface PathAlias {
    from: string;
    to: string;
}

const CONTAINER_ID = /^[0-9a-f]{12,64}$/;

function jsonField(part: string): string {
    let value: unknown;
    try {
        value = JSON.parse(part);
    } catch {
        throw new ContainerStateError("Unexpected docker container ls output.");
    }
    if (value === null || value === undefined) return "";
    return typeof value === "string" ? value : String(value);
}

/** `docker ps` may report several comma-separated names; show the first. */
function cleanName(value: string): string {
    const first = value.split(",")[0] ?? "";
    return first.trim().replace(/^\/+/, "");
}

function splitConfigFiles(value: string): string[] {
    return value.split(",").map(entry => entry.trim()).filter(Boolean);
}

/**
 * Parse `docker container ls --format <CONTAINER_LIST_FORMAT>`: one line per
 * container, fields tab-separated and each field individually JSON-encoded, so
 * a value containing a quote or a tab cannot desynchronize the columns.
 */
export function parseContainerLs(stdout: string): ContainerSummary[] {
    const containers: ContainerSummary[] = [];
    for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const parts = line.split("\t");
        if (parts.length !== CONTAINER_LIST_FIELD_COUNT) {
            throw new ContainerStateError("Unexpected docker container ls output.");
        }
        const [
            id, names, image, state, status, health, createdAt, runningFor, ports,
            project, service, configFiles, workingDir,
        ] = parts.map(jsonField);
        if (!CONTAINER_ID.test(id!)) throw new ContainerStateError("Unexpected docker container ls output.");
        const healthValue = (health ?? "").trim();
        containers.push({
            id: id!,
            name: cleanName(names!),
            image: image!,
            state: state!,
            status: status!,
            // `docker ps` reports "none" (or an empty string) when there is no
            // health check; treat both as "not configured" rather than a value.
            health: healthValue && healthValue.toLowerCase() !== "none" ? healthValue : null,
            createdAt: createdAt!,
            runningFor: runningFor!,
            ports: ports!,
            project: project ? project : null,
            service: service ? service : null,
            configFiles: splitConfigFiles(configFiles!),
            workingDir: workingDir ? workingDir : null,
        });
    }
    return containers;
}

export interface ContainerPort {
    /** Container side, e.g. "8080/tcp". */
    container: string;
    /** Host binding, e.g. "0.0.0.0:8080", or null when not published. */
    host: string | null;
    /** True when Docker binds it on every host interface (0.0.0.0 / :: / empty). */
    publicInterface: boolean;
}

export interface ContainerMount {
    type: string;
    source: string;
    destination: string;
    mode: string;
    readOnly: boolean;
}

/**
 * The whitelisted projection of `docker container inspect`. Only these fields
 * are ever extracted: `Config.Env`, `Args` and every other field are dropped and
 * must never be retained, logged or returned (see ADR 0014).
 */
export interface ContainerDetails {
    id: string;
    name: string;
    image: string | null;
    imageId: string | null;
    created: string | null;
    state: string;
    running: boolean;
    paused: boolean;
    restarting: boolean;
    exitCode: number | null;
    startedAt: string | null;
    finishedAt: string | null;
    health: string | null;
    restartPolicy: string | null;
    ports: ContainerPort[];
    mounts: ContainerMount[];
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function asText(value: unknown): string | null {
    return typeof value === "string" && value ? value : null;
}

function parsePublishedPorts(value: unknown): ContainerPort[] {
    const ports: ContainerPort[] = [];
    for (const [containerPort, bindings] of Object.entries(asRecord(value))) {
        if (!Array.isArray(bindings) || bindings.length === 0) {
            ports.push({ container: containerPort, host: null, publicInterface: false });
            continue;
        }
        for (const binding of bindings) {
            const entry = asRecord(binding);
            const hostIp = asText(entry.HostIp) ?? "";
            const hostPort = asText(entry.HostPort) ?? "";
            const ip = hostIp || "0.0.0.0";
            // Bracket an IPv6 address so "[::]:8080" is unambiguous.
            const formatted = ip.includes(":") ? `[${ip}]` : ip;
            ports.push({
                container: containerPort,
                host: hostPort ? `${formatted}:${hostPort}` : null,
                publicInterface: hostIp === "" || hostIp === "0.0.0.0" || hostIp === "::",
            });
        }
    }
    return ports.sort((a, b) => a.container.localeCompare(b.container));
}

function parseMounts(value: unknown): ContainerMount[] {
    if (!Array.isArray(value)) return [];
    const mounts: ContainerMount[] = [];
    for (const item of value) {
        const mount = asRecord(item);
        const type = asText(mount.Type);
        const destination = asText(mount.Destination);
        if (!type || !destination) continue;
        const mode = asText(mount.Mode) ?? "";
        mounts.push({
            type,
            source: asText(mount.Source) ?? "",
            destination,
            mode,
            readOnly: mount.RW === false || /\bro\b/.test(mode),
        });
    }
    return mounts;
}

/**
 * Project `docker container inspect` onto the whitelisted fields. The raw object
 * is never returned: `Config.Env` and `Args` cannot leak through here.
 */
export function parseContainerInspect(stdout: string): ContainerDetails {
    const raw = stdout.trim();
    if (!raw) throw new ContainerStateError("Unexpected docker container inspect output.");
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new ContainerStateError("Unexpected docker container inspect output.");
    }
    const container = asRecord(Array.isArray(parsed) ? parsed[0] : parsed);
    const id = asText(container.Id);
    if (!id || !CONTAINER_ID.test(id)) throw new ContainerStateError("Unexpected docker container inspect output.");
    const state = asRecord(container.State);
    const config = asRecord(container.Config);
    const hostConfig = asRecord(container.HostConfig);
    const network = asRecord(container.NetworkSettings);
    return {
        id,
        name: (asText(container.Name) ?? "").replace(/^\/+/, ""),
        image: asText(config.Image),
        imageId: asText(container.Image),
        created: asText(container.Created),
        state: asText(state.Status) ?? "unknown",
        running: state.Running === true,
        paused: state.Paused === true,
        restarting: state.Restarting === true,
        exitCode: typeof state.ExitCode === "number" ? state.ExitCode : null,
        startedAt: asText(state.StartedAt),
        finishedAt: asText(state.FinishedAt),
        health: asText(asRecord(state.Health).Status),
        restartPolicy: asText(asRecord(hostConfig.RestartPolicy).Name),
        ports: parsePublishedPorts(network.Ports),
        mounts: parseMounts(container.Mounts),
    };
}

/**
 * Normalize a Compose path to a comparable form: apply a known host/panel alias
 * first, then POSIX-normalize and drop trailing slashes. Never assumes the path
 * seen by Docker equals the panel's own path.
 */
export function normalizeComposePath(value: string, aliases: PathAlias[] = []): string {
    let path = value.trim().replace(/\\/g, "/");
    for (const alias of aliases) {
        const from = alias.from.trim().replace(/\\/g, "/").replace(/\/+$/, "");
        if (from && (path === from || path.startsWith(`${from}/`))) {
            path = `${alias.to.replace(/\\/g, "/").replace(/\/+$/, "")}${path.slice(from.length)}`;
            break;
        }
    }
    return posix.normalize(path).replace(/\/+$/, "");
}

/**
 * Classify containers against the stacks the panel actually discovered.
 *
 * Managed is deliberately strict: a `config_files` path that maps to a
 * discovered stack file, or (only when `config_files` is absent) a project name
 * that matches exactly one deployed managed stack. Anything uncertain — a
 * renamed project, an unmappable path, several files, a stack removed while its
 * container still runs — stays External Compose. A container is never promoted
 * to Managed on a name resemblance alone.
 */
export function classifyContainers(
    containers: ContainerSummary[],
    stacks: ManagedStack[],
    aliases: PathAlias[] = [],
): ClassifiedContainer[] {
    const fileOwners = new Map<string, string>();
    const projectsByName = new Map<string, string[]>();
    for (const stack of stacks) {
        const file = normalizeComposePath(stack.composeFile, aliases);
        if (!fileOwners.has(file)) fileOwners.set(file, stack.name);
        if (stack.project) {
            const owners = projectsByName.get(stack.project) ?? [];
            owners.push(stack.name);
            projectsByName.set(stack.project, owners);
        }
    }

    return containers.map(container => {
        const files = container.configFiles.map(file => normalizeComposePath(file, aliases));
        if (files.length > 0) {
            const owner = files.map(file => fileOwners.get(file)).find(name => name !== undefined);
            return { ...container, category: owner ? "managed" as const : "external" as const, stack: owner ?? null };
        }
        if (container.project) {
            const owners = projectsByName.get(container.project) ?? [];
            if (owners.length === 1) return { ...container, category: "managed" as const, stack: owners[0]! };
            return { ...container, category: "external" as const, stack: null };
        }
        return { ...container, category: "standalone" as const, stack: null };
    });
}

export type ContainerFilter = "running" | "stopped" | "all";

/**
 * States shown by the default "running" filter. `restarting` and `paused` are
 * active, so a container being restarted never disappears from the default view.
 */
const ACTIVE_STATES = new Set(["running", "restarting", "paused"]);

/**
 * Whether a container matches a view filter. "stopped" is "anything not
 * active", so an unrecognized state is shown there rather than hidden.
 */
export function matchesContainerFilter(state: string, filter: ContainerFilter): boolean {
    if (filter === "all") return true;
    const active = ACTIVE_STATES.has(state.toLowerCase());
    return filter === "running" ? active : !active;
}

const FILTERS: readonly ContainerFilter[] = ["running", "stopped", "all"];

/** Parse a `?state=` value, falling back to the default "running" view. */
export function parseContainerFilter(value: string | null): ContainerFilter {
    return FILTERS.includes(value as ContainerFilter) ? value as ContainerFilter : "running";
}
