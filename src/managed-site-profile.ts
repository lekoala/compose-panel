/**
 * The effective profile of a managed site (ADR 0042, ADR 0043): what the
 * Compose configuration actually declares, projected onto the handful of facts
 * the deploy is allowed to trust. Names and `deploy.kind` prove nothing; the
 * deploy refuses unless the gateway, the runtime and the mounts match the
 * manifest exactly.
 *
 * Only booleans, numbers, ports, image references, network names and mount
 * paths leave the projection: the interpolated configuration never does.
 */
import { posix } from "node:path";
import { isExplicitImageReference, MANAGED_SITE_PATHS, type ManagedSiteManifest } from "./managed-site.ts";

export interface ManagedSitePortFact {
    hostIp: string | null;
    published: number | null;
    target: number;
    protocol: string | null;
}

export interface ManagedSiteMountFact {
    type: string | null;
    source: string | null;
    target: string;
    readOnly: boolean;
}

export interface ManagedSiteServiceFact {
    image: string | null;
    build: boolean;
    networkMode: string | null;
    ports: ManagedSitePortFact[];
    mounts: ManagedSiteMountFact[];
    networks: string[];
}

export interface ManagedSiteComposeFacts {
    /** Effective project name reported by `config --format json`. */
    name: string | null;
    services: Map<string, ManagedSiteServiceFact>;
    /** Top-level networks marked `external: true`. */
    externalNetworks: string[];
}

export type ManagedSiteProfileResult = { ok: true } | { ok: false; reason: string };

const SERVICE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,128}$/;
const NETWORK_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,128}$/;
const TOP_LEVEL_PROJECT_FILE = "compose.yaml";

/**
 * Project the effective configuration onto the allow-listed profile facts.
 * `null` on any unexpected shape: the deploy refuses rather than guess.
 */
export function parseManagedSiteComposeFacts(stdout: string): ManagedSiteComposeFacts | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(stdout);
    } catch {
        return null;
    }
    const root = record(parsed);
    if (!root) return null;
    const services = record(root.services);
    if (!services) return null;

    const facts = new Map<string, ManagedSiteServiceFact>();
    for (const [name, rawService] of Object.entries(services)) {
        if (!SERVICE_NAME.test(name)) return null;
        const service = record(rawService);
        if (!service) return null;
        const ports = entries(service.ports, portFact);
        if (!ports) return null;
        const mounts = entries(service.volumes, mountFact);
        if (!mounts) return null;
        const networks = networkNames(service.networks);
        if (!networks) return null;
        facts.set(name, {
            image: typeof service.image === "string" && service.image.length > 0 ? service.image : null,
            build: service.build !== undefined && service.build !== null,
            networkMode:
                typeof service.network_mode === "string"
                    ? service.network_mode
                    : service.network_mode === undefined || service.network_mode === null
                      ? null
                      : "__invalid__",
            ports,
            mounts,
            networks,
        });
    }

    const networks = record(root.networks);
    const externalNetworks: string[] = [];
    if (networks) {
        for (const [name, rawNetwork] of Object.entries(networks)) {
            if (!NETWORK_NAME.test(name)) return null;
            if (rawNetwork === null) continue;
            const network = record(rawNetwork);
            if (!network) return null;
            if (network.external === true || record(network.external) !== null) externalNetworks.push(name);
        }
    }

    return {
        name: typeof root.name === "string" && root.name.length > 0 ? root.name : null,
        services: facts,
        externalNetworks,
    };
}

/**
 * Verify the facts against the manifest before anything is fetched, stopped or
 * recreated. Every refusal names the manifest rule that failed.
 */
export function checkManagedSiteProfile(input: {
    manifest: ManagedSiteManifest;
    /** Canonical absolute stack directory, identical in the panel and on the host. */
    stackDir: string;
    facts: ManagedSiteComposeFacts;
}): ManagedSiteProfileResult {
    const { manifest, facts } = input;
    const runtimeDir = posix.join(input.stackDir, MANAGED_SITE_PATHS.runtime);
    const stagingDir = posix.join(input.stackDir, MANAGED_SITE_PATHS.staging);
    const privateDir = posix.join(input.stackDir, MANAGED_SITE_PATHS.private);
    const forbiddenSources = [
        stagingDir,
        privateDir,
        posix.join(input.stackDir, "compose-panel-site.json"),
        posix.join(input.stackDir, TOP_LEVEL_PROJECT_FILE),
        posix.join(input.stackDir, ".env"),
    ];

    if (facts.name !== manifest.project) {
        return { ok: false, reason: `The effective Compose project is not the declared project "${manifest.project}".` };
    }

    const gateway = facts.services.get(manifest.services.gateway);
    if (!gateway) {
        return { ok: false, reason: `The gateway service "${manifest.services.gateway}" is not in the effective Compose configuration.` };
    }
    const runtime = facts.services.get(manifest.services.runtime);
    if (!runtime) {
        return { ok: false, reason: `The runtime service "${manifest.services.runtime}" is not in the effective Compose configuration.` };
    }

    if (gateway.networkMode !== null) {
        return { ok: false, reason: "The gateway service uses network_mode, so its published port is not the site endpoint." };
    }
    if (runtime.networkMode !== null) {
        return { ok: false, reason: "The runtime service uses network_mode, which leaves the site network." };
    }
    const external = [...new Set([...gateway.networks, ...runtime.networks])].filter((name) => facts.externalNetworks.includes(name));
    if (external.length > 0) {
        return {
            ok: false,
            reason: `The gateway or runtime joins the external network "${external[0]}"; a site stays on its own project network.`,
        };
    }

    if (gateway.ports.length !== 1) {
        return { ok: false, reason: "The gateway service must publish exactly one TCP port." };
    }
    const port = gateway.ports[0]!;
    if (port.protocol !== null && port.protocol !== "tcp") {
        return { ok: false, reason: "The gateway service must publish a TCP port." };
    }
    if (port.hostIp !== "127.0.0.1") {
        return { ok: false, reason: "The gateway service must publish on 127.0.0.1 only." };
    }
    if (port.published === null) {
        return { ok: false, reason: "The gateway port needs an explicit loopback port number." };
    }
    if (runtime.ports.length > 0) {
        return { ok: false, reason: "The runtime service must not publish any port." };
    }

    if (runtime.build) {
        return { ok: false, reason: "The runtime service builds an image; only an explicit image reference is deployable." };
    }
    if (runtime.image === null) {
        return { ok: false, reason: "The runtime service declares no image." };
    }
    if (!isExplicitImageReference(runtime.image)) {
        return { ok: false, reason: "The runtime image must carry an explicit tag or digest." };
    }

    for (const [label, service] of [
        ["gateway", gateway],
        ["runtime", runtime],
    ] as const) {
        const mounting = service.mounts.filter((mount) => mount.source === runtimeDir && mount.target === runtimeDir);
        if (mounting.length !== 1 || mounting[0]!.type !== "bind") {
            return {
                ok: false,
                reason: `The ${label} service must bind ${MANAGED_SITE_PATHS.runtime} at the same host and container path.`,
            };
        }
        if (!mounting[0]!.readOnly) {
            return { ok: false, reason: `The ${label} service must mount ${MANAGED_SITE_PATHS.runtime} read-only.` };
        }
        const accepted = mounting[0]!;
        for (const mount of service.mounts) {
            if (mount === accepted) continue;
            if (mount.target === `${runtimeDir}/current` || mount.target.startsWith(`${runtimeDir}/current/`)) {
                return { ok: false, reason: `The ${label} service mounts at or below current, which would pin or mask the release.` };
            }
            // A second mount anywhere inside runtime/ would hide a release path
            // (the whole runtime, or one directory of it) from the process.
            if (within(mount.target, runtimeDir)) {
                return {
                    ok: false,
                    reason: `The ${label} service mounts over part of ${MANAGED_SITE_PATHS.runtime}, which would mask the release.`,
                };
            }
            const source = mount.source;
            if (source !== null && forbiddenSources.some((forbidden) => within(source, forbidden))) {
                return { ok: false, reason: `The ${label} service mounts staging or private site state.` };
            }
            if (forbiddenSources.some((forbidden) => within(mount.target, forbidden))) {
                return { ok: false, reason: `The ${label} service mounts staging or private site state.` };
            }
        }
    }

    return { ok: true };
}

function within(path: string, root: string): boolean {
    return path === root || path.startsWith(`${root}/`);
}

function record(value: unknown): Record<string, unknown> | null {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function entries<T>(value: unknown, convert: (entry: unknown) => T | null): T[] | null {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) return null;
    const converted: T[] = [];
    for (const entry of value) {
        const item = convert(entry);
        if (item === null) return null;
        converted.push(item);
    }
    return converted;
}

function portFact(entry: unknown): ManagedSitePortFact | null {
    if (typeof entry === "string") return shortPort(entry);
    const value = record(entry);
    if (!value) return null;
    const target = portNumber(value.target);
    if (target === null) return null;
    const published = value.published === undefined || value.published === null ? null : portNumber(value.published);
    if (value.published !== undefined && value.published !== null && published === null) return null;
    const hostIp =
        typeof value.host_ip === "string" ? value.host_ip : value.host_ip === undefined || value.host_ip === null ? null : "__invalid__";
    const protocol =
        typeof value.protocol === "string"
            ? value.protocol
            : value.protocol === undefined || value.protocol === null
              ? null
              : "__invalid__";
    return { hostIp, published, target, protocol };
}

function shortPort(value: string): ManagedSitePortFact | null {
    const [spec, protocolValue] = value.split("/");
    if (protocolValue !== undefined && protocolValue !== "tcp" && protocolValue !== "udp") return null;
    const parts = spec!.split(":");
    if (parts.length === 0 || parts.length > 3) return null;
    const hostIp = parts.length === 3 ? parts[0]! : null;
    const publishedPart = parts.length >= 2 ? parts[parts.length - 2]! : null;
    const targetPart = parts[parts.length - 1]!;
    if (hostIp !== null && !/^[0-9A-Za-z.]+$/.test(hostIp)) return null;
    if (publishedPart !== null && !/^\d{1,5}$/.test(publishedPart)) return null;
    if (!/^\d{1,5}$/.test(targetPart)) return null;
    const target = portNumber(targetPart);
    if (target === null) return null;
    const published = publishedPart === null ? null : portNumber(publishedPart);
    if (publishedPart !== null && published === null) return null;
    return { hostIp, published, target, protocol: protocolValue ?? "tcp" };
}

function portNumber(value: unknown): number | null {
    const candidate = typeof value === "number" ? value : typeof value === "string" && /^\d{1,5}$/.test(value) ? Number(value) : Number.NaN;
    return Number.isInteger(candidate) && candidate >= 1 && candidate <= 65535 ? candidate : null;
}

function mountFact(entry: unknown): ManagedSiteMountFact | null {
    if (typeof entry === "string") {
        const parts = entry.split(":");
        if (parts.length < 2) return null;
        const source = parts[0]!;
        const target = parts[1]!;
        return {
            type: source.startsWith("/") || source.startsWith(".") ? "bind" : "volume",
            source,
            target,
            readOnly: parts.slice(2).includes("ro"),
        };
    }
    const value = record(entry);
    if (!value || typeof value.target !== "string") return null;
    if (value.source !== undefined && value.source !== null && typeof value.source !== "string") return null;
    return {
        type: typeof value.type === "string" ? value.type : null,
        source: typeof value.source === "string" ? value.source : null,
        target: value.target,
        readOnly: value.read_only === true,
    };
}

function networkNames(value: unknown): string[] | null {
    if (value === undefined || value === null) return [];
    const names: string[] = [];
    if (Array.isArray(value)) {
        for (const entry of value) {
            if (typeof entry !== "string" || !NETWORK_NAME.test(entry)) return null;
            names.push(entry);
        }
        return names;
    }
    const networks = record(value);
    if (!networks) return null;
    for (const name of Object.keys(networks)) {
        if (!NETWORK_NAME.test(name)) return null;
        names.push(name);
    }
    return names;
}
