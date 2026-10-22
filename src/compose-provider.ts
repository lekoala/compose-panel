import { composeEnvironment, runCommand, type CommandResult, type DockerRunner } from "./docker.ts";
import { projectMetadata, type DeclaredMetadata } from "./deployment.ts";

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
    /**
     * Whether `config --hash` hashes services the way containers are created
     * (environment resolved, Compose 5.5.0+). Gates "Recreate pending" (ADR 0032).
     */
    configHashes: boolean;
}

export interface ComposeTarget {
    /** Known Compose project name; omitted for a stack that is not deployed yet. */
    project?: string;
    composeFile: string;
    cwd: string;
    /** Verified `.env` path; passed explicitly so Compose cannot read one implicitly. */
    envFile?: string;
    /** Single service to scope a read to. Validated against discovery, never free text. */
    service?: string;
    timeoutMs?: number;
    maxBytes?: number;
    /** Live pipe chunks while a mutation runs. Retention stays capped. */
    onOutput?: (chunk: string) => void;
}

/**
 * A deployed project addressed by the exact files Compose recorded in its
 * container labels: several `-f` files and `--env-file`s, in order. Used by the
 * self-update only (ADR 0018); stacks keep the single-file `ComposeTarget`.
 */
export interface ComposeProjectFiles {
    project: string;
    /** Absolute project directory. */
    cwd: string;
    /** Absolute Compose files, in their original order. */
    composeFiles: string[];
    /** Absolute interpolation files, in their original order. */
    envFiles: string[];
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
    projectServices(input: { project: string; composeFile: string; cwd: string; envFile?: string }): Promise<CommandResult>;
    /**
     * Read-only: IDs of the currently running containers of one service, from
     * `compose ps --status running -q`. `null` when Compose fails, times out or
     * truncates, or the service name is invalid: callers must refuse, never
     * guess a container. Used to pin one container for the application toolbox
     * ([ADR 0026]).
     */
    runningContainerIds(input: {
        project: string;
        composeFile: string;
        cwd: string;
        service: string;
        envFile?: string;
    }): Promise<string[] | null>;
    /** Read-only: which image ID each container of the project runs. */
    projectImages(input: { project: string; composeFile: string; cwd: string; envFile?: string }): Promise<CommandResult>;
    /**
     * Read-only: local details (ID, digests, creation date, labels) of images
     * given by reference or ID. References that do not look like an image
     * reference or ID are dropped, never passed to the CLI.
     */
    inspectImages(refs: string[]): Promise<CommandResult>;
    /**
     * Read-only: `container inspect` of containers named by `compose ps`. Used
     * only when a running container's image can no longer be inspected (the
     * containerd image store drops an image once its tag moves), to read the
     * OCI labels the container inherited from it (ADR 0023). Names that do not
     * look like container names are dropped, never passed to the CLI.
     */
    inspectContainers(names: string[]): Promise<CommandResult>;
    /**
     * Read-only: the configuration hash of each service as `up` would compute
     * it now (`config --hash "*"`), in the same project context as a mutation
     * (ADR 0032). Only service names and hashes leave the provider. `null` when
     * the Compose version is not validated for it, or on any failure or
     * unexpected line: callers show nothing, never a guess.
     */
    serviceConfigHashes(input: {
        project: string;
        composeFile: string;
        cwd: string;
        envFile?: string;
    }): Promise<Map<string, string> | null>;
    /** Allow-listed resolved labels only; raw config and stderr remain private. */
    stackMetadata(target: ComposeTarget): Promise<DeclaredMetadata | null>;
    validateConfig(input: { directory: string; composeFile: string; envFile?: string; projectName?: string }): Promise<CommandResult>;
    /**
     * Read-only service names from the effective config (`config --services`),
     * in the same context as a mutation. `null` when Compose fails, times out,
     * truncates, or prints an unexpected name: callers must refuse, never use a
     * partial list. No `--profiles` flag is ever passed, so a service disabled
     * by its profile cannot be activated implicitly.
     */
    listServices(target: ComposeTarget): Promise<string[] | null>;
    pull(target: ComposeTarget): Promise<CommandResult>;
    up(target: ComposeTarget): Promise<CommandResult>;
    stop(target: ComposeTarget): Promise<CommandResult>;
    start(target: ComposeTarget): Promise<CommandResult>;
    restart(target: ComposeTarget): Promise<CommandResult>;
    down(target: ComposeTarget): Promise<CommandResult>;
    /**
     * The image reference one service resolves to in the effective config.
     * Only that string is returned: the interpolated config never leaves the
     * provider. `null` when Compose fails or the service is absent.
     */
    serviceImage(input: ComposeProjectFiles & { service: string }): Promise<string | null>;
    /**
     * Recreate one service from the local image only:
     * `up -d --no-deps --no-build --pull never <service>`. Nothing is pulled or
     * built, and no other service is touched.
     */
    recreateService(
        input: ComposeProjectFiles & { service: string; timeoutMs?: number; onOutput?: (chunk: string) => void },
    ): Promise<CommandResult>;
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
        configHashes: false,
    };

    constructor(
        private readonly runner: DockerRunner,
        private readonly dockerPath: string = "docker",
    ) {}

    capabilities(): ComposeCapabilities {
        return this.caps;
    }

    async detect(): Promise<ComposeCapabilities> {
        const result = await this.runner(["compose", "version", "--short"]);
        const available = result.code === 0 && !result.timedOut;
        this.caps = {
            engine: this.engine,
            available,
            operations: { ls: true, ps: true, config: true, logs: true },
            configHashes: available && !result.truncated && hashesResolveEnvironment(result.stdout),
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

    projectServices(input: { project: string; composeFile: string; cwd: string; envFile?: string }): Promise<CommandResult> {
        if (!this.caps.operations.ps) return Promise.reject(new ComposeUnsupportedError("ps"));
        return this.readProject(input, ["ps", "--all", "--format", "json"]);
    }

    projectImages(input: { project: string; composeFile: string; cwd: string; envFile?: string }): Promise<CommandResult> {
        if (!this.caps.operations.ps) return Promise.reject(new ComposeUnsupportedError("images"));
        return this.readProject(input, ["images", "--format", "json"]);
    }

    private readProject(
        input: { project: string; composeFile: string; cwd: string; envFile?: string },
        command: string[],
    ): Promise<CommandResult> {
        const args = ["compose", "-p", input.project];
        if (input.envFile) args.push("--env-file", input.envFile);
        args.push("--project-directory", input.cwd, "-f", input.composeFile, ...command);
        return this.runner(args, {
            cwd: input.cwd,
            // An absent verified file must not become an implicit .env read.
            // Explicit operator COMPOSE_ENV_FILES remains supported (ADR 0008).
            env: input.envFile ? undefined : { ...composeEnvironment(), COMPOSE_DISABLE_ENV_FILE: "true" },
        });
    }

    async runningContainerIds(input: {
        project: string;
        composeFile: string;
        cwd: string;
        service: string;
        envFile?: string;
    }): Promise<string[] | null> {
        if (!this.caps.operations.ps) return null;
        if (!isComposeServiceName(input.service)) return null;
        const args = ["compose", "-p", input.project];
        // The verified `.env` is passed explicitly, exactly like a mutation, so
        // Compose cannot read one implicitly (COMPOSE_ENV_FILES or a local file).
        if (input.envFile) args.push("--env-file", input.envFile);
        args.push("-f", input.composeFile, "ps", "--status", "running", "-q", input.service);
        const result = await this.runner(args, { cwd: input.cwd });
        if (result.code !== 0 || result.timedOut || result.truncated) return null;
        const ids = result.stdout
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean);
        // A partial or surprising answer must never be used to pick a container.
        if (!ids.every((id) => /^[0-9a-f]{12,64}$/.test(id))) return null;
        return [...new Set(ids)];
    }

    inspectImages(refs: string[]): Promise<CommandResult> {
        const safe = [...new Set(refs)].filter(isImageReference);
        if (safe.length === 0) return Promise.resolve({ code: 0, stdout: "[]", stderr: "", timedOut: false, truncated: false });
        // `--` ends option parsing: a reference can never be read as a flag.
        return this.runner(["image", "inspect", "--", ...safe]);
    }

    inspectContainers(names: string[]): Promise<CommandResult> {
        const safe = [...new Set(names)].filter(isContainerName);
        if (safe.length === 0) return Promise.resolve({ code: 0, stdout: "[]", stderr: "", timedOut: false, truncated: false });
        return this.runner(["container", "inspect", "--", ...safe]);
    }

    async serviceConfigHashes(input: {
        project: string;
        composeFile: string;
        cwd: string;
        envFile?: string;
    }): Promise<Map<string, string> | null> {
        if (!this.caps.configHashes || !this.caps.operations.config) return null;
        const result = await this.readProject(input, ["config", "--hash", "*"]);
        // stderr may echo interpolated values: it is never read.
        if (result.code !== 0 || result.timedOut || result.truncated) return null;
        return parseConfigHashes(result.stdout);
    }

    validateConfig(input: { directory: string; composeFile: string; envFile?: string; projectName?: string }): Promise<CommandResult> {
        if (!this.caps.operations.config) return Promise.reject(new ComposeUnsupportedError("config"));
        const args = ["compose"];
        if (input.projectName) args.push("-p", input.projectName);
        if (input.envFile) args.push("--env-file", input.envFile);
        args.push("--project-directory", input.directory, "-f", input.composeFile, "config", "--quiet");
        return this.runner(args, { cwd: input.directory });
    }

    async stackMetadata(target: ComposeTarget): Promise<DeclaredMetadata | null> {
        if (!this.caps.operations.config) throw new ComposeUnsupportedError("config");
        const result = await this.runTarget(target, ["config", "--format", "json"]);
        if (result.code !== 0 || result.timedOut || result.truncated) return null;
        try {
            return projectMetadata(JSON.parse(result.stdout));
        } catch {
            return null;
        }
    }

    private runTarget(target: ComposeTarget, command: string[]): Promise<CommandResult> {
        const args = ["compose"];
        if (target.project) args.push("-p", target.project);
        if (target.envFile) args.push("--env-file", target.envFile);
        args.push("--project-directory", target.cwd, "-f", target.composeFile, ...command);
        return this.runner(args, { cwd: target.cwd, timeoutMs: target.timeoutMs, maxBytes: target.maxBytes, onChunk: target.onOutput });
    }

    pull(target: ComposeTarget): Promise<CommandResult> {
        // ADR 0022: services with a `build:` section are skipped, including
        // ones that also declare `image:`. Those are built by Up, not pulled.
        return this.runTarget(target, ["pull", "--ignore-buildable"]);
    }

    up(target: ComposeTarget): Promise<CommandResult> {
        // Scoped (ADR 0021): normal Up semantics for one service, without
        // starting its dependencies. Compose may still pull or build.
        if (target.service !== undefined && !isComposeServiceName(target.service)) {
            return Promise.reject(new Error("Invalid service name."));
        }
        const command = target.service === undefined ? ["up", "-d"] : ["up", "-d", "--no-deps", "--", target.service];
        return this.runTarget(target, command);
    }

    stop(target: ComposeTarget): Promise<CommandResult> {
        return this.runTarget(target, ["stop"]);
    }

    start(target: ComposeTarget): Promise<CommandResult> {
        return this.runTarget(target, ["start"]);
    }

    restart(target: ComposeTarget): Promise<CommandResult> {
        // Scoped (ADR 0021): `--no-deps` so dependents are not restarted.
        if (target.service !== undefined && !isComposeServiceName(target.service)) {
            return Promise.reject(new Error("Invalid service name."));
        }
        const command = target.service === undefined ? ["restart"] : ["restart", "--no-deps", "--", target.service];
        return this.runTarget(target, command);
    }

    down(target: ComposeTarget): Promise<CommandResult> {
        return this.runTarget(target, ["down"]);
    }

    private projectArgs(input: ComposeProjectFiles): string[] {
        const args = ["compose", "-p", input.project];
        for (const envFile of input.envFiles) args.push("--env-file", envFile);
        args.push("--project-directory", input.cwd);
        for (const file of input.composeFiles) args.push("-f", file);
        return args;
    }

    async serviceImage(input: ComposeProjectFiles & { service: string }): Promise<string | null> {
        if (!this.caps.operations.config) throw new ComposeUnsupportedError("config");
        const result = await this.runner([...this.projectArgs(input), "config", "--format", "json"], { cwd: input.cwd });
        if (result.code !== 0 || result.timedOut || result.truncated) return null;
        try {
            const value = JSON.parse(result.stdout) as { services?: Record<string, { image?: unknown }> } | null;
            const image = value?.services?.[input.service]?.image;
            return typeof image === "string" ? image : null;
        } catch {
            // Config and stderr may contain secrets; expose neither.
            return null;
        }
    }

    recreateService(
        input: ComposeProjectFiles & { service: string; timeoutMs?: number; onOutput?: (chunk: string) => void },
    ): Promise<CommandResult> {
        // `--` ends option parsing: the service name can never be read as a flag.
        return this.runner([...this.projectArgs(input), "up", "-d", "--no-deps", "--no-build", "--pull", "never", "--", input.service], {
            cwd: input.cwd,
            timeoutMs: input.timeoutMs,
            onChunk: input.onOutput,
        });
    }

    readLogs(target: ComposeTarget & { tailLines?: number }): Promise<CommandResult> {
        if (!this.caps.operations.logs) return Promise.reject(new ComposeUnsupportedError("logs"));
        if (target.service !== undefined && !isComposeServiceName(target.service)) {
            return Promise.reject(new Error("Invalid service name."));
        }
        const tail = sanitizeComposeTailLines(target.tailLines);
        const args = ["compose"];
        if (target.project) args.push("-p", target.project);
        if (target.envFile) args.push("--env-file", target.envFile);
        args.push(
            "--project-directory",
            target.cwd,
            "-f",
            target.composeFile,
            "logs",
            "--tail",
            String(tail),
            "--timestamps",
            "--no-color",
        );
        // `--` ends option parsing: a validated service name can never be read
        // as a flag. Verified against the embedded Compose in the lab suite.
        if (target.service !== undefined) args.push("--", target.service);
        // A bounded short read: the runner's timeout and output cap apply.
        return this.runner(args, { cwd: target.cwd, timeoutMs: target.timeoutMs, maxBytes: target.maxBytes });
    }

    async listServices(target: ComposeTarget): Promise<string[] | null> {
        if (!this.caps.operations.config) throw new ComposeUnsupportedError("config");
        const args = ["compose"];
        if (target.project) args.push("-p", target.project);
        if (target.envFile) args.push("--env-file", target.envFile);
        args.push("--project-directory", target.cwd, "-f", target.composeFile, "config", "--services");
        const result = await this.runner(args, { cwd: target.cwd });
        if (result.code !== 0 || result.timedOut || result.truncated) return null;
        const names = result.stdout
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean);
        // Refuse a partial or surprising list instead of validating against it.
        if (!names.every(isComposeServiceName)) return null;
        return [...new Set(names)];
    }

    async followLogs(
        target: ComposeTarget & { tailLines?: number },
        onChunk: (chunk: string) => void,
        signal: AbortSignal,
    ): Promise<{ code: number; timedOut: boolean; terminationUnconfirmed?: boolean }> {
        if (!this.caps.operations.logs) throw new ComposeUnsupportedError("logs");
        if (target.service !== undefined && !isComposeServiceName(target.service)) {
            throw new Error("Invalid service name.");
        }
        const tail = sanitizeComposeTailLines(target.tailLines);
        const args = ["compose"];
        if (target.project) args.push("-p", target.project);
        if (target.envFile) args.push("--env-file", target.envFile);
        args.push("--project-directory", target.cwd, "-f", target.composeFile, "logs", "--follow", "--tail", String(tail), "--timestamps");
        if (target.service !== undefined) args.push("--", target.service);
        // LogManager owns the follow timeout; the runner owns bounded abort,
        // signal escalation, pipe cleanup and stateful UTF-8 decoding.
        const result = await runCommand(this.dockerPath, args, {
            cwd: target.cwd,
            timeoutMs: 0,
            maxBytes: 0,
            signal,
            onChunk,
        });
        return { code: result.code, timedOut: result.timedOut, terminationUnconfirmed: result.terminationUnconfirmed };
    }
}

const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const IMAGE_REFERENCE = /^[a-z0-9][a-z0-9._/:@-]{0,254}$/i;
const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;

/** Choices offered for stack log history. Anything else falls back to configuration. */
export const COMPOSE_LOG_TAIL_OPTIONS = [100, 200, 500, 1000] as const;

/** A Compose service name: never empty, never an option flag, no path characters. */
export function isComposeServiceName(value: string): boolean {
    return /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,128}$/.test(value);
}

const COMPOSE_LOG_TAIL_DEFAULT = 200;
/**
 * Upper bound for `compose logs --tail`. The value comes from operator
 * configuration, but the provider never passes an absurd line count to Docker:
 * history reads stay bounded even with a misconfigured value.
 */
const COMPOSE_LOG_TAIL_MAX = 5000;

function sanitizeComposeTailLines(value: number | undefined): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return COMPOSE_LOG_TAIL_DEFAULT;
    return Math.min(Math.max(Math.floor(value), 1), COMPOSE_LOG_TAIL_MAX);
}

/** Docker's own container name grammar (`[a-zA-Z0-9][a-zA-Z0-9_.-]+`), bounded. */
export function isContainerName(value: string): boolean {
    return CONTAINER_NAME.test(value);
}

/** An image ID, or a reference like `registry:5000/ns/name:tag@sha256:…`. */
export function isImageReference(value: string): boolean {
    return IMAGE_ID.test(value) || (IMAGE_REFERENCE.test(value) && !value.includes(".."));
}

/**
 * `compose version --short` (e.g. "5.6.0", "v2.39.4", "2.40.3-desktop.1") is
 * at least 5.5.0, the first release whose `config --hash` merges `env_file:`
 * into the environment before hashing, like container creation does.
 * Unparsable output counts as unsupported.
 */
export function hashesResolveEnvironment(version: string): boolean {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]*)?$/.exec(version.trim());
    if (!match) return false;
    const [major, minor] = [Number(match[1]), Number(match[2])];
    return major > 5 || (major === 5 && minor >= 5);
}

/**
 * `<service> <sha256 hex>` lines from `config --hash`. Any other non-empty
 * line makes the whole answer unusable: nothing else is ever kept or shown.
 */
export function parseConfigHashes(stdout: string): Map<string, string> | null {
    const hashes = new Map<string, string>();
    for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        const match = /^(\S+) ([0-9a-f]{64})$/.exec(line.trim());
        if (!match || !isComposeServiceName(match[1]!) || hashes.has(match[1]!)) return null;
        hashes.set(match[1]!, match[2]!);
    }
    return hashes;
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
