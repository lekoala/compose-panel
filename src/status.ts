import { dirname, join } from "node:path";
import { listStacks, locateComposeFile, StackError, ENV_FILENAME } from "./stacks.ts";
import { readFileSafe } from "./fs-safe.ts";
import {
    ComposeProject,
    ComposeService,
    StackState,
    findProjectForStack,
    parseComposeLs,
    parseComposePs,
    summarizeProjectStatus,
    summarizeServices,
} from "./compose-state.ts";
import type { ComposeProvider } from "./compose-provider.ts";

const DOCKER_UNAVAILABLE = "Docker is not reachable, so statuses are shown as unknown. Check that the Docker daemon is running and its socket is available to the panel.";
const DOCKER_SLOW = "Docker did not respond in time, so statuses are shown as unknown. Reload the page to try again.";
const SEVERAL_PROJECTS = "Several Docker Compose projects point to this folder, so the panel cannot tell which one is this stack. Its status is unknown and actions are refused until only one remains.";
const MAX_ENV_BYTES = 1024 * 1024;

export interface StackStatus {
    name: string;
    composeFile: string;
    project: string | null;
    state: StackState;
    note: string | null;
}

export interface StackListStatus {
    stacks: StackStatus[];
    dockerNote: string | null;
}

export interface StackDetailStatus {
    project: string | null;
    state: StackState;
    note: string | null;
    services: ComposeService[];
}

async function loadProjects(provider: ComposeProvider): Promise<{ projects: ComposeProject[]; note: string | null }> {
    try {
        const result = await provider.listProjects();
        if (result.timedOut) return { projects: [], note: DOCKER_SLOW };
        if (result.code !== 0) return { projects: [], note: DOCKER_UNAVAILABLE };
        return { projects: parseComposeLs(result.stdout), note: null };
    } catch {
        return { projects: [], note: DOCKER_UNAVAILABLE };
    }
}

export async function loadStackStates(root: string, provider: ComposeProvider): Promise<StackListStatus> {
    let stacks: Awaited<ReturnType<typeof listStacks>>;
    try {
        stacks = await listStacks(root);
    } catch (error) {
        // A deleted or replaced STACKS_DIR at runtime is not an empty panel and
        // not a Docker problem: fail closed instead of a 500 with log spam.
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        if (code === "ENOENT" || code === "ENOTDIR") throw new StackError("The stacks folder is missing or cannot be read.", 503);
        throw error;
    }
    const { projects, note } = await loadProjects(provider);
    const result: StackStatus[] = [];

    for (const stack of stacks) {
        const base = { name: stack.name, composeFile: stack.composeFile };
        let location: { path: string; filename: string };
        try {
            location = await locateComposeFile(root, stack.name);
        } catch {
            result.push({ ...base, project: null, state: "unknown", note: "The Compose file could not be read." });
            continue;
        }
        if (note) {
            result.push({ ...base, project: null, state: "unknown", note });
            continue;
        }
        const match = findProjectForStack(projects, location.path);
        if (match.ambiguous) {
            result.push({ ...base, project: null, state: "unknown", note: SEVERAL_PROJECTS });
            continue;
        }
        if (!match.project) {
            result.push({ ...base, project: null, state: "not-created", note: null });
            continue;
        }
        result.push({ ...base, project: match.project.name, state: summarizeProjectStatus(match.project.status), note: null });
    }

    return { stacks: result, dockerNote: note };
}

export type ProjectContextKind = "resolved" | "absent" | "ambiguous" | "unavailable" | "invalid";

export interface ProjectContext {
    kind: ProjectContextKind;
    /** Deployed identity, or verified creation identity for an absent stack. */
    project: string | null;
    /** Absolute Compose file path, filename and directory for target building. */
    composeFile: string;
    filename: string;
    cwd: string;
    /**
     * Verified `.env` path when a safe regular file exists, else null. Passed
     * explicitly to Compose so an unsafe `.env` (symlink, non-regular, oversized)
     * cannot be read implicitly by a mutation or follow.
     */
    envFile: string | null;
}

/**
 * Resolve the verified project context for a mutation or follow. Unlike the
 * old nullable lookup, ambiguous and unavailable discovery are distinct from
 * "no project yet", so callers can refuse to act instead of running blind.
 */
export async function resolveProjectContext(root: string, name: string, provider: ComposeProvider, verifyCreation = false): Promise<ProjectContext> {
    const location = await locateComposeFile(root, name);
    const base = { composeFile: location.path, filename: location.filename, cwd: dirname(location.path) };
    // Apply the editor's `.env` safety rules here too: mutation, follow and
    // project-name resolution must not read an `.env` the editor would reject.
    // When a safe file exists it is passed explicitly with --env-file.
    let envFile: string | null = null;
    try {
        const env = await readFileSafe(join(base.cwd, ENV_FILENAME), MAX_ENV_BYTES);
        if (env) envFile = env.path;
    } catch {
        return { kind: "invalid", project: null, ...base, envFile: null };
    }
    let projects: ComposeProject[];
    try {
        const result = await provider.listProjects();
        if (result.timedOut || result.truncated || result.code !== 0) return { kind: "unavailable", project: null, ...base, envFile };
        projects = parseComposeLs(result.stdout);
    } catch {
        return { kind: "unavailable", project: null, ...base, envFile };
    }
    const match = findProjectForStack(projects, location.path);
    if (match.ambiguous) return { kind: "ambiguous", project: null, ...base, envFile };
    if (!match.project) {
        if (!verifyCreation) return { kind: "absent", project: null, ...base, envFile };
        try {
            const project = await provider.projectName({ composeFile: base.composeFile, cwd: base.cwd, envFile: envFile ?? undefined });
            if (!project) return { kind: "unavailable", project: null, ...base, envFile };
            // Refresh after config resolution; another CLI may have created a
            // project while the effective name was being evaluated.
            const refreshed = await provider.listProjects();
            if (refreshed.code !== 0 || refreshed.timedOut || refreshed.truncated) return { kind: "unavailable", project: null, ...base, envFile };
            if (parseComposeLs(refreshed.stdout).some(entry => entry.name === project)) {
                return { kind: "ambiguous", project: null, ...base, envFile };
            }
            return { kind: "absent", project, ...base, envFile };
        } catch {
            return { kind: "unavailable", project: null, ...base, envFile };
        }
    }
    return { kind: "resolved", project: match.project.name, ...base, envFile };
}

export async function loadStackDetail(root: string, name: string, provider: ComposeProvider): Promise<StackDetailStatus> {
    const location = await locateComposeFile(root, name);
    const { projects, note } = await loadProjects(provider);
    if (note) return { project: null, state: "unknown", note, services: [] };

    const match = findProjectForStack(projects, location.path);
    if (match.ambiguous) {
        return { project: null, state: "unknown", note: SEVERAL_PROJECTS, services: [] };
    }
    if (!match.project) return { project: null, state: "not-created", note: null, services: [] };

    const project = match.project;
    try {
        const result = await provider.projectServices({
            project: project.name,
            composeFile: location.filename,
            cwd: dirname(location.path),
        });
        if (result.timedOut) return { project: project.name, state: "unknown", note: DOCKER_SLOW, services: [] };
        if (result.code !== 0) return { project: project.name, state: "unknown", note: DOCKER_UNAVAILABLE, services: [] };
        const services = parseComposePs(result.stdout);
        return { project: project.name, state: summarizeServices(services), note: null, services };
    } catch {
        return { project: project.name, state: "unknown", note: DOCKER_UNAVAILABLE, services: [] };
    }
}
