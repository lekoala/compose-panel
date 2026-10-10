import { runCommand, type CommandResult, type DockerRunner } from "./docker.ts";

export class ComposeUnsupportedError extends Error {
    constructor(operation: string) {
        super(`The configured Compose provider does not support "${operation}".`);
        this.name = "ComposeUnsupportedError";
    }
}

export interface ComposeOperations {
    ls: boolean;
    ps: boolean;
    config: boolean;
    logs: boolean;
}

export interface ComposeCapabilities {
    engine: string;
    /** Whether the provider answered a version probe at startup. */
    available: boolean;
    operations: ComposeOperations;
}

export interface ComposeTarget {
    /** Known Compose project name; omitted for a stack that is not deployed yet. */
    project?: string;
    composeFile: string;
    cwd: string;
    /** Verified `.env` path; passed explicitly so Compose cannot read one implicitly. */
    envFile?: string;
    timeoutMs?: number;
    maxBytes?: number;
    /** Live pipe chunks while a mutation runs. Retention stays capped. */
    onOutput?: (chunk: string) => void;
}

/**
 * Boundary around the Compose CLI. The rest of the application depends on these
 * business operations, never on the concrete executable or its argument layout,
 * so a second engine can be added later without scattering engine checks.
 *
 * V1 ships the Docker implementation only. See docs/adr/0005.
 */
export interface ComposeProvider {
    readonly engine: string;
    capabilities(): ComposeCapabilities;
    /** Probe the provider at startup and record what it can do. */
    detect(): Promise<ComposeCapabilities>;
    listProjects(): Promise<CommandResult>;
    /** Resolve only the effective name; never return or publish interpolated config. */
    projectName(input: { composeFile: string; cwd: string; envFile?: string }): Promise<string | null>;
    projectServices(input: { project: string; composeFile: string; cwd: string }): Promise<CommandResult>;
    /** Read-only: which image ID each container of the project runs. */
    projectImages(input: { project: string; composeFile: string; cwd: string }): Promise<CommandResult>;
    /**
     * Read-only: local details (ID, digests, creation date, labels) of images
     * given by reference or ID. References that do not look like an image
     * reference or ID are dropped, never passed to the CLI.
     */
    inspectImages(refs: string[]): Promise<CommandResult>;
    validateConfig(input: { directory: string; composeFile: string; envFile?: string; projectName?: string }): Promise<CommandResult>;
    pull(target: ComposeTarget): Promise<CommandResult>;
    up(target: ComposeTarget): Promise<CommandResult>;
    stop(target: ComposeTarget): Promise<CommandResult>;
    restart(target: ComposeTarget): Promise<CommandResult>;
    down(target: ComposeTarget): Promise<CommandResult>;
    /**
     * One-shot history read: `compose logs --tail N --timestamps --no-color`,
     * bounded by the runner timeout and output cap and without following.
     * A short read, never a subscription (see `followLogs`).
     */
    readLogs(target: ComposeTarget & { tailLines?: number }): Promise<CommandResult>;
    /**
     * Follow `compose logs` until it exits or `signal` aborts. Chunks are
     * forwarded to `onChunk` as they arrive; the caller caps and broadcasts.
     * Aborting the signal kills the subprocess. Never uses a shell.
     */
    followLogs(
        target: ComposeTarget & { tailLines?: number },
        onChunk: (chunk: string) => void,
        signal: AbortSignal,
    ): Promise<{ code: number; timedOut: boolean; terminationUnconfirmed?: boolean }>;
}

class DockerComposeProvider implements ComposeProvider {
    readonly engine = "docker";
    private caps: ComposeCapabilities = {
        engine: "docker",
        available: false,
        operations: { ls: true, ps: true, config: true, logs: true },
    };

    constructor(
        private readonly runner: DockerRunner,
        private readonly dockerPath: string = "docker",
    ) {}

    capabilities(): ComposeCapabilities {
        return this.caps;
    }

    async detect(): Promise<ComposeCapabilities> {
        const result = await this.runner(["compose", "version"]);
        this.caps = {
            engine: this.engine,
            available: result.code === 0 && !result.timedOut,
            operations: { ls: true, ps: true, config: true, logs: true },
        };
        return this.caps;
    }

    listProjects(): Promise<CommandResult> {
        if (!this.caps.operations.ls) return Promise.reject(new ComposeUnsupportedError("ls"));
        return this.runner(["compose", "ls", "--all", "--format", "json"]);
    }

    async projectName(input: { composeFile: string; cwd: string; envFile?: string }): Promise<string | null> {
        const args = ["compose"];
        if (input.envFile) args.push("--env-file", input.envFile);
        args.push("--project-directory", input.cwd, "-f", input.composeFile, "config", "--format", "json");
        const result = await this.runner(args, { cwd: input.cwd });
        if (result.code !== 0 || result.timedOut || result.truncated) return null;
        try {
            const value: unknown = JSON.parse(result.stdout);
            const name = (value as { name?: unknown } | null)?.name;
            return typeof name === "string" && /^[a-z0-9][a-z0-9_-]*$/.test(name) ? name : null;
        } catch {
            // Config and stderr may contain secrets; expose neither.
            return null;
        }
    }

    projectServices(input: { project: string; composeFile: string; cwd: string }): Promise<CommandResult> {
        if (!this.caps.operations.ps) return Promise.reject(new ComposeUnsupportedError("ps"));
        return this.runner(
            ["compose", "-p", input.project, "-f", input.composeFile, "ps", "--all", "--format", "json"],
            { cwd: input.cwd },
        );
    }

    projectImages(input: { project: string; composeFile: string; cwd: string }): Promise<CommandResult> {
        if (!this.caps.operations.ps) return Promise.reject(new ComposeUnsupportedError("images"));
        return this.runner(
            ["compose", "-p", input.project, "-f", input.composeFile, "images", "--format", "json"],
            { cwd: input.cwd },
        );
    }

    inspectImages(refs: string[]): Promise<CommandResult> {
        const safe = [...new Set(refs)].filter(isImageReference);
        if (safe.length === 0) return Promise.resolve({ code: 0, stdout: "[]", stderr: "", timedOut: false, truncated: false });
        // `--` ends option parsing: a reference can never be read as a flag.
        return this.runner(["image", "inspect", "--", ...safe]);
    }

    validateConfig(input: { directory: string; composeFile: string; envFile?: string; projectName?: string }): Promise<CommandResult> {
        if (!this.caps.operations.config) return Promise.reject(new ComposeUnsupportedError("config"));
        const args = ["compose"];
        if (input.projectName) args.push("-p", input.projectName);
        if (input.envFile) args.push("--env-file", input.envFile);
        args.push("--project-directory", input.directory, "-f", input.composeFile, "config", "--quiet");
        return this.runner(args, { cwd: input.directory });
    }

    private mutation(target: ComposeTarget, command: string[]): Promise<CommandResult> {
        const args = ["compose"];
        if (target.project) args.push("-p", target.project);
        if (target.envFile) args.push("--env-file", target.envFile);
        args.push("--project-directory", target.cwd, "-f", target.composeFile, ...command);
        return this.runner(args, { cwd: target.cwd, timeoutMs: target.timeoutMs, maxBytes: target.maxBytes, onChunk: target.onOutput });
    }

    pull(target: ComposeTarget): Promise<CommandResult> {
        return this.mutation(target, ["pull"]);
    }

    up(target: ComposeTarget): Promise<CommandResult> {
        return this.mutation(target, ["up", "-d"]);
    }

    stop(target: ComposeTarget): Promise<CommandResult> {
        return this.mutation(target, ["stop"]);
    }

    restart(target: ComposeTarget): Promise<CommandResult> {
        return this.mutation(target, ["restart"]);
    }

    down(target: ComposeTarget): Promise<CommandResult> {
        return this.mutation(target, ["down"]);
    }

    readLogs(target: ComposeTarget & { tailLines?: number }): Promise<CommandResult> {
        if (!this.caps.operations.logs) return Promise.reject(new ComposeUnsupportedError("logs"));
        const tail = target.tailLines ?? 200;
        const args = ["compose"];
        if (target.project) args.push("-p", target.project);
        if (target.envFile) args.push("--env-file", target.envFile);
        args.push(
            "--project-directory", target.cwd,
            "-f", target.composeFile,
            "logs", "--tail", String(tail), "--timestamps", "--no-color",
        );
        // A bounded short read: the runner's timeout and output cap apply.
        return this.runner(args, { cwd: target.cwd, timeoutMs: target.timeoutMs, maxBytes: target.maxBytes });
    }

    async followLogs(
        target: ComposeTarget & { tailLines?: number },
        onChunk: (chunk: string) => void,
        signal: AbortSignal,
    ): Promise<{ code: number; timedOut: boolean; terminationUnconfirmed?: boolean }> {
        if (!this.caps.operations.logs) throw new ComposeUnsupportedError("logs");
        const tail = target.tailLines ?? 200;
        const args = ["compose"];
        if (target.project) args.push("-p", target.project);
        if (target.envFile) args.push("--env-file", target.envFile);
        args.push(
            "--project-directory", target.cwd,
            "-f", target.composeFile,
            "logs", "--follow", "--tail", String(tail), "--timestamps",
        );
        // LogManager owns the follow timeout; the runner owns bounded abort,
        // signal escalation, pipe cleanup and stateful UTF-8 decoding.
        const result = await runCommand(this.dockerPath, args, {
            cwd: target.cwd, timeoutMs: 0, maxBytes: 0, signal, onChunk,
        });
        return { code: result.code, timedOut: result.timedOut, terminationUnconfirmed: result.terminationUnconfirmed };
    }
}

const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const IMAGE_REFERENCE = /^[a-z0-9][a-z0-9._/:@-]{0,254}$/i;

/** An image ID, or a reference like `registry:5000/ns/name:tag@sha256:…`. */
export function isImageReference(value: string): boolean {
    return IMAGE_ID.test(value) || (IMAGE_REFERENCE.test(value) && !value.includes(".."));
}

export interface ComposeProviderOptions {
    runner: DockerRunner;
    engine?: string;
    /** Fixed Docker executable for streaming spawns. Must match the runner's. */
    dockerPath?: string;
}

export function createComposeProvider({ runner, engine = "docker", dockerPath = "docker" }: ComposeProviderOptions): ComposeProvider {
    if (engine === "docker") return new DockerComposeProvider(runner, dockerPath);
    if (engine === "podman") throw new Error("Podman support is not implemented yet; the V1 provider targets Docker Compose.");
    throw new Error(`Unknown Compose engine "${engine}".`);
}
