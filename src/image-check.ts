import type { CommandResult } from "./docker.ts";
import type { ComposeProvider, ServiceImageFact } from "./compose-provider.ts";
import { parseImageInspect, type ImageDetails } from "./compose-state.ts";
import { findByTag } from "./updates.ts";

/**
 * Remote image check (ADR 0041, part B). It answers exactly one question:
 * does the tag a service references still resolve, in its registry, to the
 * digest Docker recorded for that tag locally? Anything less certain is
 * `unknown` with a reason; nothing is downloaded and no container is touched.
 */

/** Whole-check deadline, covering every registry query it starts. */
export const IMAGE_CHECK_TIMEOUT_MS = 30_000;
/** At most this many registries are queried at once (bounded fan-out). */
const REMOTE_CONCURRENCY = 4;
/** A stack with more pullable images than this is refused instead of hammering registries. */
const MAX_TRACKED_SERVICES = 50;
const MANIFEST_MEDIA_TYPES = new Set([
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
]);
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;

/**
 * Why a tag could not be compared. Registry failures are classified so the
 * administrator sees one sentence; local failures keep their own reasons
 * because the fix is different (pull first, or the tag itself is ambiguous).
 */
export type RemoteCheckReason =
    | "not-found"
    | "unauthorized"
    | "rate-limited"
    | "timeout"
    | "invalid-output"
    | "unsupported"
    | "no-local-digest"
    | "ambiguous-local-digest";

/** Why a service is outside the check, with no network call. */
export type NotTrackedReason = "build" | "digest-pinned" | "image-id" | "no-image";

export type RemoteVerdict =
    | { kind: "up-to-date"; localDigest: string; remoteDigest: string }
    | { kind: "update-available"; localDigest: string; remoteDigest: string }
    | { kind: "unknown"; reason: RemoteCheckReason }
    | { kind: "not-tracked"; reason: NotTrackedReason };

export interface ServiceRemoteCheck {
    service: string;
    /** The validated reference the verdict belongs to; null when the service declares none. */
    reference: string | null;
    verdict: RemoteVerdict;
}

/** The last check of one stack, kept in memory only (no TTL cache, no persistence). */
export interface ImageCheckView {
    stack: string;
    status: "running" | "done";
    startedAt: number;
    finishedAt: number | null;
    /**
     * The result was not published because the local state changed while the
     * check ran. It carries no verdict: the page asks for another check.
     */
    discarded: boolean;
    services: ServiceRemoteCheck[];
}

export type LocalDigestResolution =
    { kind: "digest"; reference: string; digest: string } | { kind: "unknown"; reference: string; reason: RemoteCheckReason };

export interface ImageCheckTarget {
    project?: string;
    composeFile: string;
    cwd: string;
    envFile?: string;
}

export class ImageCheckBusyError extends Error {
    constructor(message = "Another image check is already running. Wait for it to finish, then try again.") {
        super(message);
        this.name = "ImageCheckBusyError";
    }
}

export class ImageCheckDisabledError extends Error {
    constructor(message = "The panel is shutting down and no longer starts image checks.") {
        super(message);
        this.name = "ImageCheckDisabledError";
    }
}

export class ImageCheckRefusedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ImageCheckRefusedError";
    }
}

export interface ImageCheckOptions {
    timeoutMs?: number;
    /** Called once when a check finishes, for the audit log. Never allowed to throw. */
    onFinish?: (view: ImageCheckView) => void;
    now?: () => number;
}

/**
 * One check at a time for the whole panel, last result in memory per stack.
 * A check reads the registry through the provider and publishes only when the
 * stack's local state (generation, references, local digests) is still the one
 * it started from; otherwise its result is discarded, never displayed.
 */
export class ImageCheckManager {
    private readonly last = new Map<string, ImageCheckView>();
    private readonly generations = new Map<string, number>();
    private globalGeneration = 0;
    private readonly timeoutMs: number;
    private readonly now: () => number;
    private running: string | null = null;
    private task: Promise<void> | null = null;
    private shuttingDown = false;

    constructor(
        private readonly provider: ComposeProvider,
        private readonly options: ImageCheckOptions = {},
    ) {
        this.timeoutMs = options.timeoutMs ?? IMAGE_CHECK_TIMEOUT_MS;
        this.now = options.now ?? Date.now;
    }

    forStack(stack: string): ImageCheckView | null {
        return this.last.get(stack) ?? null;
    }

    /** One check for the whole panel, whatever the stack. */
    isRunning(stack?: string): boolean {
        return stack === undefined ? this.running !== null : this.running === stack;
    }

    /**
     * The stack's local state changed through a save: only its own references
     * can differ. A finished verdict is dropped; an in-flight check will discard
     * itself through the generation it recorded.
     */
    changed(stack: string): void {
        this.generations.set(stack, (this.generations.get(stack) ?? 0) + 1);
        const view = this.last.get(stack);
        if (view && view.status === "done") this.last.delete(stack);
    }

    /**
     * A mutation started or ended, so the engine-wide image store may have
     * changed. A tag can be shared by several stacks (Pull in one changes the
     * local digest the other compared against), so every stored verdict is
     * dropped and every in-flight check is invalidated, whichever stack it
     * belongs to. Re-running Check is the only way to get a fresh verdict.
     */
    imagesChanged(): void {
        this.globalGeneration += 1;
        for (const [stack, view] of this.last) {
            if (view.status === "done") this.last.delete(stack);
        }
    }

    /**
     * Start a check. Only the effective configuration is read before this
     * returns, so the caller can redirect at once; the registry queries run in
     * the background, bounded by one shared deadline.
     */
    async start(input: { stack: string; target: ImageCheckTarget }): Promise<ImageCheckView> {
        if (this.shuttingDown) throw new ImageCheckDisabledError();
        if (this.running !== null) throw new ImageCheckBusyError();
        // Reserve synchronously: two requests cannot both pass the check above.
        this.running = input.stack;
        const startedAt = this.now();
        const generation = this.generations.get(input.stack) ?? 0;
        const globalGeneration = this.globalGeneration;
        let facts: Map<string, ServiceImageFact> | null = null;
        try {
            facts = await this.provider.serviceImageFacts(input.target);
        } catch {
            facts = null;
        }
        if (!facts) {
            this.running = null;
            throw new ImageCheckRefusedError("The Compose configuration could not be read, so the registry was not checked.");
        }
        // The configuration read awaits a subprocess: shutdown may have begun.
        if (this.shuttingDown) {
            this.running = null;
            throw new ImageCheckDisabledError();
        }
        const untracked: ServiceRemoteCheck[] = [];
        const tracked: TrackedImage[] = [];
        for (const [service, fact] of sortedFacts(facts)) {
            if (fact.build) {
                untracked.push({ service, reference: fact.image, verdict: { kind: "not-tracked", reason: "build" } });
                continue;
            }
            const reference = fact.image;
            if (!reference) {
                untracked.push({ service, reference: null, verdict: { kind: "not-tracked", reason: "no-image" } });
                continue;
            }
            if (reference.includes("@")) {
                untracked.push({ service, reference, verdict: { kind: "not-tracked", reason: "digest-pinned" } });
                continue;
            }
            if (IMAGE_ID.test(reference)) {
                untracked.push({ service, reference, verdict: { kind: "not-tracked", reason: "image-id" } });
                continue;
            }
            tracked.push({ service, reference });
        }
        if (tracked.length > MAX_TRACKED_SERVICES) {
            this.running = null;
            throw new ImageCheckRefusedError("This stack declares more images than the panel checks at once. Nothing was checked.");
        }
        const view: ImageCheckView = {
            stack: input.stack,
            status: "running",
            startedAt,
            finishedAt: null,
            discarded: false,
            // Only services that are known not to be checked yet: tracked ones
            // get their verdict when (and only if) the result is published.
            services: untracked,
        };
        this.last.set(input.stack, view);
        const task = this.check({
            stack: input.stack,
            target: input.target,
            generation,
            globalGeneration,
            signature: signatureOf(facts),
            tracked,
            untracked,
            startedAt,
        });
        this.task = task;
        void task
            .catch(() => undefined)
            .then(() => {
                // An unexpected failure must not leave the page waiting forever.
                if (this.last.get(input.stack)?.status === "running") this.last.delete(input.stack);
                if (this.task === task) this.task = null;
                this.running = null;
            });
        return view;
    }

    /** Refuse new checks and wait (bounded) for a running one. */
    async shutdown(graceMs: number): Promise<void> {
        this.shuttingDown = true;
        const task = this.task;
        if (!task) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                task,
                new Promise<void>((resolve) => {
                    timer = setTimeout(resolve, graceMs);
                }),
            ]);
        } finally {
            clearTimeout(timer);
        }
    }

    private async check(input: {
        stack: string;
        target: ImageCheckTarget;
        generation: number;
        globalGeneration: number;
        signature: string;
        tracked: TrackedImage[];
        untracked: ServiceRemoteCheck[];
        startedAt: number;
    }): Promise<void> {
        const deadline = input.startedAt + this.timeoutMs;
        const local = await this.readLocal(input.tracked);
        const unknown = (image: TrackedImage, reason: RemoteCheckReason): ServiceRemoteCheck => ({
            service: image.service,
            reference: image.reference,
            verdict: { kind: "unknown", reason },
        });
        const results = await mapPool(input.tracked, REMOTE_CONCURRENCY, async (image): Promise<ServiceRemoteCheck> => {
            const resolution = local.get(image.service)!;
            if (resolution.kind === "unknown") return unknown(image, resolution.reason);
            const remaining = deadline - this.now();
            if (remaining <= 0) return unknown(image, "timeout");
            let result: CommandResult;
            try {
                result = await this.provider.inspectRemoteManifest(image.reference, {
                    timeoutMs: Math.min(remaining, this.timeoutMs),
                });
            } catch {
                result = { code: -1, stdout: "", stderr: "", timedOut: false, truncated: false };
            }
            if (result.timedOut) return unknown(image, "timeout");
            if (result.code !== 0 || result.truncated) return unknown(image, classifyRemoteResult(result));
            const remote = parseRemoteManifest(result.stdout);
            if (!remote) return unknown(image, "invalid-output");
            const verdict: RemoteVerdict =
                remote.digest === resolution.digest
                    ? { kind: "up-to-date", localDigest: resolution.digest, remoteDigest: remote.digest }
                    : { kind: "update-available", localDigest: resolution.digest, remoteDigest: remote.digest };
            return { service: image.service, reference: image.reference, verdict };
        });

        const finishedAt = this.now();
        // The generations are read again once, synchronously, after the guard's
        // last await: a mutation that completed in that gap already bumped them,
        // and nothing can interleave between this read and the store below.
        const publish =
            (await this.stillCurrent(input, local)) &&
            (this.generations.get(input.stack) ?? 0) === input.generation &&
            this.globalGeneration === input.globalGeneration;
        if (!publish) {
            // The comparison no longer describes the stack: publish no verdict.
            this.last.delete(input.stack);
            const discarded: ImageCheckView = {
                stack: input.stack,
                status: "done",
                startedAt: input.startedAt,
                finishedAt,
                discarded: true,
                services: [],
            };
            if (!this.shuttingDown) this.last.set(input.stack, discarded);
            this.finish(discarded);
            return;
        }
        const done: ImageCheckView = {
            stack: input.stack,
            status: "done",
            startedAt: input.startedAt,
            finishedAt,
            discarded: false,
            services: [...input.untracked, ...results],
        };
        this.last.set(input.stack, done);
        this.finish(done);
    }

    /** Local digests of every tracked reference, read once before the queries. */
    private async readLocal(tracked: TrackedImage[]): Promise<Map<string, LocalDigestResolution>> {
        const resolutions = new Map<string, LocalDigestResolution>();
        if (tracked.length === 0) return resolutions;
        const read = await this.inspectLocal(tracked.map((image) => image.reference));
        for (const image of tracked) {
            if (read.failure) {
                resolutions.set(image.service, { kind: "unknown", reference: image.reference, reason: read.failure });
                continue;
            }
            resolutions.set(image.service, resolveLocalDigest(findByTag(read.details, image.reference), image.reference));
        }
        return resolutions;
    }

    private async inspectLocal(refs: string[]): Promise<{ details: ImageDetails[]; failure: RemoteCheckReason | null }> {
        let result: CommandResult;
        try {
            result = await this.provider.inspectImages(refs);
        } catch {
            return { details: [], failure: "unsupported" };
        }
        if (result.timedOut) return { details: [], failure: "timeout" };
        if (result.truncated) return { details: [], failure: "invalid-output" };
        // A missing reference makes the CLI exit non-zero while still printing
        // the others, so whatever came back is parsed and checked by reference.
        return { details: parseImageInspect(result.stdout), failure: null };
    }

    /**
     * Publish guard (ADR 0041): generation, references and local digests must
     * still be the ones the check started from. The final generation read
     * closes the window opened by the two re-reads above it.
     */
    private async stillCurrent(
        input: { stack: string; target: ImageCheckTarget; generation: number; globalGeneration: number; signature: string },
        local: Map<string, LocalDigestResolution>,
    ): Promise<boolean> {
        if (this.shuttingDown) return false;
        if ((this.generations.get(input.stack) ?? 0) !== input.generation) return false;
        if (this.globalGeneration !== input.globalGeneration) return false;
        let facts: Map<string, ServiceImageFact> | null = null;
        try {
            facts = await this.provider.serviceImageFacts(input.target);
        } catch {
            return false;
        }
        if (!facts || signatureOf(facts) !== input.signature) return false;
        const verified = [...local.values()].filter(
            (entry): entry is Extract<LocalDigestResolution, { kind: "digest" }> => entry.kind === "digest",
        );
        if (verified.length > 0) {
            const read = await this.inspectLocal(verified.map((entry) => entry.reference));
            if (read.failure) return false;
            for (const entry of verified) {
                const current = resolveLocalDigest(findByTag(read.details, entry.reference), entry.reference);
                if (current.kind !== "digest" || current.digest !== entry.digest) return false;
            }
        }
        return (this.generations.get(input.stack) ?? 0) === input.generation && this.globalGeneration === input.globalGeneration;
    }

    private finish(view: ImageCheckView): void {
        try {
            this.options.onFinish?.(view);
        } catch {
            /* recording must not fail the check */
        }
    }
}

interface TrackedImage {
    service: string;
    reference: string;
}

function sortedFacts(facts: Map<string, ServiceImageFact>): [string, ServiceImageFact][] {
    return [...facts].sort(([a], [b]) => a.localeCompare(b));
}

/** A comparable projection of the configuration: any edit that changes it discards a check. */
function signatureOf(facts: Map<string, ServiceImageFact>): string {
    return sortedFacts(facts)
        .map(([service, fact]) => `${service}\u0000${fact.image ?? ""}\u0000${fact.build ? "1" : "0"}`)
        .join("\u0001");
}

/**
 * `nginx:1.27` and `docker.io/library/nginx:1.27` are the same repository as
 * Docker records it (`nginx`). The tag and digest are dropped; only the
 * repository is compared against `RepoDigests` entries.
 */
export function normalizeRepository(ref: string): string {
    let value = ref.trim().toLowerCase();
    const at = value.indexOf("@");
    if (at >= 0) value = value.slice(0, at);
    value = value
        .replace(/^docker\.io\/library\//, "")
        .replace(/^docker\.io\//, "")
        .replace(/^index\.docker\.io\/(library\/)?/, "");
    const slash = value.lastIndexOf("/");
    const last = value.slice(slash + 1);
    const colon = last.lastIndexOf(":");
    return colon >= 0 ? `${value.slice(0, slash + 1)}${last.slice(0, colon)}` : value;
}

export function isManifestMediaType(mediaType: string): boolean {
    return MANIFEST_MEDIA_TYPES.has(mediaType);
}

/**
 * Which digest the local tag was pulled from, by capability (ADR 0041):
 * the per-reference `Descriptor.digest` when it describes an index or a
 * manifest, else a single unambiguous `RepoDigests` entry for the same
 * repository, else `unknown`. Membership alone is never used: two tags of one
 * repository that share a local image would both look "up to date".
 */
export function resolveLocalDigest(detail: ImageDetails | undefined, ref: string): LocalDigestResolution {
    if (!detail) return { kind: "unknown", reference: ref, reason: "no-local-digest" };
    const descriptor = detail.descriptor;
    if (descriptor && isManifestMediaType(descriptor.mediaType) && DIGEST.test(descriptor.digest)) {
        return { kind: "digest", reference: ref, digest: descriptor.digest };
    }
    const repository = normalizeRepository(ref);
    const digests = new Set<string>();
    for (const entry of detail.repoDigests) {
        const at = entry.lastIndexOf("@");
        if (at <= 0) continue;
        const digest = entry.slice(at + 1);
        if (!DIGEST.test(digest)) continue;
        if (normalizeRepository(entry.slice(0, at)) !== repository) continue;
        digests.add(digest);
    }
    // Docker records a repository digest per image, not per tag: an image
    // pulled as `repo:a` and then retagged `repo:b` carries the digest that
    // belonged to `a`. A single RepoDigests entry is therefore only usable when
    // this reference is the only tag of that repository on the image.
    const repositoryTags = detail.repoTags.map(normalizeRepository).filter((name) => name === repository);
    if (digests.size === 1 && repositoryTags.length === 1) {
        return { kind: "digest", reference: ref, digest: [...digests][0]! };
    }
    return {
        kind: "unknown",
        reference: ref,
        reason: digests.size === 0 || repositoryTags.length === 0 ? "no-local-digest" : "ambiguous-local-digest",
    };
}

/** `imagetools inspect --format '{{json .Manifest}}'` answers `{mediaType, digest, manifests?}`. */
export function parseRemoteManifest(stdout: string): { digest: string } | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(stdout.trim());
    } catch {
        return null;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const digest = record.digest;
    if (typeof digest !== "string" || !DIGEST.test(digest)) return null;
    // An unexpected top-level media type is not something this comparison
    // understands: report unknown instead of comparing it.
    const mediaType = record.mediaType;
    if (typeof mediaType === "string" && !isManifestMediaType(mediaType)) return null;
    return { digest };
}

/**
 * One classified reason from a failed CLI call. Raw registry output is never
 * rendered or logged; only this vocabulary reaches the page.
 */
export function classifyRemoteResult(result: CommandResult): RemoteCheckReason {
    if (result.timedOut) return "timeout";
    if (result.truncated) return "invalid-output";
    const text = `${result.stderr}\n${result.stdout}`.toLowerCase();
    if (/unknown command|not a docker command|no such plugin|plugin .*not (installed|found)|buildx.*(missing|not found)/.test(text)) {
        return "unsupported";
    }
    if (/\b401\b|unauthorized|authentication required|access denied|forbidden/.test(text)) return "unauthorized";
    if (/\b429\b|too many requests|rate limit|toomanyrequests/.test(text)) return "rate-limited";
    if (/not found|manifest unknown|name unknown|repository does not exist/.test(text)) return "not-found";
    return "invalid-output";
}

export interface ImageCheckSummary {
    /** Services the check could compare (up to date or update available). */
    compared: number;
    updates: number;
    unknown: number;
    /** Services the check deliberately skipped (`build:`, pinned reference…). */
    untracked: number;
}

/** Counts for the page and the audit line; never a verdict of its own. */
export function summarizeCheck(view: ImageCheckView): ImageCheckSummary {
    let compared = 0;
    let updates = 0;
    let unknown = 0;
    let untracked = 0;
    for (const entry of view.services) {
        switch (entry.verdict.kind) {
            case "up-to-date":
                compared += 1;
                break;
            case "update-available":
                compared += 1;
                updates += 1;
                break;
            case "unknown":
                unknown += 1;
                break;
            case "not-tracked":
                untracked += 1;
                break;
        }
    }
    return { compared, updates, unknown, untracked };
}

/** Smallest useful pool: at most `limit` calls in flight, results in input order. */
async function mapPool<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        for (;;) {
            const index = next++;
            if (index >= items.length) return;
            results[index] = await run(items[index]!);
        }
    });
    await Promise.all(workers);
    return results;
}
