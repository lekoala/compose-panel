import { describe, expect, test } from "bun:test";
import type { Stats } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    MACHINE_MAX_FAILURES,
    MACHINE_MAX_NONCES,
    MACHINE_WINDOW_MS,
    MachineAuthLimiter,
    acceptMachineNonce,
    checkMachineDigestFile,
    hashMachineToken,
    machineNonceSeen,
    parseMachineNonceList,
    parseMachineTimestamp,
    pruneMachineNonces,
    verifyMachineToken,
    writeMachineJsonFile,
} from "../src/machine-credential.ts";

const TOKEN = "t".repeat(64);
const DIGEST = hashMachineToken(TOKEN);
const NOW = Date.parse("2026-11-25T10:00:00.000Z");

function stats(
    options: { mode?: number; uid?: number; size?: number; nlink?: number; file?: boolean; directory?: boolean; link?: boolean } = {},
): Stats {
    return {
        isFile: () => options.file ?? false,
        isDirectory: () => options.directory ?? true,
        isSymbolicLink: () => options.link ?? false,
        mode: options.mode ?? 0o40700,
        uid: options.uid ?? 1000,
        size: options.size ?? 65,
        nlink: options.nlink ?? 1,
    } as unknown as Stats;
}

describe("machine token", () => {
    test("compares only the hashed token in constant time", () => {
        expect(verifyMachineToken(TOKEN, DIGEST)).toBe(true);
        expect(verifyMachineToken("u".repeat(64), DIGEST)).toBe(false);
        expect(verifyMachineToken(TOKEN, DIGEST.toUpperCase())).toBe(false);
        expect(verifyMachineToken("short", DIGEST)).toBe(false);
    });
});

describe("checkMachineDigestFile", () => {
    const dir = "/opt/stacks/acme/site/private/example";
    const file = `${dir}/token.sha256`;
    const base = {
        dir,
        file,
        dirLabel: "example credential",
        fileLabel: "example verifier",
        missingDirHint: "Create it with mode 0700.",
        ownerUid: 1000,
    };

    function fs(entries: Record<string, Stats>, content = `${DIGEST}\n`) {
        return {
            lstat: async (path: string) => {
                const entry = entries[path];
                if (!entry) throw Object.assign(new Error("missing"), { code: "ENOENT" });
                return entry;
            },
            read: async () => ({ source: content }),
        };
    }

    test("returns the digest when the directory and file metadata are fixed", async () => {
        const checked = await checkMachineDigestFile({
            ...base,
            ...fs({ [dir]: stats(), [file]: stats({ file: true, mode: 0o100600 }) }),
        });
        expect(checked).toEqual({ ok: true, digest: DIGEST });
    });

    test("names the label and refuses every unsafe shape", async () => {
        const missingDir = await checkMachineDigestFile({ ...base, ...fs({}) });
        expect(missingDir.ok).toBe(false);
        if (!missingDir.ok) expect(missingDir.reason).toContain("example credential");

        const missingFile = await checkMachineDigestFile({ ...base, ...fs({ [dir]: stats() }) });
        expect(missingFile.ok).toBe(false);
        if (!missingFile.ok) expect(missingFile.reason).toContain("example verifier");

        const looseDirectory = await checkMachineDigestFile({
            ...base,
            ...fs({ [dir]: stats({ mode: 0o40755 }), [file]: stats({ file: true }) }),
        });
        expect(looseDirectory.ok).toBe(false);

        const linked = await checkMachineDigestFile({
            ...base,
            ...fs({ [dir]: stats(), [file]: stats({ file: true, link: true }) }),
        });
        expect(linked.ok).toBe(false);

        const hardLink = await checkMachineDigestFile({
            ...base,
            ...fs({ [dir]: stats(), [file]: stats({ file: true, nlink: 2 }) }),
        });
        expect(hardLink.ok).toBe(false);

        const foreignOwner = await checkMachineDigestFile({
            ...base,
            ...fs({ [dir]: stats({ uid: 2000 }), [file]: stats({ file: true }) }),
        });
        expect(foreignOwner.ok).toBe(false);
    });
});

describe("parseMachineTimestamp", () => {
    const stamp = "2026-11-25T10:00:00.000Z";

    test("accepts the boundary and rejects a stale or malformed instant", () => {
        expect(parseMachineTimestamp(stamp, NOW, MACHINE_WINDOW_MS).ok).toBe(true);
        expect(parseMachineTimestamp(stamp, NOW + MACHINE_WINDOW_MS, MACHINE_WINDOW_MS).ok).toBe(true);
        expect(parseMachineTimestamp(stamp, NOW + MACHINE_WINDOW_MS + 1, MACHINE_WINDOW_MS).ok).toBe(false);
        expect(parseMachineTimestamp(stamp, NOW - MACHINE_WINDOW_MS - 1, MACHINE_WINDOW_MS).ok).toBe(false);
        expect(parseMachineTimestamp("yesterday", NOW, MACHINE_WINDOW_MS).ok).toBe(false);
        expect(parseMachineTimestamp(42, NOW, MACHINE_WINDOW_MS).ok).toBe(false);
    });
});

describe("machine nonces", () => {
    const nonce = "n".repeat(20);
    const stamp = "2026-11-25T10:00:00.000Z";

    test("parses only a bounded, well-formed list", () => {
        expect(parseMachineNonceList([{ nonce, at: stamp }])).toEqual([{ nonce, at: stamp }]);
        expect(parseMachineNonceList([{ nonce: "short", at: stamp }])).toBeNull();
        expect(parseMachineNonceList([{ nonce, at: "yesterday" }])).toBeNull();
        expect(parseMachineNonceList([{ nonce }])).toBeNull();
        expect(parseMachineNonceList("nope")).toBeNull();
        expect(parseMachineNonceList(Array.from({ length: MACHINE_MAX_NONCES + 1 }, () => ({ nonce, at: stamp })))).toBeNull();
    });

    test("consumes, detects and prunes a nonce", () => {
        const consumed = acceptMachineNonce([], nonce, stamp, NOW);
        expect(machineNonceSeen(consumed, nonce)).toBe(true);
        expect(machineNonceSeen(consumed, "m".repeat(20))).toBe(false);
        expect(pruneMachineNonces(consumed, NOW + MACHINE_WINDOW_MS)).toHaveLength(1);
        expect(pruneMachineNonces(consumed, NOW + MACHINE_WINDOW_MS + 1)).toEqual([]);
        expect(pruneMachineNonces(consumed, NOW - MACHINE_WINDOW_MS - 1)).toEqual([]);
    });

    test("keeps only the newest bounded set", () => {
        let entries: { nonce: string; at: string }[] = [];
        for (let index = 0; index < MACHINE_MAX_NONCES + 3; index += 1) {
            entries = acceptMachineNonce(entries, `n${String(index).padStart(19, "0")}`, stamp, NOW);
        }
        expect(entries).toHaveLength(MACHINE_MAX_NONCES);
        expect(entries[0]!.nonce).toBe(`n${String(3).padStart(19, "0")}`);
    });
});

describe("MachineAuthLimiter", () => {
    test("locks one key after the failure budget and clears on success", () => {
        let now = 1_000_000;
        const limiter = new MachineAuthLimiter(() => now);
        for (let index = 0; index < MACHINE_MAX_FAILURES - 1; index += 1) limiter.refuse("demo");
        expect(limiter.limited("demo")).toBe(false);
        limiter.refuse("demo");
        expect(limiter.limited("demo")).toBe(true);
        expect(limiter.limited("other")).toBe(false);

        limiter.clear("demo");
        expect(limiter.limited("demo")).toBe(false);

        limiter.refuse("demo");
        expect(limiter.limited("demo")).toBe(false);
        now += 60_001;
        expect(limiter.limited("demo")).toBe(false);
        limiter.refuse("demo");
        expect(limiter.limited("demo")).toBe(false);
    });
});

describe("writeMachineJsonFile", () => {
    test("writes one newline-terminated JSON document atomically", async () => {
        const root = await mkdtemp(join(tmpdir(), "compose-panel-machine-"));
        try {
            const path = join(root, "state.json");
            await writeMachineJsonFile(path, { version: 1, nonces: [] });
            expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: 1, nonces: [] });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
