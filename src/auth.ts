import { randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "cp_session";
export const CSRF_COOKIE = "cp_csrf";

export function randomToken(bytes = 32): string {
    return randomBytes(bytes).toString("base64url");
}

/** Constant-time comparison that tolerates unequal lengths without throwing. */
export function safeEqual(a: string, b: string): boolean {
    const left = Buffer.from(a, "utf8");
    const right = Buffer.from(b, "utf8");
    if (left.length !== right.length || left.length === 0) return false;
    return timingSafeEqual(left, right);
}

export function parseCookies(header: string | null): Record<string, string> {
    const cookies: Record<string, string> = {};
    if (!header) return cookies;
    for (const part of header.split(";")) {
        const index = part.indexOf("=");
        if (index === -1) continue;
        const name = part.slice(0, index).trim();
        if (!name) continue;
        cookies[name] = part.slice(index + 1).trim();
    }
    return cookies;
}

function cookie(name: string, value: string, options: { secure: boolean; maxAgeSec?: number }): string {
    const parts = [`${name}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax"];
    if (options.maxAgeSec !== undefined) parts.push(`Max-Age=${options.maxAgeSec}`);
    if (options.secure) parts.push("Secure");
    return parts.join("; ");
}

export function sessionCookie(id: string, options: { secure: boolean; maxAgeSec: number }): string {
    return cookie(SESSION_COOKIE, id, options);
}

export function clearedSessionCookie(secure: boolean): string {
    return cookie(SESSION_COOKIE, "", { secure, maxAgeSec: 0 });
}

export function csrfCookie(token: string, secure: boolean): string {
    return cookie(CSRF_COOKIE, token, { secure });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
    if (!password) return false;
    try {
        return await Bun.password.verify(password, hash);
    } catch {
        return false;
    }
}

export async function hashPassword(password: string): Promise<string> {
    return Bun.password.hash(password);
}

export interface Session {
    id: string;
    csrf: string;
    user: string;
    createdAt: number;
    lastSeenAt: number;
}

export class SessionStore {
    private readonly sessions = new Map<string, Session>();

    constructor(
        private readonly ttlMs: number,
        private readonly idleMs: number,
        private readonly now: () => number = Date.now,
    ) {}

    create(user: string): Session {
        this.purgeExpired();
        const session: Session = {
            id: randomToken(),
            csrf: randomToken(),
            user,
            createdAt: this.now(),
            lastSeenAt: this.now(),
        };
        this.sessions.set(session.id, session);
        return session;
    }

    get(id: string): Session | null {
        const session = this.sessions.get(id);
        if (!session) return null;
        const now = this.now();
        if (now - session.createdAt > this.ttlMs || now - session.lastSeenAt > this.idleMs) {
            this.sessions.delete(id);
            return null;
        }
        session.lastSeenAt = now;
        return session;
    }

    /**
     * Whether a session is currently valid WITHOUT refreshing idle activity.
     * Used by open SSE streams so their heartbeat cannot keep a session alive
     * past its configured idle/absolute expiry.
     */
    isActive(id: string): boolean {
        const session = this.sessions.get(id);
        if (!session) return false;
        const now = this.now();
        return !(now - session.createdAt > this.ttlMs || now - session.lastSeenAt > this.idleMs);
    }

    destroy(id: string): void {
        this.sessions.delete(id);
    }

    size(): number {
        return this.sessions.size;
    }

    private purgeExpired(): void {
        const now = this.now();
        for (const [id, session] of this.sessions) {
            if (now - session.createdAt > this.ttlMs || now - session.lastSeenAt > this.idleMs) {
                this.sessions.delete(id);
            }
        }
    }
}

export interface RateLimitVerdict {
    allowed: boolean;
    retryAfterSec: number;
}

export class LoginRateLimiter {
    private readonly attempts = new Map<string, { count: number; windowStart: number; blockedUntil: number }>();
    private inFlight = 0;

    constructor(
        private readonly maxAttempts: number,
        private readonly windowMs: number,
        private readonly blockMs: number,
        private readonly now: () => number = Date.now,
        /** Global ceiling on concurrent password verifications. */
        private readonly maxInFlight: number = 8,
    ) {}

    check(key: string): RateLimitVerdict {
        const entry = this.attempts.get(key);
        if (!entry) return { allowed: true, retryAfterSec: 0 };
        const now = this.now();
        if (entry.blockedUntil > now) {
            return { allowed: false, retryAfterSec: Math.ceil((entry.blockedUntil - now) / 1000) };
        }
        if (now - entry.windowStart > this.windowMs) {
            this.attempts.delete(key);
        }
        return { allowed: true, retryAfterSec: 0 };
    }

    /**
     * Check-and-reserve in one synchronous step. The attempt is counted before
     * any awaited password work, so N concurrent requests cannot all pass the
     * limit before the first failure is recorded. Call `settle` exactly once
     * afterwards. Returns a 429-style verdict when the per-key limit, the
     * current block, or the global in-flight cap is reached.
     */
    tryReserve(key: string): RateLimitVerdict {
        const now = this.now();
        let entry = this.attempts.get(key);
        if (entry && entry.blockedUntil > now) {
            return { allowed: false, retryAfterSec: Math.ceil((entry.blockedUntil - now) / 1000) };
        }
        if (entry && now - entry.windowStart > this.windowMs) {
            this.attempts.delete(key);
            entry = undefined;
        }
        if (this.inFlight >= this.maxInFlight) {
            return { allowed: false, retryAfterSec: 1 };
        }
        if (!entry) {
            entry = { count: 0, windowStart: now, blockedUntil: 0 };
            this.attempts.set(key, entry);
        }
        if (entry.count >= this.maxAttempts) {
            entry.blockedUntil = now + this.blockMs;
            return { allowed: false, retryAfterSec: Math.ceil(this.blockMs / 1000) };
        }
        entry.count += 1;
        this.inFlight += 1;
        return { allowed: true, retryAfterSec: 0 };
    }

    /**
     * Release a reservation made by `tryReserve`. On success the reservation is
     * removed without erasing other outstanding failures; on failure it stays
     * counted and blocks the key once the limit is reached.
     */
    settle(key: string, success: boolean): void {
        if (this.inFlight > 0) this.inFlight -= 1;
        const entry = this.attempts.get(key);
        if (!entry) return;
        if (success) {
            entry.count -= 1;
            if (entry.count <= 0) this.attempts.delete(key);
            return;
        }
        const now = this.now();
        if (entry.count >= this.maxAttempts) entry.blockedUntil = now + this.blockMs;
    }

    recordFailure(key: string): void {
        const now = this.now();
        const entry = this.attempts.get(key);
        if (!entry || now - entry.windowStart > this.windowMs) {
            this.attempts.set(key, { count: 1, windowStart: now, blockedUntil: 0 });
            return;
        }
        entry.count += 1;
        if (entry.count >= this.maxAttempts) {
            entry.blockedUntil = now + this.blockMs;
        }
    }

    reset(key: string): void {
        this.attempts.delete(key);
    }
}
