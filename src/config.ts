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
    /** Set when the panel is served over TLS (directly or behind a proxy). */
    cookieSecure: boolean;
    /** Explicit public origin used for Origin/Host checks behind a reverse proxy. */
    publicOrigin: string | null;
    /** Trust X-Forwarded-Proto / X-Forwarded-For from a configured proxy. */
    trustProxy: boolean;
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
    /** Fixed Docker executable. Never taken from user input. */
    dockerPath: string;
    /** Compose engine/provider identifier. V1 supports "docker". */
    composeEngine: string;
    dockerTimeoutMs: number;
    dockerMaxBytes: number;
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

function parseOrigin(env: Env): string | null {
    const raw = env.COMPOSE_PANEL_PUBLIC_ORIGIN;
    if (raw === undefined || raw === "") return null;
    let url: URL;
    try { url = new URL(raw); }
    catch { throw new Error("COMPOSE_PANEL_PUBLIC_ORIGIN must be an absolute http(s) URL."); }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("COMPOSE_PANEL_PUBLIC_ORIGIN must use http or https.");
    }
    if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
        throw new Error("COMPOSE_PANEL_PUBLIC_ORIGIN must not contain a path, query or fragment.");
    }
    return url.origin;
}

interface ProxySettings {
    publicOrigin: string | null;
    cookieSecure: boolean;
    trustProxy: boolean;
}

/**
 * Proxy mode is all or nothing, with safe defaults. The bind stays loopback, so
 * a public origin always means a reverse proxy on the same host:
 * - the public origin must be https (plain HTTP would carry the password and
 *   the session cookie in clear), except in development mode;
 * - Secure cookies and the forwarded client address follow from it, and
 *   turning either off explicitly is refused: without the forwarded address
 *   every visitor shares one throttle key, so one client could keep the admin
 *   waiting;
 * - trusting forwarded headers without a public origin is refused too.
 */
function parseProxy(env: Env, devMode: boolean): ProxySettings {
    const publicOrigin = parseOrigin(env);
    const explicitSecure = env.COMPOSE_PANEL_COOKIE_SECURE ? parseBool(env, "COMPOSE_PANEL_COOKIE_SECURE", false) : undefined;
    const explicitTrust = env.COMPOSE_PANEL_TRUST_PROXY ? parseBool(env, "COMPOSE_PANEL_TRUST_PROXY", false) : undefined;
    if (!publicOrigin) {
        if (explicitTrust) {
            throw new Error("COMPOSE_PANEL_TRUST_PROXY=true requires COMPOSE_PANEL_PUBLIC_ORIGIN. Without a reverse proxy there is no forwarded address to trust.");
        }
        return { publicOrigin, cookieSecure: explicitSecure ?? false, trustProxy: false };
    }
    const https = publicOrigin.startsWith("https:");
    if (!https && !devMode) {
        throw new Error("COMPOSE_PANEL_PUBLIC_ORIGIN must use https: plain HTTP would send the password and the session cookie in clear. (COMPOSE_PANEL_DEV=true allows http for local testing only.)");
    }
    if (https && explicitSecure === false) {
        throw new Error("COMPOSE_PANEL_COOKIE_SECURE=false is refused with an https COMPOSE_PANEL_PUBLIC_ORIGIN. Remove it: Secure cookies are the default behind TLS.");
    }
    if (explicitTrust === false) {
        throw new Error("COMPOSE_PANEL_TRUST_PROXY=false is refused with COMPOSE_PANEL_PUBLIC_ORIGIN: every visitor would share one sign-in throttle key. Remove it: the proxy's X-Forwarded-For is used by default.");
    }
    return { publicOrigin, cookieSecure: explicitSecure ?? https, trustProxy: true };
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
        dockerPath: env.COMPOSE_PANEL_DOCKER_PATH?.trim() || "docker",
        composeEngine: env.COMPOSE_PANEL_COMPOSE_ENGINE?.trim() || "docker",
        dockerTimeoutMs: parsePositiveInt(env, "COMPOSE_PANEL_DOCKER_TIMEOUT_MS", 5000),
        dockerMaxBytes: parsePositiveInt(env, "COMPOSE_PANEL_DOCKER_MAX_BYTES", 1024 * 1024),
        operationTimeoutMs: parsePositiveInt(env, "COMPOSE_PANEL_OPERATION_TIMEOUT_MS", 5 * 60 * 1000),
        shutdownGraceMs: parsePositiveInt(env, "COMPOSE_PANEL_SHUTDOWN_GRACE_MS", 30 * 1000),
        sseHeartbeatMs: parsePositiveInt(env, "COMPOSE_PANEL_SSE_HEARTBEAT_MS", 15 * 1000),
        sseTimeoutMs: parsePositiveInt(env, "COMPOSE_PANEL_SSE_TIMEOUT_MS", 30 * 60 * 1000),
        sseMaxSubscribers: parsePositiveInt(env, "COMPOSE_PANEL_SSE_MAX_SUBSCRIBERS", 100),
        logTailLines: parsePositiveInt(env, "COMPOSE_PANEL_LOG_TAIL_LINES", 200),
        logMaxBytes: parsePositiveInt(env, "COMPOSE_PANEL_LOG_MAX_BYTES", 256 * 1024),
        logTimeoutMs: parsePositiveInt(env, "COMPOSE_PANEL_LOG_TIMEOUT_MS", 30 * 60 * 1000),
    };
}
