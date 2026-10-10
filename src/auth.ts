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
    /** Bounded delay to apply before verifying, once a key is over its limit. */
    delayMs: number;
}

/**
 * Per-client attempt throttle with no per-client lockout.
 *
 * The panel is a single-admin, loopback-first tool. A hard lockout keyed by
 * client would let anyone deny the real admin access simply by failing logins.
 * So once a key is over its limit we return a bounded, exponentially growing
 * delay instead of a refusal, and a correct password still goes through.
 *
 * Two rules keep the delay effective and stop one source from starving others:
 * - one verification at a time per key: parallel attempts from the same key are
 *   refused, so a source cannot bypass its delay by sending requests in parallel;
 * - the global verification slot is taken only *after* the delay, by
 *   `acquireSlot`, so waiting attempts never hold one of the scarce slots.
 * Distinct sources can still contend for the global cap (transient 429); a
 * distributed attack is a host-level concern (firewall, fail2ban, CrowdSec).
 */
export class LoginRateLimiter {
    private readonly attempts = new Map<string, { count: number; windowStart: number }>();
    private readonly active = new Set<string>();
    private inFlight = 0;

    constructor(
        private readonly maxAttempts: number,
        private readonly windowMs: number,
        /** Cap for the delay applied once a key is over its limit. */
        private readonly backoffMaxMs: number,
        private readonly now: () => number = Date.now,
        /** Global ceiling on concurrent password verifications. */
        private readonly maxInFlight: number = 8,
    ) {}

    check(key: string): RateLimitVerdict {
        const now = this.now();
        const entry = this.attempts.get(key);
        if (!entry || now - entry.windowStart > this.windowMs) return { allowed: true, retryAfterSec: 0, delayMs: 0 };
        return { allowed: true, retryAfterSec: 0, delayMs: this.delayFor(entry.count) };
    }

    /**
     * Check-and-reserve in one synchronous step. The attempt is counted before
     * any awaited work, so N concurrent requests cannot all pass the limit
     * before the first failure is recorded. Refuses only while another attempt
     * of the same key is in progress. On success, wait `delayMs`, then call
     * `acquireSlot`; call `settle` exactly once in every case.
     */
    tryReserve(key: string): RateLimitVerdict {
        if (this.active.has(key)) return { allowed: false, retryAfterSec: 1, delayMs: 0 };
        const now = this.now();
        this.sweep(now);
        let entry = this.attempts.get(key);
        if (entry && now - entry.windowStart > this.windowMs) {
            this.attempts.delete(key);
            entry = undefined;
        }
        if (!entry) {
            entry = { count: 0, windowStart: now };
            this.attempts.set(key, entry);
        }
        const delayMs = this.delayFor(entry.count);
        entry.count += 1;
        this.active.add(key);
        return { allowed: true, retryAfterSec: 0, delayMs };
    }

    /** Take a global verification slot. False when the cap is reached (transient). */
    acquireSlot(): boolean {
        if (this.inFlight >= this.maxInFlight) return false;
        this.inFlight += 1;
        return true;
    }

    /**
     * Release a reservation made by `tryReserve`, and the slot if one was
     * acquired. On success the reservation is removed without erasing other
     * outstanding failures; on failure it stays counted, so the next attempt on
     * this key is delayed further.
     */
    settle(key: string, success: boolean, slotHeld: boolean): void {
        if (slotHeld && this.inFlight > 0) this.inFlight -= 1;
        this.active.delete(key);
        const entry = this.attempts.get(key);
        if (!entry) return;
        if (success) {
            entry.count -= 1;
            if (entry.count <= 0) this.attempts.delete(key);
        }
    }

    recordFailure(key: string): void {
        const now = this.now();
        const entry = this.attempts.get(key);
        if (!entry || now - entry.windowStart > this.windowMs) {
            this.attempts.set(key, { count: 1, windowStart: now });
            return;
        }
        entry.count += 1;
    }

    reset(key: string): void {
        this.attempts.delete(key);
    }

    /** 0 below the limit, then doubling from 250 ms up to `backoffMaxMs`. */
    private delayFor(count: number): number {
        const over = count - this.maxAttempts;
        if (over < 0) return 0;
        return Math.min(this.backoffMaxMs, 250 * 2 ** over);
    }

    /** Bound memory under many distinct sources: drop expired windows. */
    private sweep(now: number): void {
        if (this.attempts.size < 1024) return;
        for (const [key, entry] of this.attempts) {
            if (now - entry.windowStart > this.windowMs && !this.active.has(key)) this.attempts.delete(key);
        }
    }
}
