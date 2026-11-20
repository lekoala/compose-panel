import { parseHumanBytes } from "./insights.ts";

/**
 * Docker storage maintenance (ADR 0040): the pure part.
 *
 * The browser only ever names one of these three scopes. Every argument,
 * including the age floor, is fixed here: no filter, path or amount from a
 * request reaches the command line. Volumes are never pruned, and
 * `docker system prune` is deliberately not offered because it would also
 * remove stopped containers and networks.
 */
export const MAINTENANCE_SCOPES = ["build-cache", "dangling-images", "unused-images"] as const;
export type MaintenanceScope = (typeof MAINTENANCE_SCOPES)[number];

/** One week. Applies to the build cache and to every image scope. */
export const MAINTENANCE_MIN_AGE_HOURS = 168;
export const MAINTENANCE_MIN_AGE_FILTER = `until=${MAINTENANCE_MIN_AGE_HOURS}h`;

export function isMaintenanceScope(value: string): value is MaintenanceScope {
    return (MAINTENANCE_SCOPES as readonly string[]).includes(value);
}

/**
 * Exact Docker argument arrays. `build-cache` uses `docker builder prune`;
 * without the buildx plugin the CLI falls back to the legacy builder, which
 * accepts the same `--filter until=` option. Buildx-specific builders and
 * BuildKit garbage collection are not covered by this command.
 *
 * `unused-images` adds `-a`: it also removes tagged images that no container
 * (running or stopped) references, which is the case that reclaims images left
 * behind by repeated publishes. A stopped container still keeps its image.
 */
export function maintenanceArgv(scope: MaintenanceScope): string[] {
    switch (scope) {
        case "build-cache":
            return ["builder", "prune", "-f", "--filter", MAINTENANCE_MIN_AGE_FILTER];
        case "dangling-images":
            return ["image", "prune", "-f", "--filter", MAINTENANCE_MIN_AGE_FILTER];
        case "unused-images":
            return ["image", "prune", "-a", "-f", "--filter", MAINTENANCE_MIN_AGE_FILTER];
    }
}

export function parseReclaimedBytes(stdout: string): number | null {
    const match = /^\s*Total reclaimed space:\s*(.+?)\s*$/im.exec(stdout);
    if (!match) return null;
    // Docker prints decimal units (kB, MB, GB); the shared parser knows them,
    // and returns null for an unknown value instead of guessing.
    return parseHumanBytes(match[1]!);
}
