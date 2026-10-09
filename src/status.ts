import { dirname } from "node:path";
import { listStacks, locateComposeFile } from "./stacks.ts";
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
import type { DockerRunner } from "./docker.ts";

const DOCKER_UNAVAILABLE = "Docker state is unavailable.";

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

async function loadProjects(runner: DockerRunner): Promise<{ projects: ComposeProject[]; note: string | null }> {
    try {
        const result = await runner(["compose", "ls", "--all", "--format", "json"]);
        if (result.timedOut) return { projects: [], note: "Docker did not answer in time." };
        if (result.code !== 0) return { projects: [], note: DOCKER_UNAVAILABLE };
        return { projects: parseComposeLs(result.stdout), note: null };
    } catch {
        return { projects: [], note: DOCKER_UNAVAILABLE };
    }
}

export async function loadStackStates(root: string, runner: DockerRunner): Promise<StackListStatus> {
    const stacks = await listStacks(root);
    const { projects, note } = await loadProjects(runner);
    const result: StackStatus[] = [];

    for (const stack of stacks) {
        const base = { name: stack.name, composeFile: stack.composeFile };
        let location: { path: string; filename: string };
        try {
            location = await locateComposeFile(root, stack.name);
        } catch {
            result.push({ ...base, project: null, state: "unknown", note: "Compose file could not be resolved." });
            continue;
        }
        if (note) {
            result.push({ ...base, project: null, state: "unknown", note });
            continue;
        }
        const match = findProjectForStack(projects, location.path);
        if (match.ambiguous) {
            result.push({ ...base, project: null, state: "unknown", note: "Several Docker projects match this stack." });
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

export async function loadStackDetail(root: string, name: string, runner: DockerRunner): Promise<StackDetailStatus> {
    const location = await locateComposeFile(root, name);
    const { projects, note } = await loadProjects(runner);
    if (note) return { project: null, state: "unknown", note, services: [] };

    const match = findProjectForStack(projects, location.path);
    if (match.ambiguous) {
        return { project: null, state: "unknown", note: "Several Docker projects match this stack.", services: [] };
    }
    if (!match.project) return { project: null, state: "not-created", note: null, services: [] };

    const project = match.project;
    try {
        const result = await runner(
            ["compose", "-p", project.name, "-f", location.filename, "ps", "--all", "--format", "json"],
            { cwd: dirname(location.path) },
        );
        if (result.timedOut) return { project: project.name, state: "unknown", note: "Docker did not answer in time.", services: [] };
        if (result.code !== 0) return { project: project.name, state: "unknown", note: DOCKER_UNAVAILABLE, services: [] };
        const services = parseComposePs(result.stdout);
        return { project: project.name, state: summarizeServices(services), note: null, services };
    } catch {
        return { project: project.name, state: "unknown", note: DOCKER_UNAVAILABLE, services: [] };
    }
}
