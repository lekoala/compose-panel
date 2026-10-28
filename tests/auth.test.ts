import { describe, expect, test } from "bun:test";
import { LoginRateLimiter, SessionStore, hashPassword, parseCookies, randomToken, safeEqual, verifyPassword } from "../src/auth.ts";

describe("safeEqual", () => {
    test("matches identical non-empty strings", () => expect(safeEqual("abc", "abc")).toBe(true));
    test("rejects different strings of equal length", () => expect(safeEqual("abc", "abd")).toBe(false));
    test("rejects different lengths without throwing", () => expect(safeEqual("abc", "abcd")).toBe(false));
    test("rejects empty strings", () => expect(safeEqual("", "")).toBe(false));
});

describe("parseCookies", () => {
    test("parses multiple cookies and trims values", () => {
        expect(parseCookies("a=1; cp_session=xyz ; b=2")).toEqual({ a: "1", cp_session: "xyz", b: "2" });
    });
    test("returns an empty object for a missing header", () => expect(parseCookies(null)).toEqual({}));
});

test("randomToken is unique and url-safe", () => {
    const a = randomToken();
    const b = randomToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
});

describe("password hashing", () => {
    test("verifies the correct password and rejects a wrong one", async () => {
        const hash = await hashPassword("correct horse battery staple");
        expect(await verifyPassword(hash, "correct horse battery staple")).toBe(true);
        expect(await verifyPassword(hash, "wrong")).toBe(false);
    });
    test("does not throw on an invalid hash", async () => {
        expect(await verifyPassword("not-a-hash", "x")).toBe(false);
    });
});

describe("SessionStore", () => {
    test("creates, reads and destroys a session", () => {
        const store = new SessionStore(1000, 1000, () => 0);
        const session = store.create("admin");
        expect(store.get(session.id)?.user).toBe("admin");
        store.destroy(session.id);
        expect(store.get(session.id)).toBeNull();
    });

    test("expires a session after its absolute TTL", () => {
        let now = 0;
        const store = new SessionStore(1000, 10_000, () => now);
        const session = store.create("admin");
        now = 1001;
        expect(store.get(session.id)).toBeNull();
    });

    test("expires a session after its idle timeout", () => {
        let now = 0;
        const store = new SessionStore(10_000, 1000, () => now);
        const session = store.create("admin");
        now = 1001;
        expect(store.get(session.id)).toBeNull();
    });

    test("rotates the session id on each login", () => {
        const store = new SessionStore(1000, 1000, () => 0);
        expect(store.create("admin").id).not.toBe(store.create("admin").id);
    });

    test("isActive reports validity without refreshing idle activity", () => {
        let now = 0;
        const store = new SessionStore(10_000, 1000, () => now);
        const session = store.create("admin");
        now = 900;
        expect(store.isActive(session.id)).toBe(true);
        // The stream heartbeat relies on this not counting as activity.
        now = 1001;
        expect(store.isActive(session.id)).toBe(false);
    });
});

describe("LoginRateLimiter", () => {
    test("grows a bounded delay instead of blocking once over the limit", () => {
        const now = 0;
        const limiter = new LoginRateLimiter(3, 1000, 8000, () => now);
        expect(limiter.check("k").delayMs).toBe(0);
        limiter.recordFailure("k");
        limiter.recordFailure("k");
        expect(limiter.check("k").delayMs).toBe(0);
        limiter.recordFailure("k"); // count === max: the next attempt is delayed
        const first = limiter.check("k");
        expect(first.allowed).toBe(true);
        expect(first.delayMs).toBe(250);
        limiter.recordFailure("k");
        expect(limiter.check("k").delayMs).toBe(500);
    });

    test("caps the delay and clears it on reset or after the window", () => {
        let now = 0;
        const limiter = new LoginRateLimiter(2, 1000, 500, () => now);
        for (let i = 0; i < 8; i += 1) limiter.recordFailure("k");
        expect(limiter.check("k").delayMs).toBe(500);
        limiter.reset("k");
        expect(limiter.check("k").delayMs).toBe(0);
        limiter.recordFailure("k");
        limiter.recordFailure("k");
        expect(limiter.check("k").delayMs).toBeGreaterThan(0);
        now = 1001;
        expect(limiter.check("k").delayMs).toBe(0);
    });
});

describe("LoginRateLimiter reservations", () => {
    test("over-limit attempts are delayed, never refused by count", () => {
        const limiter = new LoginRateLimiter(5, 60_000, 60_000, () => 0, 100);
        const delays: number[] = [];
        for (let i = 0; i < 12; i += 1) {
            const verdict = limiter.tryReserve("k");
            expect(verdict.allowed).toBe(true);
            delays.push(verdict.delayMs);
            limiter.settle("k", false, limiter.acquireSlot());
        }
        expect(delays.slice(0, 5).every((delay) => delay === 0)).toBe(true);
        expect(delays.slice(5).every((delay) => delay > 0)).toBe(true);
    });

    test("refuses a parallel attempt from the same key so its delay cannot be bypassed", () => {
        const limiter = new LoginRateLimiter(5, 60_000, 60_000, () => 0, 100);
        expect(limiter.tryReserve("k").allowed).toBe(true);
        expect(limiter.tryReserve("k").allowed).toBe(false);
        // Other sources are unaffected.
        expect(limiter.tryReserve("other").allowed).toBe(true);
        limiter.settle("k", false, false);
        expect(limiter.tryReserve("k").allowed).toBe(true);
    });

    test("waiting attempts do not hold global slots; the cap applies only to verifications", () => {
        const limiter = new LoginRateLimiter(100, 60_000, 60_000, () => 0, 3);
        // Ten sources reserved (e.g. sleeping on their delay): no slot taken yet.
        for (let i = 0; i < 10; i += 1) expect(limiter.tryReserve(`k${i}`).allowed).toBe(true);
        expect(limiter.acquireSlot()).toBe(true);
        expect(limiter.acquireSlot()).toBe(true);
        expect(limiter.acquireSlot()).toBe(true);
        expect(limiter.acquireSlot()).toBe(false);
        limiter.settle("k0", false, true);
        expect(limiter.acquireSlot()).toBe(true);
    });

    test("a correct credential releases only its own reservation", () => {
        const limiter = new LoginRateLimiter(3, 60_000, 60_000, () => 0, 100);
        limiter.tryReserve("k");
        limiter.settle("k", false, false); // count 1
        limiter.tryReserve("k");
        limiter.settle("k", false, false); // count 2
        limiter.tryReserve("k");
        limiter.settle("k", true, false); // count 1, not 0
        limiter.tryReserve("k");
        limiter.settle("k", false, false); // count 2
        limiter.tryReserve("k");
        limiter.settle("k", false, false); // count 3
        // Prior failures carried over: the next attempt is delayed. A full reset
        // on success would have left it at 0 and undelayed.
        expect(limiter.tryReserve("k").delayMs).toBeGreaterThan(0);
    });
});

describe("LoginRateLimiter tracked-key bound", () => {
    test("refuses new keys at capacity without evicting or resetting tracked ones", () => {
        let now = 0;
        const limiter = new LoginRateLimiter(1, 1000, 60_000, () => now, 100, 50);
        for (let i = 0; i < 50; i += 1) {
            const key = `2001:db8::${i.toString(16)}`;
            expect(limiter.tryReserve(key).allowed).toBe(true);
            limiter.settle(key, false, false);
        }
        expect(limiter.trackedKeys()).toBe(50);

        now = 400;
        const refused = limiter.tryReserve("2001:db8::fresh");
        expect(refused.allowed).toBe(false);
        expect(refused.reason).toBe("capacity");
        expect(refused.retryAfterSec).toBe(1);
        expect(limiter.trackedKeys()).toBe(50);

        // A tracked key keeps its count: its next attempt is still delayed.
        const tracked = limiter.tryReserve("2001:db8::0");
        expect(tracked.allowed).toBe(true);
        expect(tracked.delayMs).toBeGreaterThan(0);
        limiter.settle("2001:db8::0", false, false);

        // Once windows expire, room is made again.
        now = 1001;
        expect(limiter.tryReserve("2001:db8::fresh").allowed).toBe(true);
        expect(limiter.trackedKeys()).toBe(1);
    });

    test("expiry keeps window order when a window restarts", () => {
        let now = 0;
        const limiter = new LoginRateLimiter(5, 100, 1000, () => now, 100, 1000);
        limiter.tryReserve("a");
        limiter.settle("a", false, false);
        now = 10;
        limiter.tryReserve("b");
        limiter.settle("b", false, false);
        now = 150; // a expired: its window restarts and it moves behind b
        limiter.tryReserve("a");
        limiter.settle("a", false, false);
        now = 205; // b expired, a (150) still live
        limiter.tryReserve("c");
        limiter.settle("c", false, false);
        expect(limiter.trackedKeys()).toBe(2);
        expect(limiter.check("a").delayMs).toBe(0);
    });

    test("an expired key still in progress is not dropped", () => {
        let now = 0;
        const limiter = new LoginRateLimiter(5, 100, 1000, () => now, 100, 1000);
        limiter.tryReserve("slow"); // left active
        now = 500;
        limiter.tryReserve("other");
        limiter.settle("other", false, false);
        expect(limiter.trackedKeys()).toBe(2);
        expect(limiter.tryReserve("slow").reason).toBe("parallel");
    });
});
