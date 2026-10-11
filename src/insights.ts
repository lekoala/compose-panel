import type { CommandResult } from "./docker.ts";
import type { ClassifiedContainer } from "./container-state.ts";
import type { ContainerInspector, InspectorReadOptions } from "./containers.ts";

/**
 * A Docker diagnostics response could not be understood. It is a distinct,
 * expected failure (never a programming error) so a caller can degrade to
 * "unavailable" instead of surfacing a 500.
 */
export class InsightsParseError extends Error {
    constructor(message = "Unexpected docker diagnostics output.") {
        super(message);
        this.name = "InsightsParseError";
    }
}

/** Fixed, non-reflected messages for the three expected failure modes. */
export const INSIGHTS_UNAVAILABLE = "Docker did not answer the diagnostics request, so some information is unavailable.";
export const INSIGHTS_SLOW = "Docker did not answer the diagnostics request in time, so some information is unavailable.";
export const INSIGHTS_INVALID = "Docker returned an unexpected diagnostics response, so some information is unavailable.";

/** Static facts about the machine running the daemon. Never the raw Info object. */
export interface EngineInfo {
    operatingSystem: string | null;
    osType: string | null;
    architecture: string | null;
    kernelVersion: string | null;
    engineVersion: string | null;
    cpus: number | null;
    memoryTotalBytes: number | null;
    containers: number | null;
    containersRunning: number | null;
    containersPaused: number | null;
    containersStopped: number | null;
    images: number | null;
    driver: string | null;
}

export interface DiskUsageRow {
    type: string;
    totalCount: number | null;
    active: number | null;
    /** Docker's formatted size, e.g. "2.631GB". */
    size: string;
    sizeBytes: number | null;
    /** Docker's formatted reclaimable value, e.g. "2.498GB (94%)". */
    reclaimable: string;
    reclaimableBytes: number | null;
}

export interface ContainerStat {
    id: string;
    name: string;
    cpuPercent: number | null;
    memUsedBytes: number | null;
    memLimitBytes: number | null;
    memPercent: number | null;
    /** Cumulative counters as printed by `docker stats` (not a rate). */
    netIo: string;
    blockIo: string;
    pids: number | null;
}

/** A stat joined with the container classification; `container` is null on a race. */
export interface ClassifiedStat extends ContainerStat {
    container: ClassifiedContainer | null;
}

/**
 * Cumulative usage of a managed stack's running containers. CPU may exceed 100
 * (Docker's scale is per core); memory is summed in bytes. Network and block I/O
 * are intentionally not aggregated.
 */
export interface StackUsage {
    stack: string;
    cpuPercent: number;
    memUsedBytes: number;
    containers: number;
}

export type AttentionReason = "unhealthy" | "restarting" | "exited-nonzero";

export interface AttentionItem {
    id: string;
    name: string;
    reason: AttentionReason;
    stack: string | null;
}

export interface Insights {
    /** null = not obtained (distinct from an empty result). */
    info: EngineInfo | null;
    /** null = not obtained; [] = Docker reported no running containers. */
    stats: ClassifiedStat[] | null;
    /** null = could not attribute (no container list); [] = no managed running container. */
    stacks: StackUsage[] | null;
    /** null = could not verify; [] = nothing to report. */
    attention: AttentionItem[] | null;
    notes: string[];
    readAt: number;
}

export interface DiskUsage {
    /** null = not obtained. Read on demand only. */
    rows: DiskUsageRow[] | null;
    readAt: number | null;
    note: string | null;
}

export interface DiskUsageCache {
    /** Return the cached result while fresh, else read again (never on a live refresh). */
    read(inspector: ContainerInspector, now: number, ttlMs: number, options?: InspectorReadOptions): Promise<DiskUsage>;
}

// ---- Parsing helpers --------------------------------------------------------

const UNITS: Record<string, number> = {
    b: 1,
    kb: 1000, mb: 1000 ** 2, gb: 1000 ** 3, tb: 1000 ** 4, pb: 1000 ** 5,
    kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4, pib: 1024 ** 5,
};

/**
 * Parse one of Docker's human sizes. Handles decimal (`kB`, `MB`, `GB`) and
 * binary (`KiB`, `MiB`, `GiB`) units, and returns null for an unknown value.
 */
export function parseHumanBytes(value: string): number | null {
    if (typeof value !== "string") return null;
    const match = /^\s*(-?\d+(?:\.\d+)?)\s*([a-z]+)\s*$/i.exec(value.trim());
    if (!match) return null;
    const amount = Number(match[1]);
    const factor = UNITS[match[2]!.toLowerCase()];
    if (!Number.isFinite(amount) || factor === undefined) return null;
    return Math.round(amount * factor);
}

/** Parse a `docker stats` percentage cell, e.g. "12.34%". */
export function parsePercent(value: string): number | null {
    if (typeof value !== "string") return null;
    const match = /^\s*(-?\d+(?:\.\d+)?)\s*%?\s*$/.exec(value);
    if (!match) return null;
    const amount = Number(match[1]);
    return Number.isFinite(amount) ? amount : null;
}

function asText(value: unknown): string | null {
    return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function asInt(value: unknown): number | null {
    if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : null;
    if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
    return null;
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

/** Parse one JSON object per line; blank lines are skipped. */
function parseLines(stdout: string): unknown[] {
    const values: unknown[] = [];
    for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
            values.push(JSON.parse(line));
        } catch {
            throw new InsightsParseError();
        }
    }
    return values;
}

/** "1.5MiB / 7.7GiB" -> [bytes, bytes]; a single value leaves the limit null. */
function parseMemoryUsage(value: unknown): { used: number | null; limit: number | null } {
    const text = asText(value);
    if (!text) return { used: null, limit: null };
    const [used, limit] = text.split("/").map(part => part.trim());
    return { used: parseHumanBytes(used ?? ""), limit: parseHumanBytes(limit ?? "") };
}

// ---- Parsers ----------------------------------------------------------------

export function parseDockerStats(stdout: string): ContainerStat[] {
    return parseLines(stdout).map(value => {
        const row = asRecord(value);
        const id = asText(row.ID);
        if (!id) throw new InsightsParseError();
        const memory = parseMemoryUsage(row.MemUsage);
        return {
            id,
            name: asText(row.Container) ?? asText(row.Name) ?? id.slice(0, 12),
            cpuPercent: parsePercent(String(row.CPUPerc ?? "")),
            memUsedBytes: memory.used,
            memLimitBytes: memory.limit,
            memPercent: parsePercent(String(row.MemPerc ?? "")),
            netIo: asText(row.NetIO) ?? "",
            blockIo: asText(row.BlockIO) ?? "",
            pids: asInt(row.PIDs),
        };
    });
}

export function parseSystemDf(stdout: string): DiskUsageRow[] {
    return parseLines(stdout).map(value => {
        const row = asRecord(value);
        const type = asText(row.Type);
        if (!type) throw new InsightsParseError();
        const size = asText(row.Size) ?? "";
        const reclaimable = asText(row.Reclaimable) ?? "";
        return {
            type,
            totalCount: asInt(row.TotalCount),
            active: asInt(row.Active),
            size,
            sizeBytes: parseHumanBytes(size),
            reclaimable,
            // "2.498GB (94%)" -> parse the byte part only.
            reclaimableBytes: parseHumanBytes(reclaimable.split(" (")[0] ?? ""),
        };
    });
}

/**
 * Project `docker info` onto the whitelisted fields. The raw object may carry
 * registry, proxy and environment configuration and is never returned, logged
 * or retained (ADR 0015).
 */
export function parseDockerInfo(stdout: string): EngineInfo {
    const raw = stdout.trim();
    if (!raw) throw new InsightsParseError();
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new InsightsParseError();
    }
    const info = asRecord(parsed);
    return {
        operatingSystem: asText(info.OperatingSystem),
        osType: asText(info.OSType),
        architecture: asText(info.Architecture),
        kernelVersion: asText(info.KernelVersion),
        engineVersion: asText(info.ServerVersion),
        cpus: asInt(info.NCPU),
        memoryTotalBytes: asInt(info.MemTotal),
        containers: asInt(info.Containers),
        containersRunning: asInt(info.ContainersRunning),
        containersPaused: asInt(info.ContainersPaused),
        containersStopped: asInt(info.ContainersStopped),
        images: asInt(info.Images),
        driver: asText(info.Driver),
    };
}

// ---- Builders ---------------------------------------------------------------

/** Derive an exited container's exit code from the `docker ps` status text. */
export function exitCodeFromStatus(status: string): number | null {
    const match = /Exited \((-?\d+)\)/.exec(status);
    return match ? Number(match[1]) : null;
}

/**
 * Current-state attention only; there is no history. A non-zero exit is a
 * mention, not a critical alert: a one-shot job may fail harmlessly.
 */
export function buildAttention(containers: ClassifiedContainer[]): AttentionItem[] {
    const items: AttentionItem[] = [];
    for (const container of containers) {
        const state = container.state.toLowerCase();
        const health = (container.health ?? "").toLowerCase();
        if (health === "unhealthy") {
            items.push({ id: container.id, name: container.name, reason: "unhealthy", stack: container.stack });
        } else if (state === "restarting") {
            items.push({ id: container.id, name: container.name, reason: "restarting", stack: container.stack });
        } else if (state === "exited") {
            const code = exitCodeFromStatus(container.status);
            if (code !== null && code !== 0) {
                items.push({ id: container.id, name: container.name, reason: "exited-nonzero", stack: container.stack });
            }
        }
    }
    return items;
}

/** Join each stat with its classification, by full container ID. */
export function attachStats(containers: ClassifiedContainer[] | null, stats: ContainerStat[]): ClassifiedStat[] {
    const byId = new Map<string, ClassifiedContainer>();
    for (const container of containers ?? []) byId.set(container.id, container);
    return stats.map(stat => ({ ...stat, container: byId.get(stat.id) ?? null }));
}

/**
 * Aggregate running-container usage per managed stack. A stat that is not a
 * Managed container (external, standalone, or unmatched) contributes to no
 * stack. Returns null when the container list was unavailable, since usage
 * could not be attributed.
 */
export function buildStacks(containers: ClassifiedContainer[] | null, stats: ContainerStat[]): StackUsage[] | null {
    if (containers === null) return null;
    const byId = new Map(containers.map(container => [container.id, container]));
    const totals = new Map<string, StackUsage>();
    for (const stat of stats) {
        const container = byId.get(stat.id);
        if (!container || container.category !== "managed" || !container.stack) continue;
        let entry = totals.get(container.stack);
        if (!entry) {
            entry = { stack: container.stack, cpuPercent: 0, memUsedBytes: 0, containers: 0 };
            totals.set(container.stack, entry);
        }
        entry.cpuPercent += stat.cpuPercent ?? 0;
        entry.memUsedBytes += stat.memUsedBytes ?? 0;
        entry.containers += 1;
    }
    return [...totals.values()].sort((a, b) => b.cpuPercent - a.cpuPercent || b.memUsedBytes - a.memUsedBytes);
}

// ---- Loaders ----------------------------------------------------------------

function pushNote(notes: string[], note: string): void {
    if (!notes.includes(note)) notes.push(note);
}

/**
 * Run one bounded inspector read. Only expected operational failures are turned
 * into a note; the result is null so a caller keeps whatever else succeeded.
 */
async function readInspector(
    call: (options?: InspectorReadOptions) => Promise<CommandResult>,
    options: InspectorReadOptions | undefined,
    notes: string[],
): Promise<CommandResult | null> {
    let result: CommandResult;
    try {
        result = await call(options);
    } catch {
        pushNote(notes, INSIGHTS_UNAVAILABLE);
        return null;
    }
    if (result.timedOut) {
        pushNote(notes, INSIGHTS_SLOW);
        return null;
    }
    if (result.code !== 0 || result.truncated) {
        pushNote(notes, INSIGHTS_UNAVAILABLE);
        return null;
    }
    return result;
}

/**
 * Read engine info and container stats in parallel and build the insights. Each
 * collection is independent: a failure yields null for that section and a note,
 * never a thrown error and never a fabricated zero. `containers` is the
 * classification from ADR 0014, or null when the container list could not be
 * read. A programming error is not swallowed.
 */
export async function loadInsights(
    inspector: ContainerInspector,
    containers: ClassifiedContainer[] | null,
    options: InspectorReadOptions = {},
): Promise<Insights> {
    const notes: string[] = [];
    const [infoResult, statsResult] = await Promise.all([
        readInspector(opts => inspector.info(opts), options, notes),
        readInspector(opts => inspector.stats(opts), options, notes),
    ]);

    let info: EngineInfo | null = null;
    if (infoResult) {
        try {
            info = parseDockerInfo(infoResult.stdout);
        } catch (error) {
            if (error instanceof InsightsParseError) pushNote(notes, INSIGHTS_INVALID);
            else throw error;
        }
    }

    let stats: ClassifiedStat[] | null = null;
    let stacks: StackUsage[] | null = null;
    if (statsResult) {
        try {
            const parsed = parseDockerStats(statsResult.stdout);
            stats = attachStats(containers, parsed);
            stacks = buildStacks(containers, parsed);
        } catch (error) {
            if (error instanceof InsightsParseError) pushNote(notes, INSIGHTS_INVALID);
            else throw error;
        }
    }

    const attention = containers === null ? null : buildAttention(containers);
    return { info, stats, stacks, attention, notes, readAt: Date.now() };
}

/**
 * Read Docker-managed disk usage on demand. This command can be expensive on a
 * large host, so it is never part of a normal page load (ADR 0015).
 */
export async function loadDiskUsage(inspector: ContainerInspector, options: InspectorReadOptions = {}): Promise<DiskUsage> {
    const notes: string[] = [];
    const result = await readInspector(opts => inspector.diskUsage(opts), options, notes);
    if (!result) return { rows: null, readAt: null, note: notes[0] ?? INSIGHTS_UNAVAILABLE };
    try {
        return { rows: parseSystemDf(result.stdout), readAt: Date.now(), note: null };
    } catch (error) {
        if (error instanceof InsightsParseError) return { rows: null, readAt: null, note: INSIGHTS_INVALID };
        throw error;
    }
}

/**
 * In-memory TTL cache for disk usage, so a reread within the window never hits
 * the daemon. A failure is not cached, so a later attempt can retry.
 */
export function createDiskUsageCache(): DiskUsageCache {
    let cached: DiskUsage | null = null;
    let cachedAt = 0;
    return {
        async read(inspector, now, ttlMs, options) {
            // Freshness uses the caller's clock so the TTL is deterministic; the
            // displayed `readAt` stays the real wall-clock time of the last read.
            if (cached && now - cachedAt < ttlMs) return cached;
            const fresh = await loadDiskUsage(inspector, options);
            if (fresh.rows !== null) {
                cached = fresh;
                cachedAt = now;
            }
            return fresh;
        },
    };
}
