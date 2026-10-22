import { posix } from "node:path";
import { isComposeServiceName } from "./compose-provider.ts";
import { asRecord, readComposeExtension, type ParseResult } from "./compose-extension.ts";

/**
 * The application toolbox (ADR 0026): a stack points, through the Compose
 * `x-compose-panel.toolbox.sources` extension, at services whose non-interactive
 * application actions are declared in each project's own manifest
 * (`extra["compose-panel"]` in `composer.json`, `"compose-panel"` in
 * `package.json`). The extension only says where to run; the manifest says what
 * may run. This module is pure (parsing, validation, catalog, revision, argv):
 * no Docker, no filesystem.
 */
export const TOOLBOX_RUNNERS = ["composer", "npm", "bun"] as const;
export type ToolboxRunner = (typeof TOOLBOX_RUNNERS)[number];

export const TOOLBOX_SCHEMA_VERSION = 1;

const SOURCE_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
/** Docker `exec -u` user: `name`, `uid`, `name:group` or `uid:gid`; never option-like. */
const TOOLBOX_USER = /^(?!-)[A-Za-z0-9_.-]{1,32}(?::(?!-)[A-Za-z0-9_.-]{1,32})?$/;
/** Composer/npm script names, plus ":" namespaces. Never option-like. */
const ACTION_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

const MAX_LABEL = 200;
const MAX_GROUP = 80;
const MAX_CONFIRMATION = 500;
const MAX_PATH = 4096;
/** Upper bounds for the stack-side source list. */
const MAX_SOURCES = 32;

export interface ToolboxSource {
    id: string;
    service: string;
    runner: ToolboxRunner;
    /** Absolute path inside the container, or null for the container default. */
    workdir: string | null;
    user: string | null;
    /** Manifest filename implied by the runner. */
    manifestFile: "composer.json" | "package.json";
}

export interface ToolboxAction {
    name: string;
    label: string;
    group: string | null;
    confirmation: string | null;
    /** Effective timeout cap in ms, or null for the manager default. */
    timeoutMs: number | null;
}

export interface ToolboxCatalog {
    source: ToolboxSource;
    actions: ToolboxAction[];
    /** Hash of the container, image, execution context and script definitions. */
    revision: string;
}

export interface ToolboxLimits {
    maxActions: number;
    maxTimeoutMs: number;
}

export function isToolboxRunner(value: string): value is ToolboxRunner {
    return (TOOLBOX_RUNNERS as readonly string[]).includes(value);
}

/** Composer/npm script names may contain ":"; anything option-like is refused. */
export function isActionName(value: string): boolean {
    return ACTION_NAME.test(value) && !value.startsWith("-");
}

export function manifestFileFor(runner: ToolboxRunner): "composer.json" | "package.json" {
    return runner === "composer" ? "composer.json" : "package.json";
}

/** The fixed argv the runner is launched with inside the container. */
export function buildRunnerArgv(runner: ToolboxRunner, name: string): string[] {
    switch (runner) {
        // `--no-interaction` is a Composer global option (before the command),
        // so the action never waits on a prompt such as "Continue as root?".
        case "composer":
            return ["composer", "--no-interaction", "run-script", name];
        case "npm":
            return ["npm", "run", name];
        case "bun":
            return ["bun", "run", name];
    }
}

/** A container-internal absolute path without ".." segments or NUL bytes. */
export function isSafeContainerPath(value: string): boolean {
    if (value.length === 0 || value.length > MAX_PATH || value.includes("\0")) return false;
    if (!posix.isAbsolute(value)) return false;
    return !value.split("/").includes("..");
}

/**
 * Read `x-compose-panel.toolbox.sources` from a raw Compose file. Compose
 * ignores `x-*` fields, so the extension never reaches the deployed project. No
 * sources declared is not an error: it simply means the stack offers no actions.
 */
export function parseToolboxSources(composeSource: string): ParseResult<ToolboxSource[]> {
    const extension = readComposeExtension(composeSource);
    if (!extension.ok) return extension;
    const toolbox = extension.value ? asRecord(extension.value["toolbox"]) : null;
    const raw = toolbox ? toolbox["sources"] : undefined;
    if (raw === undefined || raw === null) return { ok: true, value: [] };
    if (!Array.isArray(raw)) return { ok: false, error: "x-compose-panel.toolbox.sources must be a list." };
    if (raw.length > MAX_SOURCES) return { ok: false, error: `x-compose-panel.toolbox.sources lists more than ${MAX_SOURCES} sources.` };

    const sources: ToolboxSource[] = [];
    const seen = new Set<string>();
    for (const entry of raw) {
        const record = asRecord(entry);
        if (!record) return { ok: false, error: "Each toolbox source must be a mapping with id, service and runner." };

        const id = record["id"];
        if (typeof id !== "string" || !SOURCE_ID.test(id)) {
            return { ok: false, error: "A toolbox source id must be 1-32 characters of [a-z0-9_-], starting with a letter or digit." };
        }
        if (seen.has(id)) return { ok: false, error: `Toolbox source id "${id}" is listed twice.` };
        seen.add(id);

        const service = record["service"];
        if (typeof service !== "string" || !isComposeServiceName(service)) {
            return { ok: false, error: `Toolbox source "${id}" has no valid service name.` };
        }

        const runner = record["runner"];
        if (typeof runner !== "string" || !isToolboxRunner(runner)) {
            return { ok: false, error: `Toolbox source "${id}" runner must be one of ${TOOLBOX_RUNNERS.join(", ")}.` };
        }

        const workdir = record["workdir"];
        if (workdir !== undefined && workdir !== null) {
            if (typeof workdir !== "string" || !isSafeContainerPath(workdir)) {
                return { ok: false, error: `Toolbox source "${id}" workdir must be an absolute path inside the container.` };
            }
        }

        const user = record["user"];
        if (user !== undefined && user !== null) {
            if (typeof user !== "string" || !TOOLBOX_USER.test(user)) {
                return { ok: false, error: `Toolbox source "${id}" user is not valid.` };
            }
        }

        sources.push({
            id,
            service,
            runner,
            workdir: typeof workdir === "string" ? workdir : null,
            user: typeof user === "string" ? user : null,
            manifestFile: manifestFileFor(runner),
        });
    }
    return { ok: true, value: sources };
}

interface Manifest {
    actions: Record<string, unknown>;
    scripts: Record<string, unknown>;
}

/**
 * Parse a project manifest and return its declared actions and scripts. The
 * whole document is only ever projected, never re-serialized or executed.
 */
export function parseManifest(raw: string, runner: ToolboxRunner): ParseResult<Manifest> {
    let document: unknown;
    try {
        document = JSON.parse(raw);
    } catch {
        return { ok: false, error: `The ${manifestFileFor(runner)} is not valid JSON.` };
    }
    const root = asRecord(document);
    if (!root) return { ok: false, error: `The ${manifestFileFor(runner)} is not a JSON object.` };

    const section = runner === "composer" ? asRecord(asRecord(root["extra"])?.["compose-panel"]) : asRecord(root["compose-panel"]);
    if (!section) return { ok: false, error: `No compose-panel actions are declared in this ${manifestFileFor(runner)}.` };
    if (section["version"] !== TOOLBOX_SCHEMA_VERSION) {
        return { ok: false, error: `Unsupported compose-panel schema version: expected ${TOOLBOX_SCHEMA_VERSION}.` };
    }
    const actions = asRecord(section["actions"]);
    if (!actions) return { ok: false, error: "compose-panel.actions must be a mapping of script names to metadata." };
    const scripts = asRecord(root["scripts"]) ?? {};
    return { ok: true, value: { actions, scripts } };
}

function stringField(value: unknown, max: number): ParseResult<string | null> {
    if (value === undefined || value === null) return { ok: true, value: null };
    if (typeof value !== "string" || value.length === 0 || value.length > max) {
        return { ok: false, error: `must be text of 1-${max} characters` };
    }
    return { ok: true, value };
}

/**
 * Intersect the declared actions with the project's scripts and produce the
 * displayable catalog. A declared action with no matching script is a
 * configuration error, never an executable button.
 */
export function buildCatalog(
    source: ToolboxSource,
    rawManifest: string,
    execution: { containerId: string; imageId: string },
    limits: ToolboxLimits,
): ParseResult<ToolboxCatalog> {
    const parsed = parseManifest(rawManifest, source.runner);
    if (!parsed.ok) return parsed;
    const { actions, scripts } = parsed.value;

    const names = Object.keys(actions).sort();
    if (names.length > limits.maxActions) {
        return { ok: false, error: `This manifest declares more than ${limits.maxActions} actions.` };
    }

    const catalogActions: ToolboxAction[] = [];
    for (const name of names) {
        if (!isActionName(name)) {
            return { ok: false, error: `Action "${name}" is not a valid script name.` };
        }
        if (!Object.hasOwn(scripts, name)) {
            return { ok: false, error: `Action "${name}" refers to a script this project does not define.` };
        }
        // The definition must be runnable by the runner: for npm/Bun a missing or
        // non-string value would make `bun run <name>` fall through to a file.
        if (!isUsableScript(source.runner, ownValue(scripts, name))) {
            return { ok: false, error: `Action "${name}" does not define a runnable ${source.runner} script.` };
        }
        const entry = asRecord(actions[name]);
        if (!entry) return { ok: false, error: `Action "${name}" must be a mapping of metadata.` };

        const label = stringField(entry["label"], MAX_LABEL);
        if (!label.ok) return { ok: false, error: `Action "${name}" label ${label.error}.` };
        const group = stringField(entry["group"], MAX_GROUP);
        if (!group.ok) return { ok: false, error: `Action "${name}" group ${group.error}.` };
        const confirmation = stringField(entry["confirmation"], MAX_CONFIRMATION);
        if (!confirmation.ok) return { ok: false, error: `Action "${name}" confirmation ${confirmation.error}.` };

        const timeoutMs = clampTimeout(entry["timeout"], limits.maxTimeoutMs);
        if (timeoutMs === "invalid") return { ok: false, error: `Action "${name}" timeout must be a positive number of seconds.` };

        catalogActions.push({
            name,
            label: label.value ?? name,
            group: group.value,
            confirmation: confirmation.value,
            timeoutMs: timeoutMs === null ? null : timeoutMs,
        });
    }

    return {
        ok: true,
        value: {
            source,
            actions: catalogActions,
            revision: computeRevision(source, catalogActions, scripts, execution),
        },
    };
}

/** Seconds in the manifest, clamped to [1s, cap]; null when not declared. */
function clampTimeout(value: unknown, maxMs: number): number | null | "invalid" {
    if (value === undefined || value === null) return null;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "invalid";
    const ms = Math.floor(value * 1000);
    return Math.min(Math.max(ms, 1000), maxMs);
}

/** Own-property read: inherited names (`constructor`, `toString`…) never count. */
function ownValue(source: Record<string, unknown>, key: string): unknown {
    return Object.hasOwn(source, key) ? source[key] : null;
}

/**
 * Whether a declared script is actually runnable by the runner. For Composer a
 * command string or an array of strings/callbacks is valid. For npm and Bun a
 * non-empty command string is required: `bun run <name>` resolves a file or
 * binary when the name has no usable `scripts` entry, which is never allowed.
 */
function isUsableScript(runner: ToolboxRunner, value: unknown): boolean {
    if (runner === "composer") {
        if (typeof value === "string") return value.trim() !== "";
        return Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === "string");
    }
    return typeof value === "string" && value.trim() !== "";
}

/**
 * Detects a change between display and launch. It covers the pinned container
 * and image, the execution context and every script definition in the manifest
 * (not only the referenced actions), so a Composer `@other` reference, a
 * `pre*`/`post*` hook or any volume-mounted edit that leaves
 * `extra.compose-panel` untouched still yields a different revision. It is not a
 * signature and does not guarantee the immutability of the executed code.
 */
function computeRevision(
    source: ToolboxSource,
    actions: ToolboxAction[],
    scripts: Record<string, unknown>,
    execution: { containerId: string; imageId: string },
): string {
    const material = {
        container: execution.containerId,
        image: execution.imageId,
        source: { id: source.id, service: source.service, runner: source.runner, workdir: source.workdir, user: source.user },
        actions: [...actions]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((action) => ({
                name: action.name,
                label: action.label,
                group: action.group,
                confirmation: action.confirmation,
                timeoutMs: action.timeoutMs,
            })),
        // The whole script map, order-stable: a referenced definition counts too.
        scripts: Object.keys(scripts)
            .sort()
            .map((key) => [key, ownValue(scripts, key)]),
    };
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(JSON.stringify(material));
    return hasher.digest("hex");
}
