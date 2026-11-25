import { describe, expect, test } from "bun:test";
import type { Stats } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashMachineToken } from "../src/machine-credential.ts";
import {
    MANAGED_SITE_BACKUP_TRIGGER_MAX_BODY_BYTES,
    MANAGED_SITE_BACKUP_TRIGGER_MAX_NONCES,
    MANAGED_SITE_BACKUP_TRIGGER_STATE_FILE,
    MANAGED_SITE_BACKUP_TRIGGER_STATE_MAX_BYTES,
    acceptManagedSiteBackupTriggerNonce,
    checkManagedSiteBackupTriggerVerifier,
    initialManagedSiteBackupTriggerState,
    managedSiteBackupFreshness,
    managedSiteBackupTriggerNonceSeen,
    managedSiteBackupTriggerStatePath,
    managedSiteBackupTriggerVerifierPath,
    parseManagedSiteBackupTriggerBody,
    parseManagedSiteBackupTriggerState,
    readManagedSiteBackupTriggerState,
    updateManagedSiteBackupTriggerState,
    writeManagedSiteBackupTriggerState,
    type ManagedSiteBackupTriggerState,
} from "../src/managed-site-backup-trigger.ts";

const STACK = "/opt/stacks/acme-shop";
const TOKEN = "b".repeat(64);
const DIGEST = hashMachineToken(TOKEN);
const SNAPSHOT = "c".repeat(64);
const NOW = Date.parse("2026-11-25T10:00:00.000Z");
const STAMP = "2026-11-25T10:00:00.000Z";

function state(overrides: Partial<ManagedSiteBackupTriggerState> = {}): ManagedSiteBackupTriggerState {
    return {
        version: 1,
        siteId: "acme-shop",
        lastAttempt: null,
        lastSuccess: null,
        lastProof: null,
        nonces: [],
        ...overrides,
    };
}

function stats(options: { mode?: number; uid?: number; file?: boolean } = {}): Stats {
    return {
        isFile: () => options.file ?? false,
        isDirectory: () => !(options.file ?? false),
        isSymbolicLink: () => false,
        mode: options.mode ?? 0o40700,
        uid: options.uid ?? 1000,
        size: 65,
        nlink: 1,
    } as unknown as Stats;
}

describe("backup trigger paths and verifier", () => {
    test("names the fixed files under the private backup directory", () => {
        expect(managedSiteBackupTriggerVerifierPath(STACK)).toBe(`${STACK}/site/private/backup/trigger-token.sha256`);
        expect(managedSiteBackupTriggerStatePath(STACK)).toBe(`${STACK}/site/private/backup/${MANAGED_SITE_BACKUP_TRIGGER_STATE_FILE}`);
    });

    test("accepts a fixed 0700 directory with a 0600 digest", async () => {
        const dir = `${STACK}/site/private/backup`;
        const checked = await checkManagedSiteBackupTriggerVerifier(STACK, {
            ownerUid: 1000,
            lstat: async (path) => {
                if (path === dir) return stats({ mode: 0o40700 });
                if (path === managedSiteBackupTriggerVerifierPath(STACK)) return stats({ file: true, mode: 0o100600 });
                throw Object.assign(new Error("missing"), { code: "ENOENT" });
            },
            read: async () => ({ source: `${DIGEST}\n` }),
        });
        expect(checked).toEqual({ ok: true, digest: DIGEST });
    });

    test("refuses a missing verifier with a labelled reason", async () => {
        const dir = `${STACK}/site/private/backup`;
        const checked = await checkManagedSiteBackupTriggerVerifier(STACK, {
            ownerUid: 1000,
            lstat: async (path) => {
                if (path === dir) return stats({ mode: 0o40700 });
                throw Object.assign(new Error("missing"), { code: "ENOENT" });
            },
        });
        expect(checked.ok).toBe(false);
        if (!checked.ok) expect(checked.reason).toContain("backup trigger verifier");
    });
});

describe("parseManagedSiteBackupTriggerBody", () => {
    test("accepts exactly one bounded nonce and timestamp", () => {
        const parsed = parseManagedSiteBackupTriggerBody(JSON.stringify({ nonce: "n".repeat(24), timestamp: STAMP }), NOW);
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        expect(parsed.request.nonce).toBe("n".repeat(24));
        expect(parsed.request.at).toBe(NOW);
    });

    test("refuses a deploy-shaped, extra, missing or malformed field", () => {
        const valid = { nonce: "n".repeat(24), timestamp: STAMP };
        const parse = (value: unknown) => parseManagedSiteBackupTriggerBody(JSON.stringify(value), NOW);
        expect(parse({ ...valid, sha: "d".repeat(40) }).ok).toBe(false);
        expect(parse({ ...valid, ref: "refs/heads/main" }).ok).toBe(false);
        expect(parse({ nonce: valid.nonce }).ok).toBe(false);
        expect(parse({ timestamp: valid.timestamp }).ok).toBe(false);
        expect(parse({ ...valid, nonce: "short" }).ok).toBe(false);
        expect(parse({ ...valid, timestamp: "yesterday" }).ok).toBe(false);
        expect(parse([valid]).ok).toBe(false);
        expect(parseManagedSiteBackupTriggerBody("not json", NOW).ok).toBe(false);
        expect(
            parseManagedSiteBackupTriggerBody(
                JSON.stringify({ ...valid, padding: "x".repeat(MANAGED_SITE_BACKUP_TRIGGER_MAX_BODY_BYTES) }),
                NOW,
            ).ok,
        ).toBe(false);
    });

    test("enforces the replay window in both directions", () => {
        const body = JSON.stringify({ nonce: "n".repeat(24), timestamp: STAMP });
        expect(parseManagedSiteBackupTriggerBody(body, NOW + 300_000).ok).toBe(true);
        expect(parseManagedSiteBackupTriggerBody(body, NOW + 300_001).ok).toBe(false);
        expect(parseManagedSiteBackupTriggerBody(body, NOW - 300_001).ok).toBe(false);
    });
});

describe("backup trigger state", () => {
    test("round-trips the three distinct facts and the nonce list", () => {
        const value = state({
            lastAttempt: { at: STAMP, result: "succeeded" },
            lastSuccess: { at: STAMP, snapshotId: SNAPSHOT },
            lastProof: { at: STAMP, snapshotId: SNAPSHOT },
            nonces: [{ nonce: "n".repeat(20), at: STAMP }],
        });
        expect(parseManagedSiteBackupTriggerState(JSON.stringify(value), "acme-shop")).toEqual(value);
    });

    test("refuses unknown fields, another site, a bad snapshot or an oversized record", () => {
        expect(parseManagedSiteBackupTriggerState(JSON.stringify({ ...state(), extra: 1 }), "acme-shop")).toBeNull();
        expect(parseManagedSiteBackupTriggerState(JSON.stringify(state()), "other")).toBeNull();
        expect(parseManagedSiteBackupTriggerState(JSON.stringify({ ...state(), version: 2 }), "acme-shop")).toBeNull();
        expect(
            parseManagedSiteBackupTriggerState(JSON.stringify(state({ lastSuccess: { at: STAMP, snapshotId: "short" } })), "acme-shop"),
        ).toBeNull();
        expect(
            parseManagedSiteBackupTriggerState(
                JSON.stringify(state({ lastAttempt: { at: STAMP, result: "maybe" as "failed" } })),
                "acme-shop",
            ),
        ).toBeNull();
        expect(
            parseManagedSiteBackupTriggerState(
                JSON.stringify({
                    ...state(),
                    nonces: Array.from({ length: MANAGED_SITE_BACKUP_TRIGGER_MAX_NONCES + 1 }, () => ({
                        nonce: "n".repeat(20),
                        at: STAMP,
                    })),
                }),
                "acme-shop",
            ),
        ).toBeNull();
        expect(
            parseManagedSiteBackupTriggerState(
                JSON.stringify({ ...state(), padding: "x".repeat(MANAGED_SITE_BACKUP_TRIGGER_STATE_MAX_BYTES) }),
                "acme-shop",
            ),
        ).toBeNull();
    });

    test("writes, updates and reads the facts inside the private backup directory", async () => {
        const root = await mkdtemp(join(tmpdir(), "compose-panel-backup-trigger-"));
        try {
            await mkdir(join(root, "site", "private", "backup"), { recursive: true, mode: 0o700 });
            expect(await readManagedSiteBackupTriggerState(root, "acme-shop")).toEqual({ kind: "none" });

            const created = await updateManagedSiteBackupTriggerState(root, "acme-shop", (current) => ({
                ...current,
                lastAttempt: { at: STAMP, result: "accepted" },
                nonces: acceptManagedSiteBackupTriggerNonce(current, "n".repeat(20), STAMP, NOW).nonces,
            }));
            expect(created.ok).toBe(true);

            const updated = await updateManagedSiteBackupTriggerState(root, "acme-shop", (current) => ({
                ...current,
                lastSuccess: { at: STAMP, snapshotId: SNAPSHOT },
            }));
            expect(updated.ok).toBe(true);
            const read = await readManagedSiteBackupTriggerState(root, "acme-shop");
            expect(read.kind).toBe("ok");
            if (read.kind !== "ok") return;
            expect(read.state.lastAttempt).toEqual({ at: STAMP, result: "accepted" });
            expect(read.state.lastSuccess).toEqual({ at: STAMP, snapshotId: SNAPSHOT });
            expect(read.state.lastProof).toBeNull();
            expect(read.state.nonces).toHaveLength(1);
            expect(await readFile(managedSiteBackupTriggerStatePath(root), "utf8")).toContain(SNAPSHOT);

            await writeFile(managedSiteBackupTriggerStatePath(root), "{broken");
            expect(await readManagedSiteBackupTriggerState(root, "acme-shop")).toEqual({ kind: "unreadable" });
            const refused = await updateManagedSiteBackupTriggerState(root, "acme-shop", (current) => current);
            expect(refused.ok).toBe(false);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("consumes a nonce once and keeps the newest bounded set", () => {
        let current = initialManagedSiteBackupTriggerState("acme-shop");
        current = acceptManagedSiteBackupTriggerNonce(current, "n".repeat(20), STAMP, NOW);
        expect(managedSiteBackupTriggerNonceSeen(current, "n".repeat(20))).toBe(true);
        expect(managedSiteBackupTriggerNonceSeen(current, "m".repeat(20))).toBe(false);
        for (let index = 0; index < MANAGED_SITE_BACKUP_TRIGGER_MAX_NONCES + 2; index += 1) {
            current = acceptManagedSiteBackupTriggerNonce(current, `x${String(index).padStart(19, "0")}`, STAMP, NOW);
        }
        expect(current.nonces).toHaveLength(MANAGED_SITE_BACKUP_TRIGGER_MAX_NONCES);
    });
});

describe("managedSiteBackupFreshness", () => {
    test("reports overdue when no backup succeeded yet", () => {
        expect(managedSiteBackupFreshness(state(), 24, NOW)).toEqual({ overdue: true, dueAt: null });
    });

    test("uses the durable timestamp and the declared interval", () => {
        const backedUp = state({ lastSuccess: { at: STAMP, snapshotId: SNAPSHOT } });
        expect(managedSiteBackupFreshness(backedUp, 24, NOW + 23 * 3_600_000)).toEqual({
            overdue: false,
            dueAt: "2026-11-26T10:00:00.000Z",
        });
        expect(managedSiteBackupFreshness(backedUp, 24, NOW + 24 * 3_600_000).overdue).toBe(false);
        expect(managedSiteBackupFreshness(backedUp, 24, NOW + 24 * 3_600_000 + 1).overdue).toBe(true);
        expect(managedSiteBackupFreshness(backedUp, 1, NOW + 2 * 3_600_000).overdue).toBe(true);
    });

    test("keeps reporting overdue after a long panel outage", () => {
        const backedUp = state({ lastSuccess: { at: "2026-11-01T00:00:00.000Z", snapshotId: SNAPSHOT } });
        const result = managedSiteBackupFreshness(backedUp, 24, NOW);
        expect(result.overdue).toBe(true);
        expect(result.dueAt).toBe("2026-11-02T00:00:00.000Z");
    });
});
