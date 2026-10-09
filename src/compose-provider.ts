import type { CommandResult, DockerRunner } from "./docker.ts";

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
    timeoutMs?: number;
    maxBytes?: number;
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
    projectServices(input: { project: string; composeFile: string; cwd: string }): Promise<CommandResult>;
    validateConfig(input: { directory: string; composeFile: string; envFile?: string }): Promise<CommandResult>;
    pull(target: ComposeTarget): Promise<CommandResult>;
    up(target: ComposeTarget): Promise<CommandResult>;
    stop(target: ComposeTarget): Promise<CommandResult>;
    restart(target: ComposeTarget): Promise<CommandResult>;
    down(target: ComposeTarget): Promise<CommandResult>;
}

class DockerComposeProvider implements ComposeProvider {
    readonly engine = "docker";
    private caps: ComposeCapabilities = {
        engine: "docker",
        available: false,
        operations: { ls: true, ps: true, config: true },
    };

    constructor(private readonly runner: DockerRunner) {}

    capabilities(): ComposeCapabilities {
        return this.caps;
    }

    async detect(): Promise<ComposeCapabilities> {
        const result = await this.runner(["compose", "version"]);
        this.caps = {
            engine: this.engine,
            available: result.code === 0 && !result.timedOut,
            operations: { ls: true, ps: true, config: true },
        };
        return this.caps;
    }

    listProjects(): Promise<CommandResult> {
        if (!this.caps.operations.ls) return Promise.reject(new ComposeUnsupportedError("ls"));
        return this.runner(["compose", "ls", "--all", "--format", "json"]);
    }

    projectServices(input: { project: string; composeFile: string; cwd: string }): Promise<CommandResult> {
        if (!this.caps.operations.ps) return Promise.reject(new ComposeUnsupportedError("ps"));
        return this.runner(
            ["compose", "-p", input.project, "-f", input.composeFile, "ps", "--all", "--format", "json"],
            { cwd: input.cwd },
        );
    }

    validateConfig(input: { directory: string; composeFile: string; envFile?: string }): Promise<CommandResult> {
        if (!this.caps.operations.config) return Promise.reject(new ComposeUnsupportedError("config"));
        const args = ["compose"];
        if (input.envFile) args.push("--env-file", input.envFile);
        args.push("--project-directory", input.directory, "-f", input.composeFile, "config", "--quiet");
        return this.runner(args, { cwd: input.directory });
    }

    private mutation(target: ComposeTarget, command: string[]): Promise<CommandResult> {
        const args = ["compose"];
        if (target.project) args.push("-p", target.project);
        args.push("--project-directory", target.cwd, "-f", target.composeFile, ...command);
        return this.runner(args, { cwd: target.cwd, timeoutMs: target.timeoutMs, maxBytes: target.maxBytes });
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
}

export interface ComposeProviderOptions {
    runner: DockerRunner;
    engine?: string;
}

export function createComposeProvider({ runner, engine = "docker" }: ComposeProviderOptions): ComposeProvider {
    if (engine === "docker") return new DockerComposeProvider(runner);
    if (engine === "podman") throw new Error("Podman support is not implemented yet; the V1 provider targets Docker Compose.");
    throw new Error(`Unknown Compose engine "${engine}".`);
}
