import { posix } from "node:path";
import { isImageReference } from "./compose-provider.ts";

export class ComposeStateError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ComposeStateError";
    }
}

export interface ComposeProject {
    name: string;
    status: string;
    configFiles: string[];
}

export interface ComposeService {
    name: string;
    state: string;
    health: string | null;
    exitCode: number | null;
    /** Container name, used to match `compose images` rows. */
    container: string | null;
    /** Image reference as configured (e.g. "nginx:1.27-alpine"). */
    image: string | null;
}

/** One `compose images` row: which image ID a container actually runs. */
export interface ContainerImage {
    container: string;
    imageId: string;
}

/** The parts of `docker image inspect` the panel uses. Labels are untrusted text. */
export interface ImageDetails {
    id: string;
    repoTags: string[];
    repoDigests: string[];
    created: string | null;
    labels: Record<string, string>;
}

/** Honest status vocabulary. "unknown" is never silently turned into "stopped". */
export type StackState = "running" | "stopped" | "not-created" | "unknown";

/**
 * Docker Compose has shipped both a JSON array and JSON-lines for `--format json`,
 * so accept both and reject anything else.
 */
function parseJsonRows(stdout: string): unknown[] {
    const text = stdout.trim();
    if (!text) return [];
    try {
        const parsed: unknown = JSON.parse(text);
        if (Array.isArray(parsed)) return parsed;
        if (parsed && typeof parsed === "object") return [parsed];
    } catch {
        // Fall through to JSON lines.
    }
    const rows: unknown[] = [];
    for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            rows.push(JSON.parse(trimmed));
        } catch {
            throw new ComposeStateError("Unexpected JSON output from Docker Compose.");
        }
    }
    return rows;
}

export function parseComposeLs(stdout: string): ComposeProject[] {
    const projects: ComposeProject[] = [];
    for (const row of parseJsonRows(stdout)) {
        if (!row || typeof row !== "object") throw new ComposeStateError("Unexpected compose ls output.");
        const record = row as Record<string, unknown>;
        const name = record.Name;
        if (typeof name !== "string" || !name) throw new ComposeStateError("Unexpected compose ls output.");
        const configFiles = typeof record.ConfigFiles === "string" && record.ConfigFiles
            ? record.ConfigFiles.split(",").map(value => value.trim()).filter(Boolean)
            : [];
        projects.push({
            name,
            status: typeof record.Status === "string" ? record.Status : "",
            configFiles,
        });
    }
    return projects;
}

export function parseComposePs(stdout: string): ComposeService[] {
    const services: ComposeService[] = [];
    for (const row of parseJsonRows(stdout)) {
        if (!row || typeof row !== "object") throw new ComposeStateError("Unexpected compose ps output.");
        const record = row as Record<string, unknown>;
        const name = typeof record.Service === "string" && record.Service
            ? record.Service
            : typeof record.Name === "string" ? record.Name : "";
        if (!name) throw new ComposeStateError("Unexpected compose ps output.");
        services.push({
            name,
            state: typeof record.State === "string" ? record.State : "unknown",
            health: typeof record.Health === "string" && record.Health ? record.Health : null,
            exitCode: typeof record.ExitCode === "number" ? record.ExitCode : null,
            container: typeof record.Name === "string" && record.Name ? record.Name : null,
            image: typeof record.Image === "string" && record.Image ? record.Image : null,
        });
    }
    return services;
}

export function parseComposeImages(stdout: string): ContainerImage[] {
    const rows: ContainerImage[] = [];
    for (const row of parseJsonRows(stdout)) {
        if (!row || typeof row !== "object") throw new ComposeStateError("Unexpected compose images output.");
        const record = row as Record<string, unknown>;
        if (typeof record.ContainerName === "string" && typeof record.ID === "string" && record.ContainerName && record.ID) {
            rows.push({ container: record.ContainerName, imageId: record.ID });
        }
    }
    return rows;
}

function strings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function parseImageInspect(stdout: string): ImageDetails[] {
    const details: ImageDetails[] = [];
    for (const row of parseJsonRows(stdout)) {
        if (!row || typeof row !== "object") continue;
        const record = row as Record<string, unknown>;
        if (typeof record.Id !== "string" || !record.Id) continue;
        const config = record.Config && typeof record.Config === "object" ? record.Config as Record<string, unknown> : {};
        const labels: Record<string, string> = {};
        if (config.Labels && typeof config.Labels === "object") {
            for (const [key, value] of Object.entries(config.Labels as Record<string, unknown>)) {
                if (typeof value === "string") labels[key] = value;
            }
        }
        details.push({
            id: record.Id,
            repoTags: strings(record.RepoTags),
            repoDigests: strings(record.RepoDigests),
            created: typeof record.Created === "string" ? record.Created : null,
            labels,
        });
    }
    return details;
}

/** What a container still knows about an image that is gone. */
export interface RecoveredImage {
    detail: ImageDetails;
    /** The configured image reference (`Config.Image`), when it looks like one. */
    reference: string | null;
}

/**
 * Image details recovered from `container inspect` when the image itself is
 * gone: the container keeps its image ID, its configured reference and the
 * labels it inherited from the image. Only `org.opencontainers.image.*` labels
 * are kept; there is no repository digest or creation date to recover.
 */
export function parseContainerImages(stdout: string): Map<string, RecoveredImage> {
    const byContainer = new Map<string, RecoveredImage>();
    for (const row of parseJsonRows(stdout)) {
        if (!row || typeof row !== "object") continue;
        const record = row as Record<string, unknown>;
        if (typeof record.Name !== "string" || typeof record.Image !== "string" || !record.Image) continue;
        const config = record.Config && typeof record.Config === "object" ? record.Config as Record<string, unknown> : {};
        const labels: Record<string, string> = {};
        if (config.Labels && typeof config.Labels === "object") {
            for (const [key, value] of Object.entries(config.Labels as Record<string, unknown>)) {
                if (key.startsWith("org.opencontainers.image.") && typeof value === "string") labels[key] = value;
            }
        }
        const reference = typeof config.Image === "string" && isImageReference(config.Image) ? config.Image : null;
        byContainer.set(record.Name.replace(/^\//, ""), {
            detail: { id: record.Image, repoTags: [], repoDigests: [], created: null, labels },
            reference,
        });
    }
    return byContainer;
}

export function summarizeServices(services: ComposeService[]): StackState {
    if (services.length === 0) return "not-created";
    const states = services.map(service => service.state.toLowerCase());
    // A one-shot init service that exited 0 must not hide a running application.
    if (states.some(state => state === "running" || state === "restarting" || state === "paused")) return "running";
    if (states.every(state => state === "exited" || state === "created" || state === "dead" || state === "removing")) return "stopped";
    return "unknown";
}

export function summarizeProjectStatus(status: string): StackState {
    const value = status.toLowerCase();
    if (!value) return "unknown";
    if (value.includes("running") || value.includes("restarting")) return "running";
    if (value.includes("exited") || value.includes("created") || value.includes("dead")) return "stopped";
    return "unknown";
}

function normalizePath(value: string): string {
    return posix.normalize(value.replace(/\\/g, "/")).replace(/\/+$/, "");
}

export interface ProjectMatch {
    project: ComposeProject | null;
    ambiguous: boolean;
}

/**
 * Match a stack's Compose file to a Docker project without assuming the folder
 * name is the project name. Multiple matches, or a project spanning more files
 * than the stack defines, are ambiguous and must not be guessed.
 */
export function findProjectForStack(projects: ComposeProject[], stackFile: string): ProjectMatch {
    const target = normalizePath(stackFile);
    const matches = projects.filter(project => project.configFiles.some(file => normalizePath(file) === target));
    if (matches.length === 0) return { project: null, ambiguous: false };
    if (matches.length > 1) return { project: null, ambiguous: true };
    const project = matches[0]!;
    if (project.configFiles.length > 1) return { project: null, ambiguous: true };
    return { project, ambiguous: false };
}
