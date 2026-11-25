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
/** The database attachment adds the optional `database` block (ADR 0048). */
export const MANAGED_SITE_DATABASE_VERSION = 2;
/** The backup slice adds the optional `backup` block (ADR 0049). */
export const MANAGED_SITE_BACKUP_VERSION = 3;
/** The CI slice also lands in manifest version 3 (ADR 0050). */
export const MANAGED_SITE_CI_VERSION = 3;
export const MANAGED_SITE_VERSIONS = [MANAGED_SITE_VERSION, MANAGED_SITE_DATABASE_VERSION, MANAGED_SITE_BACKUP_VERSION] as const;
export type ManagedSiteVersion = (typeof MANAGED_SITE_VERSIONS)[number];
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
/** Generation that adds the database fragment to a managed site (ADR 0048). */
export const MANAGED_SITE_DATABASE_GENERATION = "2";
export const MANAGED_SITE_GENERATIONS = [MANAGED_SITE_GENERATION, MANAGED_SITE_DATABASE_GENERATION] as const;
/** The only existing-database engines the manifest may declare. */
export const MANAGED_SITE_DATABASE_KINDS = ["existing"] as const;
export const MANAGED_SITE_DATABASE_ENGINES = ["mariadb", "mysql", "postgresql"] as const;
export const MANAGED_SITE_DATABASE_NETWORK_MAX = 128;
/** Fixed private file read by Compose at container creation; never by the panel. */
export const MANAGED_SITE_DATABASE_ENV_FILE = "database.env";
export const MANAGED_SITE_DATABASE_ENV_MAX_BYTES = 64 * 1024;
/** Reserved loopback range for generated site gateways. */
export const MANAGED_SITE_GATEWAY_PORT_MIN = 41000;
export const MANAGED_SITE_GATEWAY_PORT_MAX = 41999;

/**
 * The only runtime images a generated site may declare. A channel pins the
 * image tag; the manifest stores the resolved reference, never the label.
 */
export const MANAGED_SITE_CHANNELS = [
    { id: "php-8.3", label: "PHP 8.3", image: "php:8.3-fpm-alpine", phpMinor: "8.3" },
    { id: "php-8.4", label: "PHP 8.4", image: "php:8.4-fpm-alpine", phpMinor: "8.4" },
] as const;

export type ManagedSiteChannelId = (typeof MANAGED_SITE_CHANNELS)[number]["id"];

export function managedSiteChannel(id: string): (typeof MANAGED_SITE_CHANNELS)[number] | null {
    return MANAGED_SITE_CHANNELS.find((channel) => channel.id === id) ?? null;
}

/** The channel a pinned runtime image belongs to, or null for any other image. */
export function managedSiteChannelForImage(image: string): (typeof MANAGED_SITE_CHANNELS)[number] | null {
    return MANAGED_SITE_CHANNELS.find((channel) => channel.image === image) ?? null;
}

export function isManagedSiteChannelImage(value: string): boolean {
    return managedSiteChannelForImage(value) !== null;
}

/** The only release preparation a managed site may declare (ADR 0045). */
export const MANAGED_SITE_BUILD_KINDS = ["composer"] as const;
export type ManagedSiteBuildKind = (typeof MANAGED_SITE_BUILD_KINDS)[number];

/** The only offsite backup backend a managed site may declare (ADR 0049). */
export const MANAGED_SITE_BACKUP_KINDS = ["restic"] as const;
export type ManagedSiteBackupKind = (typeof MANAGED_SITE_BACKUP_KINDS)[number];
/** The SQL adapters this panel knows. Files-only backup needs no engine. */
export const MANAGED_SITE_BACKUP_SQL_ENGINES = ["mariadb"] as const;
export type ManagedSiteBackupSqlEngine = (typeof MANAGED_SITE_BACKUP_SQL_ENGINES)[number];
export const MANAGED_SITE_BACKUP_REPOSITORY_MAX = 512;
export const MANAGED_SITE_BACKUP_DATABASE_MAX = 64;

export interface ManagedSiteBackupSql {
    engine: ManagedSiteBackupSqlEngine;
    /** Exact database to dump; one bounded identifier, never a pattern. */
    database: string;
}

/** The only machine credential a scheduled backup may declare (ADR 0051). */
export const MANAGED_SITE_BACKUP_TRIGGER_KINDS = ["token"] as const;
export type ManagedSiteBackupTriggerKind = (typeof MANAGED_SITE_BACKUP_TRIGGER_KINDS)[number];
export const MANAGED_SITE_BACKUP_TRIGGER_MIN_HOURS = 1;
export const MANAGED_SITE_BACKUP_TRIGGER_MAX_HOURS = 720;

export interface ManagedSiteBackupTrigger {
    /** One bearer token, verified against a stored digest. */
    kind: ManagedSiteBackupTriggerKind;
    /**
     * Declared maximum age of the last verified backup before the panel reports
     * it overdue. It is not a schedule: the host timer is the only scheduler.
     */
    everyHours: number;
}

/** The only retention counts the panel forwards to a read-only Restic preview (ADR 0052). */
export const MANAGED_SITE_BACKUP_RETENTION_KEYS = ["keepLast", "keepDaily", "keepWeekly", "keepMonthly"] as const;
export type ManagedSiteBackupRetentionKey = (typeof MANAGED_SITE_BACKUP_RETENTION_KEYS)[number];
export const MANAGED_SITE_BACKUP_RETENTION_MAX: Record<ManagedSiteBackupRetentionKey, number> = {
    keepLast: 100,
    keepDaily: 365,
    keepWeekly: 104,
    keepMonthly: 120,
};

/**
 * A declared prune policy. It is used only to run `restic forget --dry-run`;
 * it authorizes no deletion and the panel reimplements no calendar rule.
 */
export type ManagedSiteBackupRetention = Partial<Record<ManagedSiteBackupRetentionKey, number>>;

export interface ManagedSiteBackup {
    kind: ManagedSiteBackupKind;
    /** `rest:https://host/path`; `rest:http://` only on a private/loopback host. */
    repository: string;
    sql?: ManagedSiteBackupSql;
    /** Optional policy measured by the read-only retention preview (ADR 0052). */
    retention?: ManagedSiteBackupRetention;
    /** Optional machine request path for an administrator-installed timer. */
    trigger?: ManagedSiteBackupTrigger;
}

const BACKUP_DATABASE = /^[A-Za-z0-9_$][A-Za-z0-9_$-]{0,63}$/;
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1", "[::1]"];

/** One bounded SQL identifier, passed as a separate argument and never quoted by the panel. */
export function isManagedSiteBackupDatabase(value: string): boolean {
    return value.length > 0 && value.length <= MANAGED_SITE_BACKUP_DATABASE_MAX && BACKUP_DATABASE.test(value);
}

/**
 * A Restic REST repository URL. TLS is required except for a loopback or
 * single-label Compose service name, which keeps the disposable lab on a
 * private network without allowing a plaintext production endpoint.
 */
export function isManagedSiteBackupRepository(value: string): boolean {
    if (value.length === 0 || value.length > MANAGED_SITE_BACKUP_REPOSITORY_MAX) return false;
    if (CONTROL.test(value) || /\s/.test(value)) return false;
    const prefix = value.startsWith("rest:https://") ? "rest:https://" : value.startsWith("rest:http://") ? "rest:http://" : null;
    if (!prefix) return false;
    const remainder = value.slice(prefix.length);
    if (remainder.includes("\\")) return false;
    const slash = remainder.indexOf("/");
    if (slash <= 0) return false;
    // URL parsing would resolve `.` and `..` away; refuse them in the original
    // string so a repository path cannot be silently rewritten.
    const rawSegments = remainder
        .slice(slash)
        .split("/")
        .filter((segment) => segment.length > 0);
    if (rawSegments.length === 0) return false;
    if (rawSegments.some((segment) => segment === "." || segment === "..")) return false;
    let url: URL;
    try {
        // Parse the remainder as HTTPS so URL normalization is available; the
        // original string stays authoritative for storage and display.
        url = new URL(`https://${remainder}`);
    } catch {
        return false;
    }
    if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return false;
    if (!url.hostname || url.hostname.length > 253) return false;
    if (prefix === "rest:http://" && !LOOPBACK_HOSTS.includes(url.hostname) && url.hostname.includes(".")) return false;
    const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
    if (segments.length === 0) return false;
    return segments.every((segment) => segment !== "." && segment !== ".." && /^[A-Za-z0-9._~-]+$/.test(segment));
}

export type ManagedSiteDatabaseKind = (typeof MANAGED_SITE_DATABASE_KINDS)[number];
export type ManagedSiteDatabaseEngine = (typeof MANAGED_SITE_DATABASE_ENGINES)[number];
export interface ManagedSiteDatabase {
    kind: ManagedSiteDatabaseKind;
    engine: ManagedSiteDatabaseEngine;
    /** Exact name of the external Compose network shared with the database. */
    network: string;
}

const DATABASE_NETWORK = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

/** A bounded Compose network name, never a path, URL or credential. */
export function isManagedSiteDatabaseNetwork(value: string): boolean {
    return value.length > 0 && value.length <= MANAGED_SITE_DATABASE_NETWORK_MAX && DATABASE_NETWORK.test(value);
}

/** Fixed private env file read by Compose at container creation (ADR 0048). */
export function managedSiteDatabaseEnvPath(stackDir: string): string {
    return `${stackDir}/${MANAGED_SITE_PATHS.private}/${MANAGED_SITE_DATABASE_ENV_FILE}`;
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

/**
 * Tree entries the panel owns and refuses in a fetched repository. A future
 * build scratch path stays reserved even when the build no longer uses it, so a
 * repository can never collide with a panel-managed directory.
 */
export const MANAGED_SITE_RESERVED_TREE_ENTRIES = [".compose-panel", ".compose-panel-build"] as const;

/** The only machine credential a managed site may declare (ADR 0050). */
export const MANAGED_SITE_CI_KINDS = ["token"] as const;
export type ManagedSiteCiKind = (typeof MANAGED_SITE_CI_KINDS)[number];

export interface ManagedSiteCi {
    /** One bearer token, verified against a stored digest. */
    kind: ManagedSiteCiKind;
}

export interface ManagedSiteManifest {
    version: ManagedSiteVersion;
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
    /** Optional existing database attachment (ADR 0048). */
    database?: ManagedSiteDatabase;
    /** `managed` only: optional offsite backup declaration (ADR 0049). */
    backup?: ManagedSiteBackup;
    /** `managed` only: optional CI-triggered deploy credential (ADR 0050). */
    ci?: ManagedSiteCi;
    /** `managed` only: fixed dependency preparation run in a disposable container. */
    build?: { kind: ManagedSiteBuildKind };
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
        [
            "version",
            "siteId",
            "owner",
            "project",
            "services",
            "gateway",
            "publicRoot",
            "runtime",
            "database",
            "backup",
            "ci",
            "build",
            "deploy",
            "paths",
            "generation",
        ],
        "",
    );
    if (unknown) return unknown;

    if (!MANAGED_SITE_VERSIONS.includes(root.version as ManagedSiteVersion)) {
        return {
            ok: false,
            reason: `The site manifest version must be one of: ${MANAGED_SITE_VERSIONS.join(", ")}.`,
        };
    }
    const version = root.version as ManagedSiteVersion;

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

    let database: ManagedSiteDatabase | undefined;
    if (root.database !== undefined) {
        if (version < MANAGED_SITE_DATABASE_VERSION) {
            return { ok: false, reason: `The database block requires manifest version ${MANAGED_SITE_DATABASE_VERSION} or later.` };
        }
        const candidate = asRecord(root.database);
        if (!candidate) return { ok: false, reason: "database must be an object." };
        const databaseUnknown = unknownField(candidate, ["kind", "engine", "network"], "database.");
        if (databaseUnknown) return databaseUnknown;
        const kind = MANAGED_SITE_DATABASE_KINDS.find((entry) => entry === candidate.kind);
        if (!kind) {
            return { ok: false, reason: `database.kind must be one of: ${MANAGED_SITE_DATABASE_KINDS.join(", ")}.` };
        }
        const engine = MANAGED_SITE_DATABASE_ENGINES.find((entry) => entry === candidate.engine);
        if (!engine) {
            return { ok: false, reason: `database.engine must be one of: ${MANAGED_SITE_DATABASE_ENGINES.join(", ")}.` };
        }
        const network = asString(candidate.network);
        if (!network || !isManagedSiteDatabaseNetwork(network)) {
            return {
                ok: false,
                reason: `database.network must be a bounded Compose network name, 1-${MANAGED_SITE_DATABASE_NETWORK_MAX} characters.`,
            };
        }
        database = { kind, engine, network };
    }

    let backup: ManagedSiteBackup | undefined;
    if (root.backup !== undefined) {
        if (version !== MANAGED_SITE_BACKUP_VERSION) {
            return { ok: false, reason: `The backup block requires manifest version ${MANAGED_SITE_BACKUP_VERSION}.` };
        }
        if (owner !== "managed") {
            return { ok: false, reason: 'backup belongs to owner "managed": an opt-in stack declares no persistent roots.' };
        }
        const candidate = asRecord(root.backup);
        if (!candidate) return { ok: false, reason: "backup must be an object." };
        const backupUnknown = unknownField(candidate, ["kind", "repository", "retention", "sql", "trigger"], "backup.");
        if (backupUnknown) return backupUnknown;
        const kind = MANAGED_SITE_BACKUP_KINDS.find((entry) => entry === candidate.kind);
        if (!kind) {
            return { ok: false, reason: `backup.kind must be one of: ${MANAGED_SITE_BACKUP_KINDS.join(", ")}.` };
        }
        const repository = asString(candidate.repository);
        if (!repository || !isManagedSiteBackupRepository(repository)) {
            return {
                ok: false,
                reason: 'backup.repository must be "rest:https://host/path" without userinfo, query or fragment; "rest:http://" is allowed only for a loopback or single-label private host.',
            };
        }
        let sql: ManagedSiteBackupSql | undefined;
        if (candidate.sql !== undefined) {
            const sqlCandidate = asRecord(candidate.sql);
            if (!sqlCandidate) return { ok: false, reason: "backup.sql must be an object with an engine and a database." };
            const sqlUnknown = unknownField(sqlCandidate, ["engine", "database"], "backup.sql.");
            if (sqlUnknown) return sqlUnknown;
            const engine = MANAGED_SITE_BACKUP_SQL_ENGINES.find((entry) => entry === sqlCandidate.engine);
            if (!engine) {
                return {
                    ok: false,
                    reason: `backup.sql.engine must be one of: ${MANAGED_SITE_BACKUP_SQL_ENGINES.join(", ")}; files-only backup omits backup.sql.`,
                };
            }
            if (!database) {
                return { ok: false, reason: "backup.sql requires a database block; remove backup.sql for a files-only backup." };
            }
            if (database.engine !== engine) {
                return {
                    ok: false,
                    reason: `backup.sql.engine must match the attached database engine "${database.engine}".`,
                };
            }
            const name = asString(sqlCandidate.database);
            if (!name || !isManagedSiteBackupDatabase(name)) {
                return {
                    ok: false,
                    reason: `backup.sql.database must be one SQL identifier of at most ${MANAGED_SITE_BACKUP_DATABASE_MAX} characters.`,
                };
            }
            sql = { engine, database: name };
        }
        let retention: ManagedSiteBackupRetention | undefined;
        if (candidate.retention !== undefined) {
            const retentionCandidate = asRecord(candidate.retention);
            if (!retentionCandidate) {
                return { ok: false, reason: "backup.retention must be an object with at least one keep count." };
            }
            const retentionUnknown = unknownField(retentionCandidate, [...MANAGED_SITE_BACKUP_RETENTION_KEYS], "backup.retention.");
            if (retentionUnknown) return retentionUnknown;
            const declared: ManagedSiteBackupRetention = {};
            let declaredCount = 0;
            for (const key of MANAGED_SITE_BACKUP_RETENTION_KEYS) {
                const value = retentionCandidate[key];
                if (value === undefined) continue;
                if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MANAGED_SITE_BACKUP_RETENTION_MAX[key]) {
                    return {
                        ok: false,
                        reason: `backup.retention.${key} must be an integer between 1 and ${MANAGED_SITE_BACKUP_RETENTION_MAX[key]}.`,
                    };
                }
                declared[key] = value;
                declaredCount += 1;
            }
            if (declaredCount === 0) {
                return {
                    ok: false,
                    reason: `backup.retention must declare at least one of: ${MANAGED_SITE_BACKUP_RETENTION_KEYS.join(", ")}.`,
                };
            }
            retention = declared;
        }
        let trigger: ManagedSiteBackupTrigger | undefined;
        if (candidate.trigger !== undefined) {
            const triggerCandidate = asRecord(candidate.trigger);
            if (!triggerCandidate) {
                return { ok: false, reason: "backup.trigger must be an object with a kind and everyHours." };
            }
            const triggerUnknown = unknownField(triggerCandidate, ["kind", "everyHours"], "backup.trigger.");
            if (triggerUnknown) return triggerUnknown;
            const triggerKind = MANAGED_SITE_BACKUP_TRIGGER_KINDS.find((entry) => entry === triggerCandidate.kind);
            if (!triggerKind) {
                return {
                    ok: false,
                    reason: `backup.trigger.kind must be one of: ${MANAGED_SITE_BACKUP_TRIGGER_KINDS.join(", ")}.`,
                };
            }
            const everyHours = triggerCandidate.everyHours;
            if (
                typeof everyHours !== "number" ||
                !Number.isInteger(everyHours) ||
                everyHours < MANAGED_SITE_BACKUP_TRIGGER_MIN_HOURS ||
                everyHours > MANAGED_SITE_BACKUP_TRIGGER_MAX_HOURS
            ) {
                return {
                    ok: false,
                    reason: `backup.trigger.everyHours must be an integer between ${MANAGED_SITE_BACKUP_TRIGGER_MIN_HOURS} and ${MANAGED_SITE_BACKUP_TRIGGER_MAX_HOURS}.`,
                };
            }
            trigger = { kind: triggerKind, everyHours };
        }
        backup = {
            kind,
            repository,
            ...(sql ? { sql } : {}),
            ...(retention ? { retention } : {}),
            ...(trigger ? { trigger } : {}),
        };
    }

    let ci: ManagedSiteCi | undefined;
    if (root.ci !== undefined) {
        if (version !== MANAGED_SITE_CI_VERSION) {
            return { ok: false, reason: `The ci block requires manifest version ${MANAGED_SITE_CI_VERSION}.` };
        }
        if (owner !== "managed") {
            return { ok: false, reason: 'ci belongs to owner "managed": an opt-in stack has no generated deploy contract.' };
        }
        const candidate = asRecord(root.ci);
        if (!candidate) return { ok: false, reason: "ci must be an object with a kind." };
        const ciUnknown = unknownField(candidate, ["kind"], "ci.");
        if (ciUnknown) return ciUnknown;
        const kind = MANAGED_SITE_CI_KINDS.find((entry) => entry === candidate.kind);
        if (!kind) {
            return { ok: false, reason: `ci.kind must be one of: ${MANAGED_SITE_CI_KINDS.join(", ")}.` };
        }
        ci = { kind };
    }

    let build: { kind: ManagedSiteBuildKind } | undefined;
    if (root.build !== undefined) {
        if (owner !== "managed") {
            return {
                ok: false,
                reason: 'build belongs to owner "managed": an opt-in stack keeps its own dependency preparation.',
            };
        }
        const candidate = asRecord(root.build);
        if (!candidate) return { ok: false, reason: "build must be an object with a kind." };
        const buildUnknown = unknownField(candidate, ["kind"], "build.");
        if (buildUnknown) return buildUnknown;
        const kind = MANAGED_SITE_BUILD_KINDS.find((entry) => entry === candidate.kind);
        if (!kind) {
            return { ok: false, reason: `build.kind must be one of: ${MANAGED_SITE_BUILD_KINDS.join(", ")}.` };
        }
        build = { kind };
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
        version,
        siteId,
        owner,
        project,
        services: { gateway, runtime: runtimeService },
        ...(gatewayPort === undefined ? {} : { gateway: { port: gatewayPort } }),
        publicRoot: MANAGED_SITE_PUBLIC_ROOT,
        runtime: image === undefined ? { profile: MANAGED_SITE_PROFILE } : { profile: MANAGED_SITE_PROFILE, image },
        ...(database ? { database } : {}),
        ...(backup ? { backup } : {}),
        ...(ci ? { ci } : {}),
        ...(build ? { build } : {}),
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
