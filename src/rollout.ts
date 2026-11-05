import { posix } from "node:path";
import { containsControlCharacters } from "./text.ts";
import { isSafeContainerPath } from "./toolbox.ts";

/** Labels a service may declare under `panel.rollout.*`. */
export const ROLLOUT_LABEL_KEYS = [
    "panel.rollout.enabled",
    "panel.rollout.timeout",
    "panel.rollout.settle",
    "panel.rollout.drain-file",
    "panel.rollout.drain-detect",
    "panel.rollout.drain-time",
    "panel.rollout.stop-timeout",
] as const;

export const ROLLOUT_LIMITS = {
    timeout: { min: 1, max: 600, fallback: 120 },
    settle: { min: 0, max: 60, fallback: 5 },
    drainDetect: { min: 5, max: 300, fallback: 30 },
    drainTime: { min: 5, max: 300, fallback: 20 },
    stopTimeout: { min: 1, max: 300, fallback: 30 },
} as const;

/** The panel's own labels, projected from the resolved Compose config only. */
export interface RolloutLabels {
    enabled?: string;
    timeout?: string;
    settle?: string;
    drainFile?: string;
    drainDetect?: string;
    drainTime?: string;
    stopTimeout?: string;
}

/** Allow-listed facts about one service, derived from `config --format json`. */
export interface ServiceRolloutFacts {
    image: string | null;
    build: boolean;
    containerName: boolean;
    publishedPorts: boolean;
    /**
     * Declared replica counts (`deploy.replicas`, `scale`). A malformed value is
     * represented as `NaN` so eligibility refuses it instead of guessing.
     */
    replicas: number[];
    networkMode: string | null;
    ipc: string | null;
    pid: string | null;
    volumesFrom: string[];
    fixedAddresses: string[];
    labels: RolloutLabels;
    /** Other services that share this service's namespaces or volumes. */
    namespaceDependents: string[];
}

export interface RolloutDeclaration {
    enabled: true;
    timeoutSeconds: number;
    settleSeconds: number;
    drainFile: string | null;
    drainDetectSeconds: number;
    drainTimeSeconds: number;
    stopTimeoutSeconds: number;
}

export type RolloutRefusalCode =
    | "invalid-declaration"
    | "service-absent"
    | "build"
    | "container-name"
    | "published-ports"
    | "replicas"
    | "network-mode"
    | "shared-namespace"
    | "fixed-address"
    | "no-image"
    | "container-count"
    | "container-unknown"
    | "not-running"
    | "no-healthcheck"
    | "unhealthy"
    | "drain-contract"
    | "drain-mount";

export type RolloutDeclarationResult = { ok: true; value: RolloutDeclaration } | { ok: false; code: RolloutRefusalCode; reason: string };

export type RolloutEligibility = { ok: true; image: string } | { ok: false; code: RolloutRefusalCode; reason: string };

/** The whitelisted projection of `docker container inspect` used by a rollout. */
export interface RolloutInspect {
    /** Full 64-hex container ID. */
    id: string;
    status: string;
    running: boolean;
    health: string | null;
    /** `Config.Image`: the reference the container was created with. */
    imageRef: string | null;
    /** `Image`: the local image ID the container runs. */
    imageId: string | null;
    created: string | null;
    /** Only the four Compose identity labels and `panel.rollout.drain-file`. */
    labels: Record<string, string>;
    /** `Mounts[].Destination`, used to refuse a shared drain marker. */
    mountDestinations: string[];
}

const INSPECT_LABELS = [
    "com.docker.compose.project",
    "com.docker.compose.service",
    "com.docker.compose.project.config_files",
    "com.docker.compose.project.working_dir",
    "panel.rollout.drain-file",
] as const;

const FULL_CONTAINER_ID = /^[0-9a-f]{64}$/;
const CLOCK_TOLERANCE_MS = 1000;
const MAX_DRAIN_PATH = 200;

function asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | null {
    return typeof value === "string" && value.length > 0 ? value : null;
}

/** Project only the `panel.rollout.*` labels from a service's labels object. */
export function projectRolloutLabels(value: unknown): RolloutLabels {
    const labels = asRecord(value);
    if (!labels) return {};
    const result: RolloutLabels = {};
    for (const key of ROLLOUT_LABEL_KEYS) {
        const selected = labels[key];
        if (typeof selected === "string") {
            const field = key.slice("panel.rollout.".length);
            if (field === "enabled") result.enabled = selected;
            else if (field === "timeout") result.timeout = selected;
            else if (field === "settle") result.settle = selected;
            else if (field === "drain-file") result.drainFile = selected;
            else if (field === "drain-detect") result.drainDetect = selected;
            else if (field === "drain-time") result.drainTime = selected;
            else if (field === "stop-timeout") result.stopTimeout = selected;
        }
    }
    return result;
}

function parseSeconds(
    raw: string | undefined,
    field: string,
    limits: { min: number; max: number; fallback: number },
): { ok: true; value: number } | { ok: false; reason: string } {
    if (raw === undefined || raw.trim() === "") return { ok: true, value: limits.fallback };
    const value = raw.trim();
    if (!/^\d+$/.test(value)) return { ok: false, reason: `${field} must be a whole number of seconds.` };
    const parsed = Number(value);
    if (parsed < limits.min || parsed > limits.max) {
        return { ok: false, reason: `${field} must be between ${limits.min} and ${limits.max} seconds.` };
    }
    return { ok: true, value: parsed };
}

/**
 * Parse a service's rollout declaration. `null` means the service is not
 * declared for rollout (no `panel.rollout.*` label, or `enabled: "false"`).
 * A declaration that tries to enable rollout but is invalid is refused: values
 * are never clamped or silently defaulted when they are present and wrong.
 */
export function parseRolloutDeclaration(labels: RolloutLabels): RolloutDeclarationResult | null {
    const declared = Object.values(labels).some((value) => typeof value === "string" && value.trim() !== "");
    if (!declared) return null;
    const enabled = labels.enabled?.trim().toLowerCase();
    if (enabled === undefined || enabled === "" || enabled === "false") return null;
    if (enabled !== "true") {
        return { ok: false, code: "invalid-declaration", reason: 'panel.rollout.enabled must be exactly "true".' };
    }

    const timeout = parseSeconds(labels.timeout, "panel.rollout.timeout", ROLLOUT_LIMITS.timeout);
    if (!timeout.ok) return { ok: false, code: "invalid-declaration", reason: timeout.reason };
    const settle = parseSeconds(labels.settle, "panel.rollout.settle", ROLLOUT_LIMITS.settle);
    if (!settle.ok) return { ok: false, code: "invalid-declaration", reason: settle.reason };

    const rawDrainFile = labels.drainFile?.trim() ?? "";
    let drainFile: string | null = rawDrainFile === "" ? null : rawDrainFile;
    if (drainFile !== null) {
        if (drainFile.length > MAX_DRAIN_PATH || containsControlCharacters(drainFile) || !isSafeContainerPath(drainFile)) {
            return {
                ok: false,
                code: "invalid-declaration",
                reason: "panel.rollout.drain-file must be a short absolute container path without control characters or .. segments.",
            };
        }
    }

    const drainDetect = parseSeconds(labels.drainDetect, "panel.rollout.drain-detect", ROLLOUT_LIMITS.drainDetect);
    if (!drainDetect.ok) return { ok: false, code: "invalid-declaration", reason: drainDetect.reason };
    const drainTime = parseSeconds(labels.drainTime, "panel.rollout.drain-time", ROLLOUT_LIMITS.drainTime);
    if (!drainTime.ok) return { ok: false, code: "invalid-declaration", reason: drainTime.reason };
    const stopTimeout = parseSeconds(labels.stopTimeout, "panel.rollout.stop-timeout", ROLLOUT_LIMITS.stopTimeout);
    if (!stopTimeout.ok) return { ok: false, code: "invalid-declaration", reason: stopTimeout.reason };

    if (drainFile === null && (labels.drainDetect !== undefined || labels.drainTime !== undefined)) {
        return {
            ok: false,
            code: "invalid-declaration",
            reason: "panel.rollout.drain-detect and panel.rollout.drain-time require panel.rollout.drain-file.",
        };
    }

    return {
        ok: true,
        value: {
            enabled: true,
            timeoutSeconds: timeout.value,
            settleSeconds: settle.value,
            drainFile,
            drainDetectSeconds: drainDetect.value,
            drainTimeSeconds: drainTime.value,
            stopTimeoutSeconds: stopTimeout.value,
        },
    };
}

/**
 * Read the whitelisted fields of one `docker container inspect` answer.
 * Anything malformed returns `null`: callers must refuse, never guess.
 */
export function parseRolloutInspect(stdout: string): RolloutInspect | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(stdout);
    } catch {
        return null;
    }
    const record = asRecord(Array.isArray(parsed) ? parsed[0] : parsed);
    if (!record) return null;
    const id = text(record.Id);
    if (!id || !FULL_CONTAINER_ID.test(id)) return null;
    const state = asRecord(record.State);
    if (!state) return null;
    const config = asRecord(record.Config);
    const health = asRecord(state.Health);
    const labels: Record<string, string> = {};
    const rawLabels = asRecord(config?.Labels);
    if (rawLabels) {
        for (const key of INSPECT_LABELS) {
            const value = rawLabels[key];
            if (typeof value === "string") labels[key] = value;
        }
    }
    const mountDestinations: string[] = [];
    if (Array.isArray(record.Mounts)) {
        for (const mount of record.Mounts) {
            const entry = asRecord(mount);
            const destination = text(entry?.Destination);
            if (destination) mountDestinations.push(destination);
        }
    }
    return {
        id,
        status: typeof state.Status === "string" ? state.Status : "unknown",
        running: state.Running === true,
        health: typeof health?.Status === "string" ? health.Status : null,
        imageRef: text(config?.Image),
        imageId: text(record.Image),
        created: text(record.Created),
        labels,
        mountDestinations,
    };
}

function normalizeContainerPath(value: string): string {
    const normalized = posix.normalize(value.replace(/\\/g, "/"));
    return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

function mountCovers(destinations: string[], path: string): boolean {
    const target = normalizeContainerPath(path);
    return destinations.some((destination) => {
        const mount = normalizeContainerPath(destination);
        return mount === "/" || target === mount || target.startsWith(`${mount}/`);
    });
}

function sharedNamespace(value: string | null): boolean {
    if (!value) return false;
    return value === "host" || value === "__invalid__" || value.startsWith("service:") || value.startsWith("container:");
}

function unusableNetworkMode(value: string | null): boolean {
    if (!value) return false;
    return (
        value === "host" || value === "none" || value === "__invalid__" || value.startsWith("service:") || value.startsWith("container:")
    );
}

/**
 * Pure eligibility rules. Docker discovery, project resolution and the global
 * flag are the caller's job; every fact used here comes from an allow-listed
 * projection or from `container inspect`.
 */
export function checkRolloutEligibility(input: {
    facts: ServiceRolloutFacts;
    declaration: RolloutDeclaration;
    inspect: RolloutInspect | null;
    containerCount: number;
}): RolloutEligibility {
    const { facts, declaration, inspect, containerCount } = input;
    if (facts.build) {
        return { ok: false, code: "build", reason: "Services built from a Dockerfile are not eligible for rollout in this version." };
    }
    if (facts.containerName) {
        return { ok: false, code: "container-name", reason: "A fixed container_name prevents two instances from coexisting." };
    }
    if (facts.publishedPorts) {
        return { ok: false, code: "published-ports", reason: "Published ports cannot be duplicated across two instances." };
    }
    if (facts.replicas.some((value) => value !== 1)) {
        return { ok: false, code: "replicas", reason: "The service must declare at most one replica." };
    }
    if (unusableNetworkMode(facts.networkMode)) {
        return { ok: false, code: "network-mode", reason: "This network_mode is not compatible with two instances." };
    }
    if (sharedNamespace(facts.ipc) || sharedNamespace(facts.pid)) {
        return { ok: false, code: "shared-namespace", reason: "This service shares a namespace that cannot be duplicated." };
    }
    if (facts.volumesFrom.length > 0) {
        return { ok: false, code: "shared-namespace", reason: "volumes_from cannot be duplicated safely for a rollout." };
    }
    if (facts.namespaceDependents.length > 0) {
        return {
            ok: false,
            code: "shared-namespace",
            reason: "Another service shares this service's namespaces or volumes, so a second instance would conflict.",
        };
    }
    if (facts.fixedAddresses.length > 0) {
        return { ok: false, code: "fixed-address", reason: "A fixed network address cannot be used by two instances." };
    }
    if (!facts.image) {
        return { ok: false, code: "no-image", reason: "The service has no image reference." };
    }
    if (containerCount !== 1) {
        return {
            ok: false,
            code: "container-count",
            reason: "The service must have exactly one container, in any state, before a rollout.",
        };
    }
    if (!inspect) {
        return { ok: false, code: "container-unknown", reason: "The panel could not read this service's container from Docker." };
    }
    if (!inspect.running) {
        return { ok: false, code: "not-running", reason: "The service's container is not running." };
    }
    if (inspect.health === null) {
        return {
            ok: false,
            code: "no-healthcheck",
            reason: "The running container has no effective healthcheck. A rollout requires one.",
        };
    }
    if (inspect.health !== "healthy") {
        return { ok: false, code: "unhealthy", reason: "The service's container is not healthy. Resolve that before a rollout." };
    }
    if (declaration.drainFile !== null) {
        const declaredPath = inspect.labels["panel.rollout.drain-file"]?.trim() ?? null;
        if (declaredPath !== declaration.drainFile) {
            return {
                ok: false,
                code: "drain-contract",
                reason: "The running container was created without this drain marker. Run Up once, then retry the rollout.",
            };
        }
        if (mountCovers(inspect.mountDestinations, declaration.drainFile)) {
            return {
                ok: false,
                code: "drain-mount",
                reason: "The drain marker is on a mounted path. Two instances could share it and become unavailable together.",
            };
        }
    }
    return { ok: true, image: facts.image };
}

function normalizeHostPath(value: string): string {
    const normalized = posix.normalize(value.trim().replace(/\\/g, "/"));
    return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

function sameComposeFile(label: string | undefined, composeFile: string): boolean {
    if (!label) return false;
    const files = label
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
    return files.length === 1 && normalizeHostPath(files[0]!) === normalizeHostPath(composeFile);
}

/**
 * Whether a newly discovered container can be proven to be the candidate this
 * operation created. A simple ID difference is not enough: an external Compose
 * CLI could create a container during the same window. Every check must pass.
 */
export function verifiesCandidateIdentity(input: {
    inspect: RolloutInspect;
    project: string;
    service: string;
    composeFile: string;
    cwd: string;
    operationStartedAt: number;
    initialIds: readonly string[];
}): boolean {
    const { inspect } = input;
    if (input.initialIds.includes(inspect.id)) return false;
    if (inspect.labels["com.docker.compose.project"] !== input.project) return false;
    if (inspect.labels["com.docker.compose.service"] !== input.service) return false;
    if (!sameComposeFile(inspect.labels["com.docker.compose.project.config_files"], input.composeFile)) return false;
    const workingDir = inspect.labels["com.docker.compose.project.working_dir"];
    if (!workingDir || normalizeHostPath(workingDir) !== normalizeHostPath(input.cwd)) return false;
    const created = inspect.created === null ? Number.NaN : Date.parse(inspect.created);
    if (!Number.isFinite(created) || created < input.operationStartedAt - CLOCK_TOLERANCE_MS) return false;
    return true;
}
