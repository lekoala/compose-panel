import { locateComposeFile, listStacks } from "./stacks.ts";
import { findProjectForStack, parseComposeLs } from "./compose-state.ts";
import {
    ContainerStateError,
    classifyContainers,
    parseContainerLs,
    type ClassifiedContainer,
    type ManagedStack,
    type PathAlias,
} from "./container-state.ts";
import type { ComposeProvider } from "./compose-provider.ts";
import type { ContainerInspector } from "./containers.ts";
import { DOCKER_SLOW, DOCKER_UNAVAILABLE, type ProjectDiscovery } from "./status.ts";

const UNEXPECTED = "Docker returned an unexpected container list. Statuses are shown as unknown. Reload the page to try again.";

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
    if (result.code !== 0) return { containers: [], note: DOCKER_UNAVAILABLE };
    try {
        return { containers: classifyContainers(parseContainerLs(result.stdout), managed, aliases), note: null };
    } catch (error) {
        if (error instanceof ContainerStateError) return { containers: [], note: UNEXPECTED };
        throw error;
    }
}
