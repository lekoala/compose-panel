import { describe, expect, test } from "bun:test";
import type { Stats } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManagedSiteManifest } from "../src/managed-site.ts";
import {
    MANAGED_SITE_CI_MAX_NONCES,
    MANAGED_SITE_CI_REPLAY_WINDOW_MS,
    MANAGED_SITE_CI_STATE_FILE,
    MANAGED_SITE_CI_VERIFIER_FILE,
    acceptManagedSiteCiNonce,
    checkManagedSiteCiVerifier,
    hashManagedSiteCiToken,
    initialManagedSiteCiState,
    isManagedSiteCiToken,
    managedSiteCiDir,
    managedSiteCiNonceSeen,
    managedSiteCiStatePath,
    managedSiteCiVerifierPath,
    parseManagedSiteCiBody,
    parseManagedSiteCiState,
    pruneManagedSiteCiNonces,
    readManagedSiteCiState,
    verifyManagedSiteCiToken,
    writeManagedSiteCiState,
    type ManagedSiteCiState,
} from "../src/managed-site-ci.ts";

const stackDir = "/opt/stacks/acme-shop";
const TOKEN = "a".repeat(64);
const OTHER = "b".repeat(64);
const DIGEST = hashManagedSiteCiToken(TOKEN);

function manifest(overrides: Partial<ManagedSiteManifest> = {}): ManagedSiteManifest {
    return {
        version: 3,
        siteId: "acme-shop",
        owner: "managed",
        project: "acme-shop",
        services: { gateway: "gateway", runtime: "runtime" },
        gateway: { port: 41001 },
        publicRoot: "public",
        runtime: { profile: "php-front-controller", image: "php:8.3-fpm-alpine" },
        deploy: { kind: "bind-mount", git: { url: "https://github.com/acme/shop.git", ref: "refs/heads/main" } },
        paths: ["shared/uploads"],
        generation: "1",
        ci: { kind: "token" },
        ...overrides,
    };
}

function stats(
    options: { mode?: number; uid?: number; size?: number; nlink?: number; file?: boolean; directory?: boolean; link?: boolean } = {},
): Stats {
    return {
        isFile: () => options.file ?? true,
        isDirectory: () => options.directory ?? false,
        isSymbolicLink: () => options.link ?? false,
        mode: options.mode ?? 0o100600,
        uid: options.uid ?? 1000,
        size: options.size ?? 65,
        nlink: options.nlink ?? 1,
    } as unknown as Stats;
}

const directoryStat = stats({ file: false, directory: true, mode: 0o40700 });
const dir = managedSiteCiDir(stackDir);
const verifier = managedSiteCiVerifierPath(stackDir);

function fakeFs(entries: Record<string, Stats>, content = `${DIGEST}\n`) {
    return {
        ownerUid: 1000,
        lstat: async (path: string) => {
            const entry = entries[path];
            if (!entry) throw Object.assign(new Error("missing"), { code: "ENOENT" });
            return entry;
        },
        read: async (path: string) => (path === verifier ? { source: content } : null),
    };
}

describe("checkManagedSiteCiVerifier", () => {
    test("accepts a 0700 directory and a 0600 digest, with or without a newline", async () => {
        expect(await checkManagedSiteCiVerifier(stackDir, fakeFs({ [dir]: directoryStat, [verifier]: stats() }))).toEqual({
            ok: true,
            digest: DIGEST,
        });
        const bare = await checkManagedSiteCiVerifier(stackDir, fakeFs({ [dir]: directoryStat, [verifier]: stats({ size: 64 }) }, DIGEST));
        expect(bare).toEqual({ ok: true, digest: DIGEST });
    });

    test("refuses a missing, symlinked or loose directory", async () => {
        expect((await checkManagedSiteCiVerifier(stackDir, fakeFs({}))).ok).toBe(false);
        expect((await checkManagedSiteCiVerifier(stackDir, fakeFs({ [dir]: stats({ file: false, link: true }) }))).ok).toBe(false);
        expect(
            (await checkManagedSiteCiVerifier(stackDir, fakeFs({ [dir]: stats({ file: false, directory: true, mode: 0o40755 }) }))).ok,
        ).toBe(false);
        expect((await checkManagedSiteCiVerifier(stackDir, fakeFs({ [dir]: stats({ file: false, directory: true, uid: 1001 }) }))).ok).toBe(
            false,
        );
    });

    test("refuses a missing, linked, loose or oversized verifier", async () => {
        const base = { [dir]: directoryStat };
        expect((await checkManagedSiteCiVerifier(stackDir, fakeFs(base))).ok).toBe(false);
        expect((await checkManagedSiteCiVerifier(stackDir, fakeFs({ ...base, [verifier]: stats({ link: true }) }))).ok).toBe(false);
        expect((await checkManagedSiteCiVerifier(stackDir, fakeFs({ ...base, [verifier]: stats({ nlink: 2 }) }))).ok).toBe(false);
        expect((await checkManagedSiteCiVerifier(stackDir, fakeFs({ ...base, [verifier]: stats({ mode: 0o100644 }) }))).ok).toBe(false);
        expect((await checkManagedSiteCiVerifier(stackDir, fakeFs({ ...base, [verifier]: stats({ size: 257 }) }))).ok).toBe(false);
        expect((await checkManagedSiteCiVerifier(stackDir, fakeFs({ ...base, [verifier]: stats({ size: 0 }) }))).ok).toBe(false);
    });

    test("refuses a malformed digest and a changed file", async () => {
        const base = { [dir]: directoryStat, [verifier]: stats() };
        expect((await checkManagedSiteCiVerifier(stackDir, fakeFs(base, "not-a-digest\n"))).ok).toBe(false);
        expect((await checkManagedSiteCiVerifier(stackDir, fakeFs(base, `${DIGEST.toUpperCase()}\n`))).ok).toBe(false);
        const unreadable = { ...fakeFs(base), read: async () => null };
        expect((await checkManagedSiteCiVerifier(stackDir, unreadable)).ok).toBe(false);
    });

    test("skips the ownership check where the platform has no process uid", async () => {
        const checked = await checkManagedSiteCiVerifier(stackDir, {
            ...fakeFs({ [dir]: stats({ file: false, directory: true, mode: 0o40700, uid: 9999 }), [verifier]: stats({ uid: 9999 }) }),
            ownerUid: null,
        });
        expect(checked.ok).toBe(true);
    });
});

describe("CI token", () => {
    test("bounds the token format", () => {
        expect(isManagedSiteCiToken(TOKEN)).toBe(true);
        expect(isManagedSiteCiToken("a".repeat(32))).toBe(true);
        expect(isManagedSiteCiToken("a".repeat(128))).toBe(true);
        expect(isManagedSiteCiToken("a".repeat(31))).toBe(false);
        expect(isManagedSiteCiToken("a".repeat(129))).toBe(false);
        expect(isManagedSiteCiToken(`bad token ${"a".repeat(40)}`)).toBe(false);
        expect(isManagedSiteCiToken(`${"a".repeat(40)}.`)).toBe(false);
    });

    test("compares only the matching token", () => {
        expect(verifyManagedSiteCiToken(TOKEN, DIGEST)).toBe(true);
        expect(verifyManagedSiteCiToken(OTHER, DIGEST)).toBe(false);
        expect(verifyManagedSiteCiToken(TOKEN, DIGEST.toUpperCase())).toBe(false);
        expect(verifyManagedSiteCiToken("short", DIGEST)).toBe(false);
    });
});

describe("parseManagedSiteCiBody", () => {
    const now = Date.parse("2026-11-25T10:00:00.000Z");
    const valid = {
        sha: "c".repeat(40),
        ref: "refs/heads/main",
        nonce: "n".repeat(20),
        timestamp: "2026-11-25T10:00:00.000Z",
    };
    const parse = (value: unknown, at = now) => parseManagedSiteCiBody(JSON.stringify(value), manifest(), at);

    test("accepts exactly one bounded request", () => {
        const result = parse(valid);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.request.sha).toBe(valid.sha);
        expect(result.request.at).toBe(now);
    });

    test("refuses another ref, a decorated SHA, a bad nonce and an unknown field", () => {
        expect(parse({ ...valid, ref: "refs/heads/dev" }).ok).toBe(false);
        expect(parse({ ...valid, sha: "C".repeat(40) }).ok).toBe(false);
        expect(parse({ ...valid, sha: "c".repeat(39) }).ok).toBe(false);
        expect(parse({ ...valid, nonce: "short" }).ok).toBe(false);
        expect(parse({ ...valid, nonce: `${"n".repeat(20)}.` }).ok).toBe(false);
        expect(parse({ ...valid, extra: true }).ok).toBe(false);
        const { nonce: _drop, ...missing } = valid;
        expect(parse(missing).ok).toBe(false);
        expect(parse([valid]).ok).toBe(false);
        expect(parseManagedSiteCiBody("not json", manifest(), now).ok).toBe(false);
    });

    test("enforces the replay window in both directions", () => {
        const late = now + MANAGED_SITE_CI_REPLAY_WINDOW_MS + 1;
        const early = now - MANAGED_SITE_CI_REPLAY_WINDOW_MS - 1;
        expect(parse(valid, late).ok).toBe(false);
        expect(parse(valid, early).ok).toBe(false);
        expect(parse(valid, now + MANAGED_SITE_CI_REPLAY_WINDOW_MS).ok).toBe(true);
        expect(parse({ ...valid, timestamp: "yesterday" }).ok).toBe(false);
    });

    test("refuses an oversized body before parsing", () => {
        const padded = JSON.stringify({ ...valid, padding: "x".repeat(9000) });
        expect(parseManagedSiteCiBody(padded, manifest(), now).ok).toBe(false);
    });
});

describe("CI state", () => {
    const state: ManagedSiteCiState = {
        version: 1,
        siteId: "acme-shop",
        ref: "refs/heads/main",
        lastAttempt: { at: "2026-11-25T10:00:00.000Z", sha: "c".repeat(40), result: "accepted" },
        nonces: [{ nonce: "n".repeat(20), at: "2026-11-25T10:00:00.000Z" }],
    };

    test("round-trips and rejects unknown or out-of-bounds records", () => {
        expect(parseManagedSiteCiState(JSON.stringify(state), "acme-shop")).toEqual(state);
        expect(parseManagedSiteCiState(JSON.stringify({ ...state, extra: 1 }), "acme-shop")).toBeNull();
        expect(parseManagedSiteCiState(JSON.stringify(state), "other")).toBeNull();
        expect(parseManagedSiteCiState(JSON.stringify({ ...state, version: 2 }), "acme-shop")).toBeNull();
        expect(
            parseManagedSiteCiState(JSON.stringify({ ...state, lastAttempt: { ...state.lastAttempt, sha: "short" } }), "acme-shop"),
        ).toBeNull();
        expect(parseManagedSiteCiState("not json", "acme-shop")).toBeNull();
        const tooMany = { ...state, nonces: Array.from({ length: MANAGED_SITE_CI_MAX_NONCES + 1 }, () => state.nonces[0]!) };
        expect(parseManagedSiteCiState(JSON.stringify(tooMany), "acme-shop")).toBeNull();
    });

    test("consumes a nonce, detects it and prunes the window", () => {
        const base = initialManagedSiteCiState(manifest());
        const at = Date.parse("2026-11-25T10:00:00.000Z");
        expect(base.nonces).toEqual([]);
        const accepted = acceptManagedSiteCiNonce(base, "n".repeat(20), "2026-11-25T10:00:00.000Z", at);
        expect(managedSiteCiNonceSeen(accepted, "n".repeat(20))).toBe(true);
        expect(managedSiteCiNonceSeen(accepted, "m".repeat(20))).toBe(false);
        const later = Date.parse("2026-11-25T10:06:00.000Z");
        expect(pruneManagedSiteCiNonces(accepted, later).nonces).toEqual([]);
        expect(pruneManagedSiteCiNonces(accepted, at + 1000).nonces).toHaveLength(1);
    });

    test("keeps only the newest bounded nonce set", () => {
        let current = initialManagedSiteCiState(manifest());
        const at = Date.parse("2026-11-25T10:00:00.000Z");
        for (let index = 0; index < MANAGED_SITE_CI_MAX_NONCES + 5; index += 1) {
            current = acceptManagedSiteCiNonce(current, `n${String(index).padStart(19, "0")}`, "2026-11-25T10:00:00.000Z", at);
        }
        expect(current.nonces).toHaveLength(MANAGED_SITE_CI_MAX_NONCES);
        expect(current.nonces[0]!.nonce).toBe(`n${String(5).padStart(19, "0")}`);
        expect(current.nonces.at(-1)!.nonce).toBe(`n${String(MANAGED_SITE_CI_MAX_NONCES + 4).padStart(19, "0")}`);
    });

    test("writes and reads the state from the fixed private path", async () => {
        const root = await mkdtemp(join(tmpdir(), "compose-panel-ci-"));
        try {
            await mkdir(managedSiteCiDir(root), { recursive: true, mode: 0o700 });
            expect(managedSiteCiStatePath(root)).toBe(`${managedSiteCiDir(root)}/${MANAGED_SITE_CI_STATE_FILE}`);
            expect(managedSiteCiVerifierPath(root)).toBe(`${managedSiteCiDir(root)}/${MANAGED_SITE_CI_VERIFIER_FILE}`);
            expect(await readManagedSiteCiState(root, "acme-shop")).toEqual({ kind: "none" });
            await writeManagedSiteCiState(root, state);
            expect(await readManagedSiteCiState(root, "acme-shop")).toEqual({ kind: "ok", state });
            expect(JSON.parse(await readFile(managedSiteCiStatePath(root), "utf8"))).toEqual(state);
            await writeFile(managedSiteCiStatePath(root), "{not json");
            expect(await readManagedSiteCiState(root, "acme-shop")).toEqual({ kind: "unreadable" });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
