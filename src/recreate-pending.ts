import type { ComposeProvider } from "./compose-provider.ts";
import { parseContainerConfigStates, type ComposeService } from "./compose-state.ts";

/**
 * Services whose containers were created from another configuration than the
 * one `up` would apply now: the `com.docker.compose.config-hash` label of a
 * container differs from the hash `config --hash` prints (ADR 0032). `Up`
 * recreates them; `Restart` does not.
 *
 * Read-only: `config --hash` and `container inspect`. Never throws. A service
 * is reported only when every one of its containers could be compared; any
 * failure, missing label or container name, incomplete `HostConfig`, or
 * container sharing another container's namespaces or volumes means "no
 * information" for that service, never a guess.
 */
export async function loadRecreatePending(
    provider: ComposeProvider,
    input: { project: string; composeFile: string; cwd: string; envFile?: string },
    services: ComposeService[],
): Promise<string[]> {
    try {
        if (!provider.capabilities().configHashes) return [];
        if (services.length === 0) return [];
        const names = services.map(service => service.container).filter((name): name is string => Boolean(name));
        const [hashes, inspected] = await Promise.all([
            provider.serviceConfigHashes(input),
            provider.inspectContainers(names),
        ]);
        // A container that vanished meanwhile makes inspect exit non-zero:
        // the snapshot is no longer coherent, so nothing is reported.
        if (!hashes || inspected.code !== 0 || inspected.timedOut || inspected.truncated) return [];
        const states = parseContainerConfigStates(inspected.stdout);

        const verdicts = new Map<string, boolean | null>();
        for (const service of services) {
            if (verdicts.get(service.name) === null) continue;
            const state = service.container ? states.get(service.container) : undefined;
            const expected = hashes.get(service.name);
            if (!state || !expected || state.service !== service.name || !state.configHash || state.sharesContainer !== false) {
                verdicts.set(service.name, null);
                continue;
            }
            verdicts.set(service.name, (verdicts.get(service.name) ?? false) || state.configHash !== expected);
        }
        return [...verdicts].filter(([, pending]) => pending === true).map(([name]) => name);
    } catch {
        return [];
    }
}
