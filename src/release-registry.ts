export interface ReleaseRecord {
    version: string;
    digest: string;
    revision: string;
    recordedAt: string;
}

export interface ReleaseRegistry {
    schema: 1;
    releases: ReleaseRecord[];
}

export const RELEASE_VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const REVISION = /^[0-9a-f]{40}$/;
const DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export function parseReleaseRegistry(value: unknown): ReleaseRegistry | null {
    if (typeof value !== "object" || value === null) return null;
    const registry = value as Partial<ReleaseRegistry>;
    if (registry.schema !== 1 || !Array.isArray(registry.releases)) return null;
    let previous = 0;
    const releases: ReleaseRecord[] = [];
    for (const entry of registry.releases) {
        if (!entry || typeof entry !== "object") return null;
        const { version, digest, revision, recordedAt } = entry;
        if (typeof version !== "string" || !RELEASE_VERSION.test(version)
            || typeof digest !== "string" || !DIGEST.test(digest)
            || typeof revision !== "string" || !REVISION.test(revision)
            || typeof recordedAt !== "string" || !DATE.test(recordedAt)) return null;
        const date = Date.parse(recordedAt);
        if (!Number.isFinite(date) || date < previous) return null;
        previous = date;
        releases.push({ version, digest, revision, recordedAt });
    }
    return { schema: 1, releases };
}

export function latestReleaseRecord(registry: ReleaseRegistry, version: string): ReleaseRecord | undefined {
    for (let index = registry.releases.length - 1; index >= 0; index--) {
        const entry = registry.releases[index]!;
        if (entry.version === version) return entry;
    }
    return undefined;
}

/** Preserve all earlier observations; an identical retry is idempotent. */
export function recordRelease(registry: ReleaseRegistry, entry: ReleaseRecord): ReleaseRegistry {
    const latest = latestReleaseRecord(registry, entry.version);
    if (latest?.digest === entry.digest) {
        if (latest.revision !== entry.revision) throw new Error("The same digest cannot change source revision.");
        return registry;
    }
    const next = parseReleaseRegistry({ schema: 1, releases: [...registry.releases, entry] });
    if (!next) throw new Error("Invalid release registration.");
    return next;
}
