import { constants, type Stats } from "node:fs";
import { lstat, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, posix } from "node:path";
import type { CommandResult, DockerRunner } from "./docker.ts";
import { isContainerId } from "./containers.ts";
import { isSafeContainerPath } from "./toolbox.ts";

export class ActionRunnerError extends Error {
    readonly status = 400;
    constructor(message = "This container reference or path is not valid.") {
        super(message);
        this.name = "ActionRunnerError";
    }
}

export type ActionFileResult =
    | { kind: "ok"; content: string }
    | { kind: "too-large" }
    | { kind: "not-file" }
    | { kind: "error" };

export interface ActionExecTarget {
    id: string;
    /** Fixed argv, built from the declared action; never user input. */
    argv: string[];
    user?: string | null;
    workdir?: string | null;
    timeoutMs?: number;
    maxBytes?: number;
    onOutput?: (chunk: string) => void;
}

/**
 * Boundary for the two lower-level Docker calls the application toolbox needs:
 * a bounded manifest read (`docker cp`) and a non-interactive action launch
 * (`docker exec`). Both use the fixed executable and an explicit argument
 * array, never a shell, and neither exposes a free command: `exec` only ever
 * receives an argv built from a declared action ([ADR 0026]).
 */
export interface ActionRunner {
    readonly engine: string;
    /**
     * Copy one file out of a container and read it, bounded. The transfer
     * itself is NOT size-bounded (Docker `cp` copies the whole object), but the
     * read is: directories and symlinks are refused, the temporary directory is
     * private, the copy has a timeout and cleanup always runs.
     */
    readFile(id: string, path: string, options: { timeoutMs: number; maxBytes: number }): Promise<ActionFileResult>;
    exec(target: ActionExecTarget): Promise<CommandResult>;
}

class DockerActionRunner implements ActionRunner {
    readonly engine = "docker";

    constructor(private readonly runner: DockerRunner) {}

    async readFile(id: string, path: string, options: { timeoutMs: number; maxBytes: number }): Promise<ActionFileResult> {
        if (!isContainerId(id) || !isSafeContainerPath(path)) return { kind: "error" };
        let dir: string;
        try {
            dir = await mkdtemp(join(tmpdir(), "compose-panel-toolbox-"));
        } catch {
            return { kind: "error" };
        }
        try {
            const copied = await this.runner(
                ["cp", "--", `${id}:${path}`, dir],
                { timeoutMs: options.timeoutMs, maxBytes: options.maxBytes },
            );
            if (copied.code !== 0 || copied.timedOut) return { kind: "error" };

            const target = join(dir, basename(posix.normalize(path)));
            let info: Stats;
            try { info = await lstat(target); }
            catch { return { kind: "error" }; }
            // docker cp preserves directory shape and does not follow symlinks by
            // default, so both are refused rather than read.
            if (info.isSymbolicLink() || !info.isFile()) return { kind: "not-file" };
            if (info.size > options.maxBytes) return { kind: "too-large" };

            const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
            try {
                const content = await handle.readFile({ encoding: "utf8" });
                if (Buffer.byteLength(content, "utf8") > options.maxBytes) return { kind: "too-large" };
                return { kind: "ok", content };
            } finally {
                await handle.close();
            }
        } catch {
            return { kind: "error" };
        } finally {
            await rm(dir, { recursive: true, force: true }).catch(() => {});
        }
    }

    exec(target: ActionExecTarget): Promise<CommandResult> {
        if (!isContainerId(target.id)) throw new ActionRunnerError();
        const argv = target.argv;
        if (!Array.isArray(argv) || argv.length === 0 || argv.length > 16 || !argv.every(part => typeof part === "string" && part.length > 0)) {
            throw new ActionRunnerError("Invalid action command.");
        }
        const args = ["exec"];
        // No `-i`/`-t`: the action is non-interactive. The runner supplies an
        // ignored stdin and a bounded timeout/output cap.
        if (target.user) args.push("-u", target.user);
        if (target.workdir) args.push("-w", target.workdir);
        args.push(target.id, ...argv);
        return this.runner(args, { timeoutMs: target.timeoutMs, maxBytes: target.maxBytes, onChunk: target.onOutput });
    }
}

export interface ActionRunnerOptions {
    runner: DockerRunner;
    engine?: string;
}

export function createActionRunner({ runner, engine = "docker" }: ActionRunnerOptions): ActionRunner {
    if (engine === "docker") return new DockerActionRunner(runner);
    if (engine === "podman") throw new Error("Podman support is not implemented yet; the V1 action runner targets Docker.");
    throw new Error(`Unknown container engine "${engine}".`);
}
