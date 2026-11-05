import type { CommandResult, DockerRunner } from "./docker.ts";
import { isContainerId } from "./containers.ts";
import { containsControlCharacters } from "./text.ts";
import { isSafeContainerPath } from "./toolbox.ts";

const FULL_CONTAINER_ID = /^[0-9a-f]{64}$/;
const MAX_DRAIN_PATH = 200;

export class ContainerMutationError extends Error {
    readonly status = 400;
    constructor(message = "This container mutation is not valid.") {
        super(message);
        this.name = "ContainerMutationError";
    }
}

export interface ContainerMutationOptions {
    timeoutMs?: number;
    maxBytes?: number;
    onOutput?: (chunk: string) => void;
}

/**
 * Narrow mutation boundary for the opt-in service rollout (ADR 0035).
 *
 * The read-only `ContainerInspector` (ADR 0014) stays read-only and the Compose
 * lifecycle contract stays in `ComposeProvider` (ADR 0005). This module owns the
 * three lower-level calls a native rollout needs and nothing else: stop one
 * container, remove one stopped container, and touch a fixed drain marker.
 *
 * Every call uses the fixed Docker executable, an explicit argument array and
 * never a shell. Container IDs must be full 64-hex IDs obtained from
 * `container inspect`; a short or user-supplied reference is refused. Removal
 * never uses `--force` and never removes volumes.
 */
export interface ContainerMutator {
    readonly engine: string;
    /** `docker container stop --time <seconds> -- <id>`. */
    stop(id: string, timeoutSeconds: number, options?: ContainerMutationOptions): Promise<CommandResult>;
    /** `docker container remove -- <id>`. The container must already be stopped. */
    remove(id: string, options?: ContainerMutationOptions): Promise<CommandResult>;
    /**
     * `docker container exec <id> touch <path>`. The command is fixed: only the
     * validated absolute path comes from the Compose declaration.
     */
    markDrain(id: string, path: string, options?: ContainerMutationOptions): Promise<CommandResult>;
}

class DockerContainerMutator implements ContainerMutator {
    readonly engine = "docker";

    constructor(private readonly runner: DockerRunner) {}

    stop(id: string, timeoutSeconds: number, options: ContainerMutationOptions = {}): Promise<CommandResult> {
        requireFullId(id);
        if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 300) {
            throw new ContainerMutationError("The stop timeout must be between 1 and 300 seconds.");
        }
        // `--` ends option parsing: an ID can never be read as a flag.
        return this.runner(["container", "stop", "--time", String(timeoutSeconds), "--", id], {
            timeoutMs: options.timeoutMs ?? (timeoutSeconds + 5) * 1000,
            maxBytes: options.maxBytes,
            onChunk: options.onOutput,
        });
    }

    remove(id: string, options: ContainerMutationOptions = {}): Promise<CommandResult> {
        requireFullId(id);
        return this.runner(["container", "remove", "--", id], {
            timeoutMs: options.timeoutMs ?? 30_000,
            maxBytes: options.maxBytes,
            onChunk: options.onOutput,
        });
    }

    markDrain(id: string, path: string, options: ContainerMutationOptions = {}): Promise<CommandResult> {
        requireFullId(id);
        if (path.length === 0 || path.length > MAX_DRAIN_PATH || containsControlCharacters(path) || !isSafeContainerPath(path)) {
            throw new ContainerMutationError("The drain marker path is not valid.");
        }
        // The command is always `touch`: the declared path is an argument, never
        // a shell fragment.
        return this.runner(["container", "exec", id, "touch", path], {
            timeoutMs: options.timeoutMs ?? 10_000,
            maxBytes: options.maxBytes,
            onChunk: options.onOutput,
        });
    }
}

function requireFullId(id: string): void {
    // isContainerId accepts the short form used by read-only listings; a
    // destructive call needs the full ID returned by inspect.
    if (!isContainerId(id) || !FULL_CONTAINER_ID.test(id)) throw new ContainerMutationError();
}

export interface ContainerMutatorOptions {
    runner: DockerRunner;
    engine?: string;
}

export function createContainerMutator({ runner, engine = "docker" }: ContainerMutatorOptions): ContainerMutator {
    if (engine === "docker") return new DockerContainerMutator(runner);
    if (engine === "podman") throw new Error("Podman support is not implemented yet; the V1 mutator targets Docker.");
    throw new Error(`Unknown container engine "${engine}".`);
}
