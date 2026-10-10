import type { ComposeProvider } from "./compose-provider.ts";
import { parseComposeImages, parseImageInspect, type ComposeService, type ImageDetails } from "./compose-state.ts";

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
 * Read-only: `compose images` and `image inspect` only. Never throws: any
 * failure means "no information", never an invented update.
 */
export async function loadImageUpdates(
    provider: ComposeProvider,
    input: { project: string; composeFile: string; cwd: string },
    services: ComposeService[],
): Promise<Record<string, ServiceUpdate>> {
    const updates: Record<string, ServiceUpdate> = {};
    try {
        const candidates = services.filter(service => service.container && service.image && isTagReference(service.image));
        if (candidates.length === 0) return updates;

        const images = await provider.projectImages(input);
        if (images.code !== 0 || images.timedOut || images.truncated) return updates;
        const running = new Map(parseComposeImages(images.stdout).map(row => [row.container, row.imageId]));

        const refs = candidates.map(service => service.image!);
        const ids = candidates.map(service => running.get(service.container!)).filter((id): id is string => Boolean(id));
        // Missing references make the CLI exit non-zero while still printing
        // the others, so parse whatever came back.
        const inspected = await provider.inspectImages([...refs, ...ids]);
        if (inspected.timedOut || inspected.truncated) return updates;
        const details = parseImageInspect(inspected.stdout);
        const byId = new Map(details.map(detail => [detail.id, detail]));

        for (const service of candidates) {
            const runningId = running.get(service.container!);
            const tagged = findByTag(details, service.image!);
            if (!runningId || !tagged || tagged.id === runningId) continue;
            const previous = byId.get(runningId);
            updates[service.name] = {
                image: service.image!,
                from: versionOf(previous),
                to: versionOf(tagged),
                link: linkFor(service.image!, tagged.labels),
            };
        }
    } catch {
        return {};
    }
    return updates;
}

/** A pullable tag, not an image pinned by digest or ID (those never "update"). */
function isTagReference(image: string): boolean {
    return !image.includes("@") && !image.startsWith("sha256:");
}

/** `nginx` → `nginx:latest`; registry prefixes for Docker Hub are dropped like Docker does. */
export function normalizeReference(ref: string): string {
    let value = ref.replace(/^docker\.io\/library\//, "").replace(/^docker\.io\//, "").replace(/^index\.docker\.io\/(library\/)?/, "");
    const lastSlash = value.lastIndexOf("/");
    if (!value.slice(lastSlash + 1).includes(":")) value = `${value}:latest`;
    return value;
}

function findByTag(details: ImageDetails[], ref: string): ImageDetails | undefined {
    const wanted = normalizeReference(ref);
    return details.find(detail => detail.repoTags.some(tag => normalizeReference(tag) === wanted));
}

function versionOf(detail: ImageDetails | undefined): ImageVersion {
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
