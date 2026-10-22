import type { CommandResult, DockerRunner } from "./docker.ts";
import { CONTAINER_LIST_FIELD_COUNT } from "./container-state.ts";

export class ContainerRefError extends Error {
    readonly status = 400;
    constructor(message = "This container reference is not valid.") {
        super(message);
        this.name = "ContainerRefError";
    }
}

/**
 * One line per container, tab-separated, each field JSON-encoded so a value
 * containing a quote or a tab cannot desynchronize the columns. The Compose
 * labels are read individually (`| json`) instead of parsing the `.Labels`
 * string. Field order must match `parseContainerLs` (`container-state.ts`);
 * `CONTAINER_LIST_FIELD_COUNT` pins the two together.
 */
export const CONTAINER_LIST_FORMAT = [
    "{{json .ID}}",
    "{{json .Names}}",
    "{{json .Image}}",
    "{{json .State}}",
    "{{json .Status}}",
    "{{json .HealthStatus}}",
    "{{json .CreatedAt}}",
    "{{json .RunningFor}}",
    "{{json .Ports}}",
    '{{.Label "com.docker.compose.project" | json}}',
    '{{.Label "com.docker.compose.service" | json}}',
    '{{.Label "com.docker.compose.project.config_files" | json}}',
    '{{.Label "com.docker.compose.project.working_dir" | json}}',
].join("\\t");

/** Accepted `docker logs --tail` values. Anything else falls back to the default. */
export const CONTAINER_LOG_TAIL_OPTIONS = [100, 200, 500, 1000] as const;
export const CONTAINER_LOG_TAIL_DEFAULT = 200;

const CONTAINER_ID = /^[0-9a-f]{12,64}$/;

export function isContainerId(value: string): boolean {
    return CONTAINER_ID.test(value);
}

/** Reject a free-form/negative/absurd tail and use a bounded, known value. */
export function sanitizeTailLines(value: number | undefined): number {
    return typeof value === "number" && (CONTAINER_LOG_TAIL_OPTIONS as readonly number[]).includes(value)
        ? value
        : CONTAINER_LOG_TAIL_DEFAULT;
}

export interface ContainerLogTarget {
    id: string;
    /** Requested tail; sanitized against the allow-list. */
    tailLines?: number;
    timeoutMs?: number;
    maxBytes?: number;
}

/** Bounded read options for the engine-wide, read-only calls. */
export interface InspectorReadOptions {
    timeoutMs?: number;
    maxBytes?: number;
}

/**
 * Boundary around the lower-level, read-only Docker calls that are not Compose
 * operations: `docker container ls`, `inspect`, `logs`, and the engine-wide
 * `info`/`stats`/`system df` diagnostics. The Compose lifecycle contract stays
 * in `ComposeProvider` (ADR 0005); the two are never mixed.
 *
 * Every command uses the fixed Docker executable and an explicit argument array,
 * never a shell. There is no mutation, no exec and no user-supplied option: the
 * read-only guarantee is application-level (see ADR 0014), not enforced by the
 * socket mount.
 */
export interface ContainerInspector {
    readonly engine: string;
    /** `docker container ls -a`, one structured line per container. */
    list(): Promise<CommandResult>;
    /** `docker container inspect` for a single, validated container ID. */
    inspect(id: string): Promise<CommandResult>;
    /** Bounded, one-shot `docker container logs`; no follow. */
    logs(target: ContainerLogTarget): Promise<CommandResult>;
    /** `docker info`, projected onto named fields by the caller (ADR 0015). */
    info(options?: InspectorReadOptions): Promise<CommandResult>;
    /** `docker stats --no-stream`, one JSON object per container. */
    stats(options?: InspectorReadOptions): Promise<CommandResult>;
    /** `docker system df`, Docker-managed storage only. Read on demand. */
    diskUsage(options?: InspectorReadOptions): Promise<CommandResult>;
}

class DockerContainerInspector implements ContainerInspector {
    readonly engine = "docker";

    constructor(private readonly runner: DockerRunner) {}

    list(): Promise<CommandResult> {
        return this.runner(["container", "ls", "-a", "--no-trunc", "--format", CONTAINER_LIST_FORMAT]);
    }

    inspect(id: string): Promise<CommandResult> {
        if (!isContainerId(id)) throw new ContainerRefError();
        // `--` ends option parsing: a reference can never be read as a flag.
        return this.runner(["container", "inspect", "--", id]);
    }

    logs(target: ContainerLogTarget): Promise<CommandResult> {
        if (!isContainerId(target.id)) throw new ContainerRefError();
        const tail = sanitizeTailLines(target.tailLines);
        // `docker logs` has no `--no-color`; ANSI escapes are stripped by the
        // panel before display. A bounded read: the runner applies its timeout
        // and output cap.
        return this.runner(["container", "logs", "--tail", String(tail), "--timestamps", "--", target.id], {
            timeoutMs: target.timeoutMs,
            maxBytes: target.maxBytes,
        });
    }

    info(options: InspectorReadOptions = {}): Promise<CommandResult> {
        // `{{json .}}` yields one JSON object; the caller projects named fields.
        return this.runner(["info", "--format", "{{json .}}"], options);
    }

    stats(options: InspectorReadOptions = {}): Promise<CommandResult> {
        // `--no-stream` returns once; `--no-trunc` keeps full container IDs so
        // they can be joined with the container list.
        return this.runner(["stats", "--no-stream", "--no-trunc", "--format", "{{json .}}"], options);
    }

    diskUsage(options: InspectorReadOptions = {}): Promise<CommandResult> {
        // Potentially expensive on large hosts; the caller only calls it on
        // demand and caches the result (ADR 0015).
        return this.runner(["system", "df", "--format", "{{json .}}"], options);
    }
}

export interface ContainerInspectorOptions {
    runner: DockerRunner;
    engine?: string;
}

export function createContainerInspector({ runner, engine = "docker" }: ContainerInspectorOptions): ContainerInspector {
    if (engine === "docker") return new DockerContainerInspector(runner);
    if (engine === "podman") throw new Error("Podman support is not implemented yet; the V1 inspector targets Docker.");
    throw new Error(`Unknown container engine "${engine}".`);
}
