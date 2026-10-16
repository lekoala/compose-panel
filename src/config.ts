import { posix } from "node:path";
import type { PathAlias } from "./container-state.ts";
import { normalizeDatabaseExplorerUrl } from "./database.ts";

export interface LoginRateLimitConfig {
    windowMs: number;
    maxAttempts: number;
    /** Cap for the per-key delay applied once over the limit (no hard lockout). */
    backoffMaxMs: number;
}

export type AuditRotation = "day" | "month";

export interface AuditConfig {
    enabled: boolean;
    /** Absolute audit directory; null means derive `<stacksRoot>/.compose-panel/audit`. */
    dir: string | null;
    rotation: AuditRotation;
    /** Number of period files kept; the oldest are pruned on rollover. */
    retainFiles: number;
    /** Maximum entries rendered for one period. */
    maxReadLines: number;
    /** Size cap of one period file. */
    maxFileBytes: number;
}

export interface AppConfig {
    /** Raw STACKS_DIR value; resolved to a real path by the server entry point. */
    stacksDir: string;
    port: number;
    adminUser: string;
    adminPasswordHash: string;
    /**
     * Mark cookies `Secure` on the direct/loopback access path. The proxy path
     * ignores it: there the matched origin's scheme decides (https => Secure).
     */
    cookieSecure: boolean;
    /**
     * Reverse-proxy origins explicitly allowed to reach the panel, as exact
     * `scheme://host[:port]` values. Empty means direct loopback access only.
     * Origin/Host checks, the cookie attribute and X-Forwarded-* trust are
     * resolved per request against these entry points. Must be https outside
     * development mode.
     */
    proxyOrigins: string[];
    /**
     * Allow the loopback/SSH-tunnel path alongside the configured proxy
     * origins. Implicit when no proxy origin is configured; otherwise off by
     * default, so one access path is used at a time.
     */
    allowLoopback: boolean;
    /**
     * IANA display time zone for every rendered time (activity log, action
     * start, container logs). Empty means each reader's browser zone. Stored
     * timestamps are always UTC; this only affects presentation.
     */
    timeZone: string;
    /**
     * Opt-in local-testing relaxation: accept an absent or opaque (`null`)
     * Origin when Fetch Metadata says the request is same-origin/none. Default
     * false — the panel must not be driven from an embedded/sandboxed context.
     */
    allowOpaqueOrigin: boolean;
    /**
     * Development/debug mode. Default false. When true, weak conveniences are
     * allowed (e.g. the `admin` username). Never enable in production.
     */
    devMode: boolean;
    sessionTtlMs: number;
    sessionIdleMs: number;
    loginRateLimit: LoginRateLimitConfig;
    audit: AuditConfig;
    maxBodyBytes: number;
    /** Maximum size of an edited Compose or .env draft. */
    maxEditBytes: number;
    /** Backups kept per file of a stack; older ones are deleted after each save. */
    backupRetain: number;
    /** Fixed Docker executable. Never taken from user input. */
    dockerPath: string;
    /** Compose engine/provider identifier. V1 supports "docker". */
    composeEngine: string;
    /**
     * Optional base URL of an external database explorer (LibreDB Studio,
     * Adminer, pgAdmin…) that stacks may link to through their
     * `x-compose-panel.database` extension. Normalized to an origin, or null
     * when unset. The panel only builds a link to it: it never contacts the
     * explorer (ADR 0027).
     */
    databaseExplorerUrl: string | null;
    /**
     * Optional Caddy site management (ADR 0030). When true, the stack page
     * shows a Domains section: a preview of the managed Caddy file always,
     * plus real attach/detach through the host helper when `caddySocketPath`
     * is set. False means no section, no socket access, no new dependency.
     */
    caddyEnabled: boolean;
    /**
     * Unix socket of the privileged Caddy helper, mounted into the panel
     * container (ADR 0030, PR2). Null means attach/detach are unavailable and
     * the Domains section stays a preview. A socket without the flag above is
     * refused at startup as a misconfiguration.
     */
    caddySocketPath: string | null;
    /**
     * Host-to-panel path prefixes used to classify external containers as
     * managed after a migration where the Docker-side Compose path differs from
     * the panel's mount (`hostPrefix=panelPrefix` entries). Empty by default.
     */
    hostStacksPathAliases: PathAlias[];
    dockerTimeoutMs: number;
    dockerMaxBytes: number;
    /**
     * Timeout for the read-only engine diagnostics calls (`docker info`,
     * `docker stats --no-stream`, `docker system df`). Separate from the
     * general Docker timeout because `stats` can take longer on a busy host.
     */
    insightsTimeoutMs: number;
    /** Cache lifetime for `docker system df`, which is read on demand only. */
    diskUsageTtlMs: number;
    /** Maximum duration of a mutating Compose operation. */
    operationTimeoutMs: number;
    /** Bounded drain window for running operations on shutdown. */
    shutdownGraceMs: number;
    /** Heartbeat interval for SSE streams. */
    sseHeartbeatMs: number;
    /** Maximum lifetime of a single SSE subscription. */
    sseTimeoutMs: number;
    /** Maximum concurrent SSE subscriptions process-wide. */
    sseMaxSubscribers: number;
    /** Lines of history tailed when a log follow starts. */
    logTailLines: number;
    /** Cap on the retained per-stack log buffer. */
    logMaxBytes: number;
    /** Maximum lifetime of a `logs --follow` subprocess. */
    logTimeoutMs: number;
    /** Cap on a project manifest read for the application toolbox. */
    toolboxMaxManifestBytes: number;
    /** Maximum number of declared actions per toolbox manifest. */
    toolboxMaxActions: number;
    /** Upper bound for a declared action timeout (the manifest value is clamped). */
    toolboxMaxTimeoutMs: number;
}

type Env = Record<string, string | undefined>;

/** Common/guessable usernames refused unless COMPOSE_PANEL_DEV=true. */
const WEAK_ADMIN_USERS = new Set(["admin", "administrator", "root", "user", "test", "guest"]);

function parseBool(env: Env, name: string, fallback: boolean): boolean {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const value = raw.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(value)) return true;
    if (["0", "false", "no", "off"].includes(value)) return false;
    throw new Error(`${name} must be a boolean (true/false).`);
}

function parsePositiveInt(env: Env, name: string, fallback: number): number {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
    return value;
}

function parsePort(env: Env): number {
    const value = Number(env.PORT ?? "5081");
    if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error("PORT must be an integer between 1 and 65535.");
    return value;
}

function parseRotation(env: Env): AuditRotation {
    const raw = env.COMPOSE_PANEL_AUDIT_ROTATION?.trim().toLowerCase();
    if (raw === undefined || raw === "" || raw === "day") return "day";
    if (raw === "month") return "month";
    throw new Error("COMPOSE_PANEL_AUDIT_ROTATION must be \"day\" or \"month\".");
}

/**
 * Legacy settings removed by ADR 0012. Security configuration is never
 * silently reinterpreted: an operator who upgrades without editing the file
 * gets a clear refusal at startup instead of a quiet change of access policy.
 */
function refuseLegacyProxyEnv(env: Env): void {
    if (env.COMPOSE_PANEL_PUBLIC_ORIGIN) {
        throw new Error(
            "COMPOSE_PANEL_PUBLIC_ORIGIN is no longer supported. "
            + "Replace it with COMPOSE_PANEL_PROXY_ORIGINS=<that url> (comma-separate several). See docs/deployment.md.",
        );
    }
    if (env.COMPOSE_PANEL_TRUST_PROXY) {
        throw new Error(
            "COMPOSE_PANEL_TRUST_PROXY is no longer supported. Remove it: "
            + "X-Forwarded-* is trusted only on a request whose Host matches a COMPOSE_PANEL_PROXY_ORIGINS entry.",
        );
    }
}

function parseTimeZone(env: Env): string {
    const raw = env.COMPOSE_PANEL_TIMEZONE?.trim();
    if (raw === undefined || raw === "") return "";
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: raw });
    } catch {
        throw new Error(`COMPOSE_PANEL_TIMEZONE must be a valid IANA time zone (e.g. "Europe/Brussels"), got "${raw}".`);
    }
    return raw;
}

/**
 * Unix socket of the privileged Caddy helper (ADR 0030). Empty means the
 * helper is not used and Domains stays a preview. A socket path without the
 * opt-in flag is a misconfiguration and is refused at startup. The socket
 * itself must be absolute: it is a host path mounted into the panel.
 */
function parseCaddySocketPath(env: Env, caddyEnabled: boolean): string | null {
    const raw = env.COMPOSE_PANEL_CADDY_SOCKET_PATH?.trim() ?? "";
    if (raw === "") return null;
    if (!caddyEnabled) {
        throw new Error("COMPOSE_PANEL_CADDY_SOCKET_PATH is set but COMPOSE_PANEL_CADDY_ENABLED is not true. Enable the integration or remove the socket path.");
    }
    if (!posix.isAbsolute(raw)) {
        throw new Error("COMPOSE_PANEL_CADDY_SOCKET_PATH must be an absolute Unix socket path.");
    }
    if (/[\x00-\x1f\x7f]/.test(raw)) throw new Error("COMPOSE_PANEL_CADDY_SOCKET_PATH contains control characters.");
    return raw;
}

/**
 * Host-to-panel path prefix remapping for container classification, as a
 * comma-separated list of `hostPrefix=panelPrefix`. Used after a migration where
 * the Docker-side Compose path (a container label) differs from the panel's
 * mount. Empty means no remapping.
 */
function parsePathAliases(env: Env): PathAlias[] {
    const raw = env.COMPOSE_PANEL_STACKS_PATH_ALIASES?.trim();
    if (raw === undefined || raw === "") return [];
    const aliases: PathAlias[] = [];
    for (const entry of raw.split(",").map(value => value.trim())) {
        if (entry === "") throw new Error("COMPOSE_PANEL_STACKS_PATH_ALIASES contains an empty entry. Remove the stray comma.");
        const index = entry.indexOf("=");
        const from = index > 0 ? entry.slice(0, index).trim() : "";
        const to = index > 0 ? entry.slice(index + 1).trim() : "";
        if (!from || !to) {
            throw new Error(`COMPOSE_PANEL_STACKS_PATH_ALIASES entry "${entry}" must be hostPrefix=panelPrefix.`);
        }
        // Both sides are Unix path prefixes compared against Docker labels, so
        // they must be absolute and free of "..": a relative or dot-dot prefix
        // would silently match nothing (or the wrong subtree) and demote
        // managed containers to External without explanation.
        for (const prefix of [from, to]) {
            if (!posix.isAbsolute(prefix)) {
                throw new Error(`COMPOSE_PANEL_STACKS_PATH_ALIASES entry "${entry}" must use absolute prefixes (hostPrefix=panelPrefix).`);
            }
            if (prefix.split("/").includes("..")) {
                throw new Error(`COMPOSE_PANEL_STACKS_PATH_ALIASES entry "${entry}" must not contain ".." segments.`);
            }
        }
        aliases.push({ from, to });
    }
    return aliases;
}

/**
 * V1 targets Docker Compose only. Refused at startup with an actionable
 * message instead of a generic factory error at first use.
 */
function parseComposeEngine(env: Env): string {
    const engine = env.COMPOSE_PANEL_COMPOSE_ENGINE?.trim() || "docker";
    if (engine === "podman") {
        throw new Error('COMPOSE_PANEL_COMPOSE_ENGINE="podman" is not implemented yet; the V1 provider targets Docker Compose ("docker").');
    }
    if (engine !== "docker") {
        throw new Error(`COMPOSE_PANEL_COMPOSE_ENGINE="${engine}" is not supported: V1 targets Docker Compose only ("docker").`);
    }
    return engine;
}

interface ProxySettings {
    proxyOrigins: string[];
    allowLoopback: boolean;
    cookieSecure: boolean;
}

/**
 * Parse one origin from the comma-separated list. Each entry must be an
 * absolute http(s) origin: no credentials, path, query or fragment, and https
 * outside development mode (plain HTTP would carry the password and session
 * cookie in clear). Entries are normalized to `scheme://host[:port]`.
 */
function parseProxyOrigin(entry: string, devMode: boolean): string {
    let url: URL;
    try { url = new URL(entry); }
    catch { throw new Error(`COMPOSE_PANEL_PROXY_ORIGINS entry "${entry}" must be an absolute http(s) URL.`); }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error(`COMPOSE_PANEL_PROXY_ORIGINS entry "${entry}" must use http or https.`);
    }
    if (url.username !== "" || url.password !== "") {
        throw new Error(`COMPOSE_PANEL_PROXY_ORIGINS entry "${entry}" must not contain credentials (user:pass@).`);
    }
    if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
        throw new Error(`COMPOSE_PANEL_PROXY_ORIGINS entry "${entry}" must not contain a path, query or fragment.`);
    }
    if (!devMode && url.protocol === "http:") {
        throw new Error(`COMPOSE_PANEL_PROXY_ORIGINS entry "${entry}" must use https: plain HTTP would send the password and the session cookie in clear. (COMPOSE_PANEL_DEV=true allows http for local testing only.)`);
    }
    return url.origin;
}

/**
 * Reverse-proxy access is a list of explicitly allowed origins, with safe
 * defaults. The bind stays loopback, so an origin always means a reverse proxy
 * on the same host. Loopback access is implicit when no origin is configured,
 * and otherwise only with COMPOSE_PANEL_ALLOW_LOOPBACK=true, so an operator
 * opts in to reaching the panel two ways at once. The cookie `Secure` attribute
 * and X-Forwarded-* trust are decided per request from the matched entry point
 * (see app.ts), not from a global switch.
 */
function parseProxy(env: Env, devMode: boolean): ProxySettings {
    refuseLegacyProxyEnv(env);
    const raw = env.COMPOSE_PANEL_PROXY_ORIGINS;
    const origins: string[] = [];
    if (raw !== undefined && raw.trim() !== "") {
        const seen = new Set<string>();
        for (const part of raw.split(",").map(value => value.trim())) {
            if (part === "") {
                throw new Error("COMPOSE_PANEL_PROXY_ORIGINS contains an empty entry. Remove the stray comma.");
            }
            const origin = parseProxyOrigin(part, devMode);
            if (seen.has(origin)) {
                throw new Error(`COMPOSE_PANEL_PROXY_ORIGINS lists "${origin}" twice.`);
            }
            seen.add(origin);
            origins.push(origin);
        }
    }
    const explicitSecure = env.COMPOSE_PANEL_COOKIE_SECURE ? parseBool(env, "COMPOSE_PANEL_COOKIE_SECURE", false) : undefined;
    return {
        proxyOrigins: origins,
        allowLoopback: parseBool(env, "COMPOSE_PANEL_ALLOW_LOOPBACK", false),
        cookieSecure: explicitSecure ?? false,
    };
}

export function loadConfig(env: Env = process.env): AppConfig {
    const stacksDir = env.STACKS_DIR;
    if (!stacksDir) throw new Error("STACKS_DIR is required (absolute path to the stacks).");

    const adminPasswordHash = env.COMPOSE_PANEL_ADMIN_PASSWORD_HASH;
    if (!adminPasswordHash) {
        throw new Error("COMPOSE_PANEL_ADMIN_PASSWORD_HASH is required. Generate one with `bun run hash-password`.");
    }

    const devMode = parseBool(env, "COMPOSE_PANEL_DEV", false);
    const adminUser = env.COMPOSE_PANEL_ADMIN_USER?.trim() || "admin";
    if (!devMode && WEAK_ADMIN_USERS.has(adminUser.toLowerCase())) {
        throw new Error(`COMPOSE_PANEL_ADMIN_USER must not be a common name like "${adminUser}". Choose a unique name, or set COMPOSE_PANEL_DEV=true for local development.`);
    }

    return {
        stacksDir,
        port: parsePort(env),
        adminUser,
        adminPasswordHash,
        ...parseProxy(env, devMode),
        allowOpaqueOrigin: parseBool(env, "COMPOSE_PANEL_ALLOW_OPAQUE_ORIGIN", false),
        devMode,
        sessionTtlMs: parsePositiveInt(env, "COMPOSE_PANEL_SESSION_TTL_MS", 12 * 60 * 60 * 1000),
        sessionIdleMs: parsePositiveInt(env, "COMPOSE_PANEL_SESSION_IDLE_MS", 60 * 60 * 1000),
        loginRateLimit: {
            windowMs: parsePositiveInt(env, "COMPOSE_PANEL_LOGIN_WINDOW_MS", 15 * 60 * 1000),
            maxAttempts: parsePositiveInt(env, "COMPOSE_PANEL_LOGIN_MAX_ATTEMPTS", 5),
            backoffMaxMs: parsePositiveInt(env, "COMPOSE_PANEL_LOGIN_BACKOFF_MAX_MS", 2000),
        },
        audit: {
            enabled: parseBool(env, "COMPOSE_PANEL_AUDIT_ENABLED", true),
            dir: env.COMPOSE_PANEL_AUDIT_DIR?.trim() || null,
            rotation: parseRotation(env),
            retainFiles: parsePositiveInt(env, "COMPOSE_PANEL_AUDIT_RETAIN_FILES", 31),
            maxReadLines: parsePositiveInt(env, "COMPOSE_PANEL_AUDIT_MAX_READ_LINES", 2000),
            maxFileBytes: parsePositiveInt(env, "COMPOSE_PANEL_AUDIT_MAX_FILE_BYTES", 10 * 1024 * 1024),
        },
        maxBodyBytes: parsePositiveInt(env, "COMPOSE_PANEL_MAX_BODY_BYTES", 8 * 1024),
        maxEditBytes: parsePositiveInt(env, "COMPOSE_PANEL_MAX_EDIT_BYTES", 1024 * 1024),
        backupRetain: parsePositiveInt(env, "COMPOSE_PANEL_BACKUP_RETAIN", 10),
        dockerPath: env.COMPOSE_PANEL_DOCKER_PATH?.trim() || "docker",
        composeEngine: parseComposeEngine(env),
        databaseExplorerUrl: normalizeDatabaseExplorerUrl(env.COMPOSE_PANEL_DATABASE_EXPLORER_URL ?? "", devMode),
        caddyEnabled: parseBool(env, "COMPOSE_PANEL_CADDY_ENABLED", false),
        caddySocketPath: parseCaddySocketPath(env, parseBool(env, "COMPOSE_PANEL_CADDY_ENABLED", false)),
        hostStacksPathAliases: parsePathAliases(env),
        timeZone: parseTimeZone(env),
        dockerTimeoutMs: parsePositiveInt(env, "COMPOSE_PANEL_DOCKER_TIMEOUT_MS", 5000),
        dockerMaxBytes: parsePositiveInt(env, "COMPOSE_PANEL_DOCKER_MAX_BYTES", 1024 * 1024),
        insightsTimeoutMs: parsePositiveInt(env, "COMPOSE_PANEL_INSIGHTS_TIMEOUT_MS", 10_000),
        diskUsageTtlMs: parsePositiveInt(env, "COMPOSE_PANEL_DISK_USAGE_TTL_MS", 300_000),
        operationTimeoutMs: parsePositiveInt(env, "COMPOSE_PANEL_OPERATION_TIMEOUT_MS", 5 * 60 * 1000),
        shutdownGraceMs: parsePositiveInt(env, "COMPOSE_PANEL_SHUTDOWN_GRACE_MS", 30 * 1000),
        sseHeartbeatMs: parsePositiveInt(env, "COMPOSE_PANEL_SSE_HEARTBEAT_MS", 15 * 1000),
        sseTimeoutMs: parsePositiveInt(env, "COMPOSE_PANEL_SSE_TIMEOUT_MS", 30 * 60 * 1000),
        sseMaxSubscribers: parsePositiveInt(env, "COMPOSE_PANEL_SSE_MAX_SUBSCRIBERS", 100),
        logTailLines: parsePositiveInt(env, "COMPOSE_PANEL_LOG_TAIL_LINES", 200),
        logMaxBytes: parsePositiveInt(env, "COMPOSE_PANEL_LOG_MAX_BYTES", 256 * 1024),
        logTimeoutMs: parsePositiveInt(env, "COMPOSE_PANEL_LOG_TIMEOUT_MS", 30 * 60 * 1000),
        toolboxMaxManifestBytes: parsePositiveInt(env, "COMPOSE_PANEL_TOOLBOX_MAX_MANIFEST_BYTES", 256 * 1024),
        toolboxMaxActions: parsePositiveInt(env, "COMPOSE_PANEL_TOOLBOX_MAX_ACTIONS", 50),
        toolboxMaxTimeoutMs: parsePositiveInt(env, "COMPOSE_PANEL_TOOLBOX_MAX_TIMEOUT_MS", 15 * 60 * 1000),
    };
}
