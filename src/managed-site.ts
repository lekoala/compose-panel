/**
 * The managed-site manifest (ADR 0042): trusted operator configuration that
 * lives next to the Compose file and opts one stack into the bind-mount release
 * layout. It is not a security boundary against whoever can write it, but it is
 * parsed strictly so an unknown, duplicated or out-of-range field can never be
 * silently ignored.
 *
 * Paths in this module are relative and POSIX-shaped. The caller joins them
 * with the canonical stack directory it already validated.
 */

export const MANAGED_SITE_MANIFEST_FILE = "compose-panel-site.json";
export const MANAGED_SITE_MANIFEST_MAX_BYTES = 64 * 1024;
export const MANAGED_SITE_VERSION = 1;
export const MANAGED_SITE_PUBLIC_ROOT = "public";
export const MANAGED_SITE_PROFILE = "php-front-controller";
export const MANAGED_SITE_DEPLOY_KIND = "bind-mount";
export const MANAGED_SITE_PATHS_MAX = 16;
export const MANAGED_SITE_PATH_MAX = 255;
export const MANAGED_SITE_GIT_URL_MAX = 2048;
export const MANAGED_SITE_GIT_REF_MAX = 255;
export const MANAGED_SITE_GENERATION_MAX = 32;
/** Generator version this panel knows. A managed site with another version is refused. */
export const MANAGED_SITE_GENERATION = "1";
/** Reserved loopback range for generated site gateways. */
export const MANAGED_SITE_GATEWAY_PORT_MIN = 41000;
export const MANAGED_SITE_GATEWAY_PORT_MAX = 41999;

/**
 * The only runtime images a generated site may declare. A channel pins the
 * image tag; the manifest stores the resolved reference, never the label.
 */
export const MANAGED_SITE_CHANNELS = [
    { id: "php-8.3", label: "PHP 8.3", image: "php:8.3-fpm-alpine" },
    { id: "php-8.4", label: "PHP 8.4", image: "php:8.4-fpm-alpine" },
] as const;

export type ManagedSiteChannelId = (typeof MANAGED_SITE_CHANNELS)[number]["id"];

export function managedSiteChannel(id: string): (typeof MANAGED_SITE_CHANNELS)[number] | null {
    return MANAGED_SITE_CHANNELS.find((channel) => channel.id === id) ?? null;
}

export function isManagedSiteChannelImage(value: string): boolean {
    return MANAGED_SITE_CHANNELS.some((channel) => channel.image === value);
}

/** A gateway port is an integer in the reserved managed-site range. */
export function isManagedSiteGatewayPort(value: number): boolean {
    return Number.isInteger(value) && value >= MANAGED_SITE_GATEWAY_PORT_MIN && value <= MANAGED_SITE_GATEWAY_PORT_MAX;
}
/** Attempt ids name a staging directory and a pending deploy marker. */
export const MANAGED_SITE_ATTEMPT_ID = /^[a-z0-9]{8,40}$/;
export const MANAGED_SITE_OWNERS = ["opt-in", "managed"] as const;
export type ManagedSiteOwner = (typeof MANAGED_SITE_OWNERS)[number];

/** The fixed managed paths below the stack directory (ADR 0042). */
export const MANAGED_SITE_PATHS = {
    generated: "generated",
    staging: "site/staging",
    runtime: "site/runtime",
    releases: "site/runtime/releases",
    current: "site/runtime/current",
    shared: "site/shared",
    private: "site/private",
} as const;

export interface ManagedSiteManifest {
    version: typeof MANAGED_SITE_VERSION;
    siteId: string;
    owner: ManagedSiteOwner;
    /** Exact Compose project name; never assumed from the folder. */
    project: string;
    services: {
        /** Service that publishes the site HTTP endpoint. */
        gateway: string;
        /** Service that runs PHP and must be recreated after a pointer switch. */
        runtime: string;
    };
    /** `managed` only: the fixed loopback port the generated gateway publishes. */
    gateway?: { port: number };
    publicRoot: typeof MANAGED_SITE_PUBLIC_ROOT;
    runtime: {
        profile: typeof MANAGED_SITE_PROFILE;
        /** `managed` only: the runtime owns the image instead of the Compose file. */
        image?: string;
    };
    deploy: {
        kind: typeof MANAGED_SITE_DEPLOY_KIND;
        git: {
            /** Public HTTPS or private SSH URL. Credentials live outside the manifest. */
            url: string;
            /** Fully qualified branch, `refs/heads/...`. */
            ref: string;
        };
    };
    /** `managed` only: declared persistent roots, contained in `shared/`. */
    paths?: string[];
    /** `managed` only: generator version that produced the files on disk. */
    generation?: string;
}

export type ManagedSiteManifestResult = { ok: true; manifest: ManagedSiteManifest } | { ok: false; reason: string };

const SITE_ID = /^[a-z0-9][a-z0-9-]{2,63}$/;
const COMPOSE_PROJECT = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const GENERATION = /^[a-z0-9][a-z0-9.-]{0,31}$/;
const RELEASE_ID = /^[0-9a-f]{40}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const JSON_MAX_DEPTH = 16;

/**
 * A release id is the full lowercase commit SHA. A short or decorated revision
 * is never published, so it can never name a directory.
 */
export function isManagedSiteReleaseId(value: string): boolean {
    return RELEASE_ID.test(value);
}

/** A bounded attempt id: lowercase letters and digits, 8-40 characters. */
export function isManagedSiteAttemptId(value: string): boolean {
    return MANAGED_SITE_ATTEMPT_ID.test(value);
}

/** Relative directory of one published release below the stack directory. */
export function managedSiteReleasePath(releaseId: string): string {
    return `${MANAGED_SITE_PATHS.releases}/${releaseId}`;
}

/** Whether a value is a bounded, relative persistent root below `shared/`. */
export function isManagedSitePath(value: string): boolean {
    if (value.length === 0 || value.length > MANAGED_SITE_PATH_MAX) return false;
    if (CONTROL.test(value) || value.includes("\\")) return false;
    if (value.startsWith("/") || value.endsWith("/")) return false;
    const segments = value.split("/");
    if (segments.length < 2) return false;
    if (segments[0] !== "shared") return false;
    return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

/**
 * Host path of a declared persistent root. The manifest stores paths relative
 * to `site/` (`shared/uploads`), and the layout keeps them under
 * `<stack>/site/shared`; generator and profile must use this one function.
 */
export function managedSitePersistentPath(stackDir: string, path: string): string {
    if (!isManagedSitePath(path)) throw new Error("The persistent path is not valid.");
    return `${stackDir}/${MANAGED_SITE_PATHS.shared}/${path.slice("shared/".length)}`;
}

/**
 * A fully qualified branch: `refs/heads/...`, no wildcard, no ambiguous short
 * name, nothing `git check-ref-format` would refuse.
 */
export function isValidDeployRef(value: string): boolean {
    if (value.length === 0 || value.length > MANAGED_SITE_GIT_REF_MAX) return false;
    if (CONTROL.test(value)) return false;
    const prefix = "refs/heads/";
    if (!value.startsWith(prefix)) return false;
    const branch = value.slice(prefix.length);
    if (branch.length === 0 || branch === "@") return false;
    if (!/^[A-Za-z0-9._/-]+$/.test(branch)) return false;
    if (branch.startsWith("/") || branch.endsWith("/") || branch.endsWith(".")) return false;
    if (branch.includes("..") || branch.includes("//") || branch.includes("@{")) return false;
    // `git check-ref-format` refuses a dot-prefixed component and any component
    // ending in `.lock`, at every level, not only the last one.
    return branch.split("/").every((segment) => segment.length > 0 && !segment.startsWith(".") && !segment.endsWith(".lock"));
}

/** Validate the literal URL that Git will receive and select its only allowed transport. */
export function deployGitTransport(value: string): "https" | "ssh" | null {
    if (value.length === 0 || value.length > MANAGED_SITE_GIT_URL_MAX || CONTROL.test(value) || /\s/.test(value)) return null;
    if (value.startsWith("ssh://")) {
        // Match the original string: URL normalization could hide traversal,
        // encoded delimiters or an ambiguous SSH destination from validation.
        const match = /^ssh:\/\/([a-z0-9_][a-z0-9_.-]*)@([a-z0-9.-]+)(?::([0-9]{1,5}))?((?:\/[a-z0-9_.-]+)+)$/i.exec(value);
        if (!match) return null;
        const [, , host, port, path] = match;
        if (!host || host.length > 253 || !host.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) {
            return null;
        }
        if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) return null;
        if (!path || path.split("/").some((segment) => segment === "." || segment === "..")) return null;
        return "ssh";
    }
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return null;
    }
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return null;
    return url.hostname.length > 0 ? "https" : null;
}

export function isValidDeployGitUrl(value: string): boolean {
    return deployGitTransport(value) !== null;
}

/**
 * Parse `compose-panel-site.json`. Every rule of ADR 0042 is enforced here, so
 * a caller only has to deal with "valid manifest" or "refused, with a reason".
 */
export function parseManagedSiteManifest(source: string): ManagedSiteManifestResult {
    if (source.length === 0) return { ok: false, reason: "The site manifest is empty." };
    if (Buffer.byteLength(source, "utf8") > MANAGED_SITE_MANIFEST_MAX_BYTES) {
        return { ok: false, reason: "The site manifest is larger than 64 KiB." };
    }
    const parsed = parseStrictJson(source);
    if (!parsed.ok) return parsed;
    const root = asRecord(parsed.value);
    if (!root) return { ok: false, reason: "The site manifest must be a JSON object." };

    const unknown = unknownField(
        root,
        ["version", "siteId", "owner", "project", "services", "gateway", "publicRoot", "runtime", "deploy", "paths", "generation"],
        "",
    );
    if (unknown) return unknown;

    if (root.version !== MANAGED_SITE_VERSION) {
        return { ok: false, reason: `The site manifest version must be ${MANAGED_SITE_VERSION}.` };
    }

    const siteId = asString(root.siteId);
    if (!siteId || !SITE_ID.test(siteId)) {
        return {
            ok: false,
            reason: "siteId must be 3-64 characters of lowercase letters, digits or dashes, starting with a letter or digit.",
        };
    }

    const owner = MANAGED_SITE_OWNERS.find((candidate) => candidate === root.owner);
    if (!owner) return { ok: false, reason: 'owner must be "opt-in" or "managed".' };

    const project = asString(root.project);
    if (!project || !COMPOSE_PROJECT.test(project)) {
        return { ok: false, reason: "project must be the exact lowercase Compose project name, 1-63 characters." };
    }

    const services = asRecord(root.services);
    if (!services) return { ok: false, reason: "services must be an object naming the gateway and runtime services." };
    const servicesUnknown = unknownField(services, ["gateway", "runtime"], "services.");
    if (servicesUnknown) return servicesUnknown;
    const gateway = asString(services.gateway);
    const runtimeService = asString(services.runtime);
    if (!gateway || !isComposeServiceNameSafe(gateway)) {
        return { ok: false, reason: "services.gateway must be a Compose service name." };
    }
    if (!runtimeService || !isComposeServiceNameSafe(runtimeService)) {
        return { ok: false, reason: "services.runtime must be a Compose service name." };
    }
    if (gateway === runtimeService) {
        return { ok: false, reason: "services.gateway and services.runtime must name two different services." };
    }

    let gatewayPort: number | undefined;
    if (root.gateway !== undefined) {
        if (owner !== "managed") {
            return { ok: false, reason: 'gateway belongs to owner "managed": an opt-in stack owns its published port.' };
        }
        const candidate = asRecord(root.gateway);
        if (!candidate) return { ok: false, reason: "gateway must be an object with a port." };
        const gatewayUnknown = unknownField(candidate, ["port"], "gateway.");
        if (gatewayUnknown) return gatewayUnknown;
        if (!isManagedSiteGatewayPort(candidate.port as number)) {
            return {
                ok: false,
                reason: `gateway.port must be a whole number between ${MANAGED_SITE_GATEWAY_PORT_MIN} and ${MANAGED_SITE_GATEWAY_PORT_MAX}.`,
            };
        }
        gatewayPort = candidate.port as number;
    }
    if (owner === "managed" && gatewayPort === undefined) {
        return { ok: false, reason: 'gateway.port is required for owner "managed".' };
    }

    if (root.publicRoot !== MANAGED_SITE_PUBLIC_ROOT) {
        return { ok: false, reason: `publicRoot must be "${MANAGED_SITE_PUBLIC_ROOT}" in version 1.` };
    }

    const runtime = asRecord(root.runtime);
    if (!runtime) return { ok: false, reason: "runtime must be an object." };
    const runtimeUnknown = unknownField(runtime, ["profile", "image"], "runtime.");
    if (runtimeUnknown) return runtimeUnknown;
    if (runtime.profile !== MANAGED_SITE_PROFILE) {
        return { ok: false, reason: `runtime.profile must be "${MANAGED_SITE_PROFILE}" in version 1.` };
    }
    let image: string | undefined;
    if (runtime.image !== undefined) {
        const candidate = asString(runtime.image);
        if (!candidate || !isExplicitImageReference(candidate)) {
            return { ok: false, reason: "runtime.image must be an explicit image reference with a tag or a digest." };
        }
        if (owner === "managed" && !isManagedSiteChannelImage(candidate)) {
            return {
                ok: false,
                reason: `runtime.image must be one of the pinned managed-site channels: ${MANAGED_SITE_CHANNELS.map((channel) => channel.image).join(", ")}.`,
            };
        }
        image = candidate;
    }
    if (owner === "opt-in" && image !== undefined) {
        return { ok: false, reason: 'runtime.image belongs to owner "managed": the Compose file owns the image of an opt-in stack.' };
    }
    if (owner === "managed" && image === undefined) {
        return { ok: false, reason: 'runtime.image is required for owner "managed".' };
    }

    const deploy = asRecord(root.deploy);
    if (!deploy) return { ok: false, reason: "deploy must be an object." };
    const deployUnknown = unknownField(deploy, ["kind", "git"], "deploy.");
    if (deployUnknown) return deployUnknown;
    if (deploy.kind !== MANAGED_SITE_DEPLOY_KIND) {
        return { ok: false, reason: `deploy.kind must be "${MANAGED_SITE_DEPLOY_KIND}" in version 1.` };
    }
    const git = asRecord(deploy.git);
    if (!git) return { ok: false, reason: "deploy.git must be an object." };
    const gitUnknown = unknownField(git, ["url", "ref"], "deploy.git.");
    if (gitUnknown) return gitUnknown;
    const url = asString(git.url);
    if (!url || !isValidDeployGitUrl(url)) {
        return {
            ok: false,
            reason: "deploy.git.url must be a public HTTPS URL or an ssh://user@host/repository URL without a password, query or fragment.",
        };
    }
    const ref = asString(git.ref);
    if (!ref || !isValidDeployRef(ref)) {
        return { ok: false, reason: 'deploy.git.ref must be a fully qualified branch such as "refs/heads/main".' };
    }

    let paths: string[] | undefined;
    if (root.paths !== undefined) {
        if (owner !== "managed") {
            return { ok: false, reason: 'paths belong to owner "managed".' };
        }
        if (!Array.isArray(root.paths) || root.paths.length > MANAGED_SITE_PATHS_MAX) {
            return { ok: false, reason: `paths must be an array of at most ${MANAGED_SITE_PATHS_MAX} entries.` };
        }
        const declared: string[] = [];
        for (const entry of root.paths) {
            const candidate = asString(entry);
            if (!candidate || !isManagedSitePath(candidate)) {
                return { ok: false, reason: 'Each paths entry must be a relative path below shared/ without ".." or empty segments.' };
            }
            if (declared.includes(candidate)) {
                return { ok: false, reason: "paths must not repeat an entry." };
            }
            declared.push(candidate);
        }
        paths = declared;
    }

    let generation: string | undefined;
    if (root.generation !== undefined) {
        if (owner !== "managed") {
            return { ok: false, reason: 'generation belongs to owner "managed".' };
        }
        const candidate = asString(root.generation);
        if (!candidate || !GENERATION.test(candidate)) {
            return {
                ok: false,
                reason: `generation must be 1-${MANAGED_SITE_GENERATION_MAX} characters of lowercase letters, digits, dots or dashes.`,
            };
        }
        generation = candidate;
    }
    if (owner === "managed" && generation === undefined) {
        return { ok: false, reason: 'generation is required for owner "managed".' };
    }

    const manifest: ManagedSiteManifest = {
        version: MANAGED_SITE_VERSION,
        siteId,
        owner,
        project,
        services: { gateway, runtime: runtimeService },
        ...(gatewayPort === undefined ? {} : { gateway: { port: gatewayPort } }),
        publicRoot: MANAGED_SITE_PUBLIC_ROOT,
        runtime: image === undefined ? { profile: MANAGED_SITE_PROFILE } : { profile: MANAGED_SITE_PROFILE, image },
        deploy: { kind: MANAGED_SITE_DEPLOY_KIND, git: { url, ref } },
        ...(paths ? { paths } : {}),
        ...(generation ? { generation } : {}),
    };
    return { ok: true, manifest };
}

/** Compose service names, validated locally to avoid a provider import cycle. */
function isComposeServiceNameSafe(value: string): boolean {
    return /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,128}$/.test(value);
}

/** An image reference that is not a bare repository: it carries a tag or digest. */
export function isExplicitImageReference(value: string): boolean {
    if (!/^[a-z0-9][a-z0-9._/:@-]{0,254}$/i.test(value)) return false;
    const [reference, digest] = value.split("@");
    if (digest !== undefined) return /^sha256:[0-9a-f]{64}$/.test(digest);
    const lastColon = reference!.lastIndexOf(":");
    if (lastColon <= reference!.lastIndexOf("/")) return false;
    // A trailing colon names no tag: `php:` must not pass as "explicit".
    return /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(reference!.slice(lastColon + 1));
}

function unknownField(record: Record<string, unknown>, allowed: readonly string[], prefix: string): { ok: false; reason: string } | null {
    for (const key of Object.keys(record)) {
        if (!allowed.includes(key)) return { ok: false, reason: `Unknown field "${prefix}${key}" in the site manifest.` };
    }
    return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
    return typeof value === "string" ? value : null;
}

type StrictJson = { ok: true; value: unknown } | { ok: false; reason: string };

/**
 * Strict JSON for the manifest. `JSON.parse` silently keeps the last duplicate
 * key, so it cannot enforce ADR 0042 alone. This parser also bounds nesting,
 * refuses trailing content and never creates an object with a prototype, so a
 * `__proto__` field stays an ordinary refused key.
 */
function parseStrictJson(source: string): StrictJson {
    let index = 0;

    const fail = (reason: string): StrictJson => ({ ok: false, reason });
    const invalid = () => fail("The site manifest is not valid JSON.");

    const skipWhitespace = () => {
        while (index < source.length) {
            const character = source[index];
            if (character === " " || character === "\t" || character === "\n" || character === "\r") index++;
            else break;
        }
    };

    const parseString = (): StrictJson => {
        const start = index;
        index++;
        while (index < source.length) {
            const character = source[index];
            if (character === "\\") {
                index += 2;
                continue;
            }
            if (character === '"') {
                index++;
                const token = source.slice(start, index);
                try {
                    return { ok: true, value: JSON.parse(token) };
                } catch {
                    return invalid();
                }
            }
            if (character === "\n" || character === "\r") return invalid();
            index++;
        }
        return invalid();
    };

    const parseNumber = (): StrictJson => {
        const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(index));
        if (!match) return invalid();
        index += match[0].length;
        const value = Number(match[0]);
        return Number.isFinite(value) ? { ok: true, value } : invalid();
    };

    const parseArray = (depth: number): StrictJson => {
        if (depth > JSON_MAX_DEPTH) return fail("The site manifest is nested too deeply.");
        const values: unknown[] = [];
        index++;
        skipWhitespace();
        if (source[index] === "]") {
            index++;
            return { ok: true, value: values };
        }
        for (;;) {
            const value = parseValue(depth);
            if (!value.ok) return value;
            values.push(value.value);
            skipWhitespace();
            const separator = source[index];
            if (separator === ",") {
                index++;
                continue;
            }
            if (separator === "]") {
                index++;
                return { ok: true, value: values };
            }
            return invalid();
        }
    };

    const parseObject = (depth: number): StrictJson => {
        if (depth > JSON_MAX_DEPTH) return fail("The site manifest is nested too deeply.");
        const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
        index++;
        skipWhitespace();
        if (source[index] === "}") {
            index++;
            return { ok: true, value: values };
        }
        for (;;) {
            skipWhitespace();
            if (source[index] !== '"') return invalid();
            const key = parseString();
            if (!key.ok) return key;
            const name = key.value as string;
            if (Object.prototype.hasOwnProperty.call(values, name)) return fail(`The site manifest repeats the field "${name}".`);
            skipWhitespace();
            if (source[index] !== ":") return invalid();
            index++;
            const value = parseValue(depth);
            if (!value.ok) return value;
            values[name] = value.value;
            skipWhitespace();
            const separator = source[index];
            if (separator === ",") {
                index++;
                continue;
            }
            if (separator === "}") {
                index++;
                return { ok: true, value: values };
            }
            return invalid();
        }
    };

    const parseValue = (depth: number): StrictJson => {
        if (depth > JSON_MAX_DEPTH) return fail("The site manifest is nested too deeply.");
        skipWhitespace();
        const character = source[index];
        if (character === "{") return parseObject(depth + 1);
        if (character === "[") return parseArray(depth + 1);
        if (character === '"') return parseString();
        if (source.startsWith("true", index)) {
            index += 4;
            return { ok: true, value: true };
        }
        if (source.startsWith("false", index)) {
            index += 5;
            return { ok: true, value: false };
        }
        if (source.startsWith("null", index)) {
            index += 4;
            return { ok: true, value: null };
        }
        if (character === "-" || (character !== undefined && character >= "0" && character <= "9")) return parseNumber();
        return invalid();
    };

    const value = parseValue(0);
    if (!value.ok) return value;
    skipWhitespace();
    if (index !== source.length) return invalid();
    return value;
}
