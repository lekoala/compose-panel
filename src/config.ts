export interface LoginRateLimitConfig {
    windowMs: number;
    maxAttempts: number;
    blockMs: number;
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
    sessionTtlMs: number;
    sessionIdleMs: number;
    loginRateLimit: LoginRateLimitConfig;
    maxBodyBytes: number;
}

type Env = Record<string, string | undefined>;

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

export function loadConfig(env: Env = process.env): AppConfig {
    const stacksDir = env.STACKS_DIR;
    if (!stacksDir) throw new Error("STACKS_DIR is required (absolute path to the stacks).");

    const adminPasswordHash = env.COMPOSE_PANEL_ADMIN_PASSWORD_HASH;
    if (!adminPasswordHash) {
        throw new Error("COMPOSE_PANEL_ADMIN_PASSWORD_HASH is required. Generate one with `bun run hash-password`.");
    }

    return {
        stacksDir,
        port: parsePort(env),
        adminUser: env.COMPOSE_PANEL_ADMIN_USER?.trim() || "admin",
        adminPasswordHash,
        cookieSecure: parseBool(env, "COMPOSE_PANEL_COOKIE_SECURE", false),
        publicOrigin: parseOrigin(env),
        trustProxy: parseBool(env, "COMPOSE_PANEL_TRUST_PROXY", false),
        sessionTtlMs: parsePositiveInt(env, "COMPOSE_PANEL_SESSION_TTL_MS", 12 * 60 * 60 * 1000),
        sessionIdleMs: parsePositiveInt(env, "COMPOSE_PANEL_SESSION_IDLE_MS", 60 * 60 * 1000),
        loginRateLimit: {
            windowMs: parsePositiveInt(env, "COMPOSE_PANEL_LOGIN_WINDOW_MS", 15 * 60 * 1000),
            maxAttempts: parsePositiveInt(env, "COMPOSE_PANEL_LOGIN_MAX_ATTEMPTS", 5),
            blockMs: parsePositiveInt(env, "COMPOSE_PANEL_LOGIN_BLOCK_MS", 15 * 60 * 1000),
        },
        maxBodyBytes: parsePositiveInt(env, "COMPOSE_PANEL_MAX_BODY_BYTES", 8 * 1024),
    };
}
