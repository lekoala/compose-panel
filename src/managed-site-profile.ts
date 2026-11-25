/**
 * The effective profile of a managed site (ADR 0042, ADR 0043): what the
 * Compose configuration actually declares, projected onto the handful of facts
 * the deploy is allowed to trust. Names and `deploy.kind` prove nothing; the
 * deploy refuses unless the project, the services and the mounts match the
 * manifest exactly.
 *
 * Only booleans, numbers, ports, image references, network names and mount
 * paths leave the projection: the interpolated configuration never does.
 */
import { posix } from "node:path";
import { isExplicitImageReference, MANAGED_SITE_PATHS, managedSitePersistentPath, type ManagedSiteManifest } from "./managed-site.ts";

export interface ManagedSitePortFact {
    hostIp: string | null;
    published: number | null;
    target: number;
    protocol: string | null;
}

export interface ManagedSiteMountFact {
    /** `bind`, `volume`, `tmpfs`, or anything unexpected. */
    type: string | null;
    /** Host path of a bind mount; a volume name; null for tmpfs. */
    source: string | null;
    target: string;
    readOnly: boolean;
}

export interface ManagedSiteServiceFact {
    image: string | null;
    build: boolean;
    networkMode: string | null;
    ports: ManagedSitePortFact[];
    /** Volume entries, including inline `type: tmpfs`. */
    mounts: ManagedSiteMountFact[];
    /** Service-level `tmpfs:` targets. */
    tmpfs: string[];
    /** `volumes_from:` entries; any value refuses a deploy. */
    volumesFrom: string[];
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
        const tmpfs = stringTargets(service.tmpfs);
        if (!tmpfs) return null;
        const volumesFrom = stringList(service.volumes_from);
        if (!volumesFrom) return null;
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
            tmpfs,
            volumesFrom,
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
 *
 * Mount rules are deliberately textual and total: every service in the project
 * is inspected, not only the declared pair, and a mount is refused when its
 * source or target intersects the site tree without being one of the fixed
 * allowed mounts. That closes parent binds (`site/` over `/mnt/site`), indirect
 * aliases of `runtime/releases`, `volumes_from`, and tmpfs overlays that would
 * hide `runtime/current`.
 */
export function checkManagedSiteProfile(input: {
    manifest: ManagedSiteManifest;
    /** Canonical absolute stack directory, identical in the panel and on the host. */
    stackDir: string;
    facts: ManagedSiteComposeFacts;
}): ManagedSiteProfileResult {
    const { manifest, facts } = input;
    const siteTree = posix.join(input.stackDir, "site");
    const runtimeDir = posix.join(input.stackDir, MANAGED_SITE_PATHS.runtime);
    const sharedDir = posix.join(input.stackDir, MANAGED_SITE_PATHS.shared);
    const declaredPaths = (manifest.paths ?? []).map((path) => managedSitePersistentPath(input.stackDir, path));
    // Control files stay outside every container: the manifest, the Compose
    // file and the interpolation file are panel input, not application data.
    const forbiddenFiles = [
        posix.join(input.stackDir, "compose-panel-site.json"),
        posix.join(input.stackDir, "compose.yaml"),
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

    const databaseNetwork = manifest.database?.network ?? null;
    if (databaseNetwork === null) {
        if (facts.externalNetworks.length > 0) {
            return {
                ok: false,
                reason: `The project declares the external network "${facts.externalNetworks[0]}"; a site without a database stays on its own project network.`,
            };
        }
    } else if (facts.externalNetworks.length !== 1 || facts.externalNetworks[0] !== databaseNetwork) {
        return {
            ok: false,
            reason: `The project must declare exactly the external network "${databaseNetwork}" from the database block, and no other.`,
        };
    }
    for (const [name, service] of facts.services) {
        if (service.networkMode !== null) {
            return { ok: false, reason: `The service "${name}" uses network_mode, so the project network is not its boundary.` };
        }
        const external = service.networks.filter((network) => facts.externalNetworks.includes(network));
        for (const network of external) {
            if (databaseNetwork === null || network !== databaseNetwork) {
                return {
                    ok: false,
                    reason: `The service "${name}" joins the external network "${network}"; only the declared database network is allowed.`,
                };
            }
            if (name !== manifest.services.runtime) {
                return { ok: false, reason: `Only the runtime service may join the database network "${network}".` };
            }
        }
    }
    if (databaseNetwork !== null && !runtime.networks.includes(databaseNetwork)) {
        return { ok: false, reason: `The runtime service must join the declared database network "${databaseNetwork}".` };
    }
    const sharedNetworks = gateway.networks.filter(
        (network) => runtime.networks.includes(network) && !facts.externalNetworks.includes(network),
    );
    if (sharedNetworks.length === 0) {
        return { ok: false, reason: "The gateway and runtime services must share a project network." };
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
    if (manifest.owner === "managed" && manifest.gateway && port.published !== manifest.gateway.port) {
        return {
            ok: false,
            reason: `The gateway publishes 127.0.0.1:${port.published}, not the declared 127.0.0.1:${manifest.gateway.port}.`,
        };
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

    for (const [name, service] of facts.services) {
        if (service.volumesFrom.length > 0) {
            return { ok: false, reason: `The service "${name}" uses volumes_from, which mounts paths this profile cannot verify.` };
        }
        const label = name === manifest.services.gateway ? "gateway" : name === manifest.services.runtime ? "runtime" : "";
        for (const mount of service.mounts) {
            const refusal = checkMount(label, mount);
            if (refusal) return refusal;
        }
        for (const target of service.tmpfs) {
            const refusal = checkMount(label, { type: "tmpfs", source: null, target, readOnly: false });
            if (refusal) return refusal;
        }
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
    }

    return { ok: true };

    function checkMount(declaredLabel: "" | "gateway" | "runtime", mount: ManagedSiteMountFact): ManagedSiteProfileResult | null {
        const label = declaredLabel || "additional";
        if (!isCanonicalAbsolute(mount.target)) {
            return { ok: false, reason: `The ${label} service has a container path that is not canonical.` };
        }
        const bind = mount.type === "bind";
        if (bind && (mount.source === null || !isCanonicalAbsolute(mount.source))) {
            return { ok: false, reason: `The ${label} service has a bind source that is not a canonical absolute path.` };
        }
        const sourceTouchesSite = bind && (within(mount.source!, siteTree) || isAncestor(mount.source!, siteTree));
        const targetTouchesSite = within(mount.target, siteTree) || isAncestor(mount.target, siteTree);
        if (bind && forbiddenFiles.includes(mount.source!)) {
            return { ok: false, reason: `The ${label} service mounts a panel control file.` };
        }
        if (!sourceTouchesSite && !targetTouchesSite) return null;

        // Only the declared pair may mount site state, and only these shapes.
        if (declaredLabel === "") {
            return { ok: false, reason: `A service other than the declared gateway and runtime mounts site state.` };
        }
        if (!bind) {
            return { ok: false, reason: `The ${label} service overlays ${MANAGED_SITE_PATHS.runtime} with a non-bind mount.` };
        }
        const source = mount.source!;
        const samePath = mount.target === source;
        if (source === runtimeDir && samePath && mount.readOnly) return null;
        if (declaredLabel === "runtime") {
            if (source === sharedDir && samePath && !mount.readOnly) return null;
            if (!mount.readOnly && samePath && declaredPaths.some((path) => within(source, path))) return null;
        }
        return {
            ok: false,
            reason: `The ${label} service mounts ${MANAGED_SITE_PATHS.runtime}, releases or other site state outside the allowed profile.`,
        };
    }
}

/** Textual canonical form: absolute, already normalized, no `..`, `//` or trailing `/`. */
function isCanonicalAbsolute(value: string): boolean {
    if (!posix.isAbsolute(value)) return false;
    if (value.length > 1 && value.endsWith("/")) return false;
    if (value.includes("//")) return false;
    return posix.normalize(value) === value;
}

function within(path: string, root: string): boolean {
    return path === root || path.startsWith(`${root}/`);
}

/** Whether `path` is a strict ancestor directory of `descendant`. */
function isAncestor(path: string, descendant: string): boolean {
    if (path === descendant) return false;
    if (path === "/") return true;
    return descendant.startsWith(`${path}/`);
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

function stringList(value: unknown): string[] | null {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) return null;
    const items: string[] = [];
    for (const entry of value) {
        if (typeof entry !== "string") return null;
        items.push(entry);
    }
    return items;
}

function stringTargets(value: unknown): string[] | null {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) return null;
    const items: string[] = [];
    for (const entry of value) {
        if (typeof entry === "string") {
            items.push(entry);
            continue;
        }
        const target = record(entry)?.target;
        if (typeof target !== "string") return null;
        items.push(target);
    }
    return items;
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
