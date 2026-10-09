import { describe, expect, test } from "bun:test";
import {
    LoginRateLimiter,
    SessionStore,
    hashPassword,
    parseCookies,
    randomToken,
    safeEqual,
    verifyPassword,
} from "../src/auth.ts";

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
});

describe("LoginRateLimiter", () => {
    test("blocks after the maximum number of failures", () => {
        let now = 0;
        const limiter = new LoginRateLimiter(3, 1000, 5000, () => now);
        expect(limiter.check("k").allowed).toBe(true);
        limiter.recordFailure("k");
        limiter.recordFailure("k");
        expect(limiter.check("k").allowed).toBe(true);
        limiter.recordFailure("k");
        const verdict = limiter.check("k");
        expect(verdict.allowed).toBe(false);
        expect(verdict.retryAfterSec).toBe(5);
    });

    test("unblocks after the block window and resets on success", () => {
        let now = 0;
        const limiter = new LoginRateLimiter(2, 1000, 5000, () => now);
        limiter.recordFailure("k");
        limiter.recordFailure("k");
        expect(limiter.check("k").allowed).toBe(false);
        now = 5001;
        expect(limiter.check("k").allowed).toBe(true);
        limiter.recordFailure("k");
        limiter.reset("k");
        expect(limiter.check("k").allowed).toBe(true);
    });
});
