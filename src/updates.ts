import type { ComposeProvider } from "./compose-provider.ts";
import {
    parseComposeImages,
    parseContainerImages,
    parseImageInspect,
    type ComposeService,
    type ImageDetails,
    type RecoveredImage,
} from "./compose-state.ts";
import { deployedImage, type DeployedImage } from "./deployment.ts";

/** What the panel shows about one side of an update. */
export interface ImageVersion {
    /** `org.opencontainers.image.version`, when the image declares one. */
    version: string | null;
    /** Build date (YYYY-MM-DD). */
    created: string | null;
    /** Short content digest, e.g. "sha256:3f2a9c1b7d4e". */
    digest: string | null;
}

export interface ImageLink {
    href: string;
    label: string;
}

/** A service whose container runs an older image than the one its tag now points to locally. */
export interface ServiceUpdate {
    image: string;
    from: ImageVersion;
    to: ImageVersion;
    /** Where to read about the change, when it can be derived safely. */
    link: ImageLink | null;
}

/**
 * Detect, without any network access, which services would get a newer image
 * from `Up`: the tag was updated locally (by Pull, or by a pull outside the
 * panel) but the container still runs the previous image.
 *
 * Read-only: `compose images`, `image inspect` and, for an image that is gone,
 * `container inspect`. Never throws: any failure means "no information", never
 * an invented update.
 */
export async function loadImageUpdates(
    provider: ComposeProvider,
    input: { project: string; composeFile: string; cwd: string; envFile?: string },
    services: ComposeService[],
    deployed?: DeployedImage[],
): Promise<Record<string, ServiceUpdate>> {
    const updates: Record<string, ServiceUpdate> = {};
    try {
        // A service whose `ps` image is a bare image ID most likely lost its tag
        // (see below), so it stays a candidate: its reference is recovered.
        const candidates = services.filter(
            (service) => service.container && (deployed || (service.image && (isTagReference(service.image) || isImageId(service.image)))),
        );
        if (candidates.length === 0) return updates;

        const images = await provider.projectImages(input);
        if (images.code !== 0 || images.timedOut || images.truncated) return updates;
        const running = new Map(parseComposeImages(images.stdout).map((row) => [row.container, row.imageId]));

        const refs = candidates.filter((service) => service.image && isTagReference(service.image)).map((service) => service.image!);
        const ids = candidates.map((service) => running.get(service.container!)).filter((id): id is string => Boolean(id));
        // Missing references make the CLI exit non-zero while still printing
        // the others, so parse whatever came back.
        const inspected = await provider.inspectImages([...refs, ...ids]);
        if (inspected.timedOut || inspected.truncated) return updates;
        const details = parseImageInspect(inspected.stdout);
        const byId = new Map(details.map((detail) => [detail.id, detail]));

        // With the containerd image store, an image disappears once its tag
        // moves, even while a container still runs it, and `compose ps` then
        // reports the bare image ID instead of the configured reference. The
        // container keeps both the OCI labels it inherited and that reference,
        // so read them from it, and only while it still reports the same image.
        const orphaned = candidates.filter((service) => {
            const id = running.get(service.container!);
            return id !== undefined && !byId.has(id);
        });
        const fromContainers =
            orphaned.length > 0
                ? await containerImages(
                      provider,
                      orphaned.map((service) => service.container!),
                  )
                : new Map<string, RecoveredImage>();
        const recover = (service: ComposeService): RecoveredImage | undefined => {
            const recovered = fromContainers.get(service.container!);
            return recovered && recovered.detail.id === running.get(service.container!) ? recovered : undefined;
        };

        const recoveredRefs = orphaned
            .filter((service) => !service.image || !isTagReference(service.image))
            .map((service) => recover(service)?.reference)
            .filter((ref): ref is string => Boolean(ref && isTagReference(ref) && !refs.includes(ref)));
        if (recoveredRefs.length > 0) {
            const more = await provider.inspectImages(recoveredRefs);
            if (!more.timedOut && !more.truncated) details.push(...parseImageInspect(more.stdout));
        }

        for (const service of candidates) {
            const runningId = running.get(service.container!);
            const recovered = recover(service);
            const previous = runningId ? (byId.get(runningId) ?? recovered?.detail) : undefined;
            if (previous && deployed) deployed.push(deployedImage(service.name, service.container!, previous));
            const image = service.image && isTagReference(service.image) ? service.image : recovered?.reference;
            if (!image || !isTagReference(image)) continue;
            const tagged = findByTag(details, image);
            if (!runningId || !tagged || tagged.id === runningId) continue;
            updates[service.name] = {
                image,
                from: versionOf(previous),
                to: versionOf(tagged),
                link: linkFor(image, tagged.labels),
            };
        }
    } catch {
        return {};
    }
    return updates;
}

/** Best effort: a failed or partial read only means no recovered metadata. */
async function containerImages(provider: ComposeProvider, names: string[]): Promise<Map<string, RecoveredImage>> {
    const result = await provider.inspectContainers(names);
    if (result.timedOut || result.truncated) return new Map();
    return parseContainerImages(result.stdout);
}

/** A pullable tag, not an image pinned by digest or ID (those never "update"). */
function isTagReference(image: string): boolean {
    return !image.includes("@") && !image.startsWith("sha256:");
}

function isImageId(image: string): boolean {
    return /^sha256:[0-9a-f]{64}$/.test(image);
}

/** `nginx` → `nginx:latest`; registry prefixes for Docker Hub are dropped like Docker does. */
export function normalizeReference(ref: string): string {
    let value = ref
        .replace(/^docker\.io\/library\//, "")
        .replace(/^docker\.io\//, "")
        .replace(/^index\.docker\.io\/(library\/)?/, "");
    const lastSlash = value.lastIndexOf("/");
    if (!value.slice(lastSlash + 1).includes(":")) value = `${value}:latest`;
    return value;
}

export function findByTag(details: ImageDetails[], ref: string): ImageDetails | undefined {
    const wanted = normalizeReference(ref);
    return details.find((detail) => detail.repoTags.some((tag) => normalizeReference(tag) === wanted));
}

export function versionOf(detail: ImageDetails | undefined): ImageVersion {
    if (!detail) return { version: null, created: null, digest: null };
    const label = detail.labels["org.opencontainers.image.version"]?.trim();
    const digest = detail.repoDigests[0]?.split("@")[1] ?? detail.id;
    return {
        version: label && label.length <= 64 ? label : null,
        created: detail.created && /^\d{4}-\d{2}-\d{2}/.test(detail.created) ? detail.created.slice(0, 10) : null,
        digest: /^sha256:[0-9a-f]{12}/.test(digest) ? digest.slice(0, 19) : null,
    };
}

/** Only absolute http(s) URLs from labels are used; anything else is ignored. */
function safeUrl(value: string | undefined): string | null {
    if (!value || value.length > 300) return null;
    try {
        const url = new URL(value.trim());
        return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
    } catch {
        return null;
    }
}

/**
 * Where to read about a new image, from its OCI labels (untrusted, validated),
 * else its Docker Hub page for images hosted there.
 */
export function linkFor(ref: string, labels: Record<string, string>): ImageLink | null {
    const source = safeUrl(labels["org.opencontainers.image.source"]);
    if (source) {
        const github = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(source);
        if (github) return { href: `https://github.com/${github[1]}/${github[2]}/releases`, label: "Release notes" };
        return { href: source, label: "Source" };
    }
    const page = safeUrl(labels["org.opencontainers.image.url"]) ?? safeUrl(labels["org.opencontainers.image.documentation"]);
    if (page) return { href: page, label: "Image page" };
    const name = normalizeReference(ref).replace(/:[^/]*$/, "");
    const first = name.split("/")[0]!;
    const hasRegistry = name.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost");
    if (hasRegistry) return null;
    if (!/^[a-z0-9._/-]+$/.test(name)) return null;
    return name.includes("/")
        ? { href: `https://hub.docker.com/r/${name}`, label: "Docker Hub" }
        : { href: `https://hub.docker.com/_/${name}`, label: "Docker Hub" };
}
