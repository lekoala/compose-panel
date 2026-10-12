import type { ImageDetails } from "./compose-state.ts";

export const STACK_LABELS = ["stack.version", "stack.revision", "stack.source", "stack.environment", "stack.branch", "stack.build", "stack.build.url", "stack.url"] as const;
export type DeclaredMetadata = Record<string, Record<string, string>>;

export interface DeployedImage {
    service: string;
    container: string;
    imageId: string;
    digests: string[];
    version: string | null;
    revision: string | null;
    source: string | null;
}

export function metadataText(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const text = value.trim();
    return text.length > 0 && text.length <= 512 && !/[\x00-\x1f\x7f]/.test(text) ? text : null;
}

export function metadataUrl(value: unknown): string | null {
    const text = metadataText(value);
    if (!text) return null;
    try {
        const url = new URL(text);
        return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
    } catch { return null; }
}

/** Explicit projection only; never retain arbitrary config fields or labels. */
export function projectMetadata(value: unknown): DeclaredMetadata | null {
    if (!value || typeof value !== "object") return null;
    const services = (value as { services?: unknown }).services;
    if (!services || typeof services !== "object" || Array.isArray(services)) return null;
    const result: DeclaredMetadata = Object.create(null);
    for (const [name, service] of Object.entries(services)) {
        if (!service || typeof service !== "object") continue;
        const labels = (service as { labels?: Record<string, unknown> }).labels;
        const selected: Record<string, string> = Object.create(null);
        for (const key of STACK_LABELS) {
            const text = metadataText(labels?.[key]);
            if (text) selected[key] = text;
        }
        if (Object.keys(selected).length) result[name] = selected;
    }
    return result;
}

export function deployedImage(service: string, container: string, detail: ImageDetails): DeployedImage {
    return {
        service, container, imageId: detail.id,
        digests: detail.repoDigests.filter(digest => /^[^\s@]+@sha256:[a-f0-9]{64}$/.test(digest)),
        version: metadataText(detail.labels["org.opencontainers.image.version"]),
        revision: metadataText(detail.labels["org.opencontainers.image.revision"]),
        source: metadataUrl(detail.labels["org.opencontainers.image.source"]),
    };
}
