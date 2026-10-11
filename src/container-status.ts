import { locateComposeFile, listStacks } from "./stacks.ts";
import { findProjectForStack, parseComposeLs } from "./compose-state.ts";
import {
    ContainerStateError,
    classifyContainers,
    parseContainerInspect,
    parseContainerLs,
    type ClassifiedContainer,
    type ContainerDetails,
    type ManagedStack,
    type PathAlias,
} from "./container-state.ts";
import type { ComposeProvider } from "./compose-provider.ts";
import { ContainerRefError, isContainerId, type ContainerInspector } from "./containers.ts";
import { DOCKER_SLOW, DOCKER_TRUNCATED, DOCKER_UNAVAILABLE, type ProjectDiscovery } from "./status.ts";

const UNEXPECTED = "Docker returned an unexpected container list. Statuses are shown as unknown. Reload the page to try again.";
const DETAILS_UNAVAILABLE = "The container may have been removed, so its details could not be read. Reload the page to try again.";
const DETAILS_SLOW = "Docker did not respond in time while reading this container. Reload the page to try again.";

export interface ContainerListStatus {
    containers: ClassifiedContainer[];
    note: string | null;
}

/**
 * Build the managed-stack identities used to classify containers, from the
 * stacks the panel actually discovered and their deployed project names. A stack
 * whose project is unknown or ambiguous contributes no project identity, so a
 * container is never classified as managed on a guessed name.
 */
export async function loadManagedStacks(root: string, provider: ComposeProvider, discovery?: ProjectDiscovery): Promise<ManagedStack[]> {
    let stacks: Awaited<ReturnType<typeof listStacks>>;
    try {
        stacks = await listStacks(root);
    } catch {
        // A missing or unreadable stacks root is not a container-list failure:
        // classification simply has no managed stacks to match against.
        return [];
    }
    let projects: ReturnType<typeof parseComposeLs>;
    if (discovery) {
        projects = discovery.projects;
    } else {
        projects = [];
        try {
            const result = await provider.listProjects();
            if (result.code === 0 && !result.timedOut && !result.truncated) {
                projects = parseComposeLs(result.stdout);
            }
        } catch {
            // No project identity available; still list containers as external.
        }
    }
    const managed: ManagedStack[] = [];
    for (const stack of stacks) {
        try {
            const location = await locateComposeFile(root, stack.name);
            const match = findProjectForStack(projects, location.path);
            managed.push({
                name: stack.name,
                composeFile: location.path,
                project: match.ambiguous ? null : match.project?.name ?? null,
            });
        } catch {
            // Skip an unreadable stack: it cannot own a container.
        }
    }
    return managed;
}

/** Read every container through the inspector and classify it. */
export async function loadContainers(
    root: string,
    provider: ComposeProvider,
    inspector: ContainerInspector,
    aliases: PathAlias[] = [],
    discovery?: ProjectDiscovery,
): Promise<ContainerListStatus> {
    const managed = await loadManagedStacks(root, provider, discovery);
    let result: Awaited<ReturnType<ContainerInspector["list"]>>;
    try {
        result = await inspector.list();
    } catch {
        return { containers: [], note: DOCKER_UNAVAILABLE };
    }
    if (result.timedOut) return { containers: [], note: DOCKER_SLOW };
    // A truncated list may omit containers, so it is never classified as if
    // complete: report it as unavailable with a note instead.
    if (result.truncated) return { containers: [], note: DOCKER_TRUNCATED };
    if (result.code !== 0) return { containers: [], note: DOCKER_UNAVAILABLE };
    try {
        return { containers: classifyContainers(parseContainerLs(result.stdout), managed, aliases), note: null };
    } catch (error) {
        if (error instanceof ContainerStateError) return { containers: [], note: UNEXPECTED };
        throw error;
    }
}

export interface ContainerDetailStatus {
    container: ClassifiedContainer;
    /** Whitelisted projection, or null when Docker could not return it. */
    details: ContainerDetails | null;
    note: string | null;
}

/**
 * Outcome of resolving one container for its detail page. `unavailable` means
 * the container list itself could not be read, so "not found" must not be
 * reported: the container may exist but Docker is unreachable.
 */
export type ContainerDetailResult =
    | { kind: "found"; detail: ContainerDetailStatus }
    | { kind: "not-found" }
    | { kind: "unavailable"; note: string };

/**
 * Resolve one container for its detail page: find it in the classified list
 * (for category and stack) then read a single `docker container inspect`.
 * Returns `not-found` when the list was read but no container matches the
 * reference (a 404), and `unavailable` when the list could not be read (a
 * 503); throws `ContainerRefError` for a malformed reference (a 400).
 */
export async function loadContainerDetail(
    root: string,
    id: string,
    provider: ComposeProvider,
    inspector: ContainerInspector,
    aliases: PathAlias[] = [],
): Promise<ContainerDetailResult> {
    if (!isContainerId(id)) throw new ContainerRefError();
    const { containers, note } = await loadContainers(root, provider, inspector, aliases);
    if (note) return { kind: "unavailable", note };
    const container = containers.find(entry => entry.id === id || entry.id.startsWith(id));
    if (!container) return { kind: "not-found" };
    let result: Awaited<ReturnType<ContainerInspector["inspect"]>>;
    try {
        result = await inspector.inspect(container.id);
    } catch {
        return { kind: "found", detail: { container, details: null, note: DETAILS_UNAVAILABLE } };
    }
    if (result.timedOut) return { kind: "found", detail: { container, details: null, note: DETAILS_SLOW } };
    if (result.code !== 0) return { kind: "found", detail: { container, details: null, note: DETAILS_UNAVAILABLE } };
    try {
        return { kind: "found", detail: { container, details: parseContainerInspect(result.stdout), note: null } };
    } catch (error) {
        if (error instanceof ContainerStateError) return { kind: "found", detail: { container, details: null, note: DETAILS_UNAVAILABLE } };
        throw error;
    }
}
