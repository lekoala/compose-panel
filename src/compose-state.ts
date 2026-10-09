import { posix } from "node:path";

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
        });
    }
    return services;
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
