import { describe, expect, test } from "bun:test";
import type { CommandResult, DockerRunner } from "../src/docker.ts";
import {
    MANAGED_SITE_BACKUP_RETENTION_MAX_SNAPSHOTS,
    MANAGED_SITE_BACKUP_RETENTION_OUTPUT_MAX_BYTES,
    managedSiteBackupInventoryArgs,
    managedSiteBackupRetentionArgs,
    managedSiteBackupRetentionSummary,
    managedSiteRetentionProtection,
    parseManagedSiteBackupInventory,
    parseManagedSiteBackupRetentionPreview,
    runManagedSiteBackupRetentionPreview,
} from "../src/managed-site-backup-retention.ts";
import type { ManagedSiteManifest } from "../src/managed-site.ts";

const SITE = "acme-shop";
const STACK = "/opt/stacks/acme-shop";
const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const T1 = "2026-11-21T10:00:00.123456789Z";
const T2 = "2026-11-22T11:00:00+01:00";

const manifest: ManagedSiteManifest = {
    version: 3,
    siteId: SITE,
    owner: "managed",
    project: SITE,
    services: { gateway: "web", runtime: "runtime" },
    gateway: { port: 41001 },
    publicRoot: "public",
    runtime: { profile: "php-front-controller", image: "php:8.3-fpm-alpine" },
    deploy: { kind: "bind-mount", git: { url: "https://github.com/acme/shop.git", ref: "refs/heads/main" } },
    paths: ["shared/uploads"],
    generation: "1",
    backup: {
        kind: "restic",
        repository: "rest:https://backup.example.test/acme-shop",
        retention: { keepLast: 2, keepDaily: 7 },
    },
};

function snapshot(id: string, time: string, tags: string[] = [`site:${SITE}`]): Record<string, unknown> {
    return { id, short_id: id.slice(0, 8), time, tags, paths: ["/backup"], host: "panel" };
}

function group(keep: unknown[], remove: unknown[]): Record<string, unknown> {
    return { host: "panel", tags: [`site:${SITE}`], paths: ["/backup"], keep, remove, reasons: [] };
}

const commandOk = (stdout = ""): CommandResult => ({
    code: 0,
    stdout,
    stderr: "",
    timedOut: false,
    truncated: false,
});

describe("retention arguments", () => {
    test("always asks Restic for a dry-run and never for a prune", () => {
        const args = managedSiteBackupRetentionArgs({ keepLast: 7, keepDaily: 14, keepWeekly: 8, keepMonthly: 12 }, SITE);
        expect(args.slice(0, 2)).toEqual(["forget", "--dry-run"]);
        expect(args).toContain("--json");
        expect(args).toContain("--no-lock");
        expect(args).toContain(`site:${SITE}`);
        expect(args).toContain("--keep-last");
        expect(args).toContain("7");
        expect(args).toContain("--keep-daily");
        expect(args).toContain("14");
        expect(args).toContain("--keep-weekly");
        expect(args).toContain("--keep-monthly");
        expect(args).not.toContain("--prune");
        expect(args).not.toContain("prune");
        expect(args).not.toContain("--unsafe-allow-remove-all");
        expect(args.some((entry) => /^[0-9a-f]{64}$/.test(entry))).toBe(false);

        expect(managedSiteBackupRetentionArgs({ keepDaily: 3 }, SITE)).not.toContain("--keep-last");
        expect(managedSiteBackupInventoryArgs(SITE)).toEqual(["snapshots", "--json", "--no-lock", "--tag", `site:${SITE}`]);
    });

    test("summarizes the declared counts", () => {
        expect(managedSiteBackupRetentionSummary({ keepLast: 2, keepDaily: 7 })).toBe("keep-last 2, keep-daily 7");
        expect(managedSiteBackupRetentionSummary({ keepMonthly: 12 })).toBe("keep-monthly 12");
    });
});

describe("parseManagedSiteBackupInventory", () => {
    test("accepts only this site's tagged snapshots", () => {
        const parsed = parseManagedSiteBackupInventory(JSON.stringify([snapshot(A, T1), snapshot(B, T2)]), SITE);
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        expect(parsed.snapshots).toEqual([
            { id: A, at: T1 },
            { id: B, at: T2 },
        ]);
        expect(parseManagedSiteBackupInventory("[]", SITE)).toEqual({ ok: true, snapshots: [] });
    });

    test("refuses a foreign tag, a malformed id or time, a duplicate and an oversized list", () => {
        expect(parseManagedSiteBackupInventory(JSON.stringify([snapshot(A, T1, ["site:other"])]), SITE).ok).toBe(false);
        expect(parseManagedSiteBackupInventory(JSON.stringify([snapshot(A, T1, [])]), SITE).ok).toBe(false);
        expect(parseManagedSiteBackupInventory(JSON.stringify([snapshot("short", T1)]), SITE).ok).toBe(false);
        expect(parseManagedSiteBackupInventory(JSON.stringify([snapshot(A, "yesterday")]), SITE).ok).toBe(false);
        expect(parseManagedSiteBackupInventory(JSON.stringify([snapshot(A, T1), snapshot(A, T2)]), SITE).ok).toBe(false);
        expect(parseManagedSiteBackupInventory("not json", SITE).ok).toBe(false);
        expect(parseManagedSiteBackupInventory(JSON.stringify({}), SITE).ok).toBe(false);
        const many = Array.from({ length: MANAGED_SITE_BACKUP_RETENTION_MAX_SNAPSHOTS + 1 }, (_, index) =>
            snapshot(index.toString(16).padStart(64, "0"), T1),
        );
        expect(parseManagedSiteBackupInventory(JSON.stringify(many), SITE).ok).toBe(false);
    });
});

describe("parseManagedSiteBackupRetentionPreview", () => {
    const inventory = [
        { id: A, at: T1 },
        { id: B, at: T2 },
    ];

    test("reads one group and several groups", () => {
        const single = parseManagedSiteBackupRetentionPreview(JSON.stringify(group([snapshot(A, T1)], [snapshot(B, T2)])), inventory, SITE);
        expect(single.ok).toBe(true);
        if (!single.ok) return;
        expect(single.preview.total).toBe(2);
        expect(single.preview.keep.map((entry) => entry.id)).toEqual([A]);
        expect(single.preview.remove.map((entry) => entry.id)).toEqual([B]);

        const split = parseManagedSiteBackupRetentionPreview(
            JSON.stringify([group([snapshot(A, T1)], []), group([], [snapshot(B, T2)])]),
            inventory,
            SITE,
        );
        expect(split.ok).toBe(true);
        if (split.ok) expect(split.preview.remove.map((entry) => entry.id)).toEqual([B]);
    });

    test("refuses a partial, foreign, duplicated or unfamiliar answer", () => {
        // Missing B: a partial preview must never be shown as safe.
        expect(parseManagedSiteBackupRetentionPreview(JSON.stringify(group([snapshot(A, T1)], [])), inventory, SITE).ok).toBe(false);
        // C was not in the inventory.
        expect(
            parseManagedSiteBackupRetentionPreview(JSON.stringify(group([snapshot(A, T1)], [snapshot(C, T2)])), inventory, SITE).ok,
        ).toBe(false);
        // B in both lists.
        expect(
            parseManagedSiteBackupRetentionPreview(
                JSON.stringify(group([snapshot(A, T1), snapshot(B, T2)], [snapshot(B, T2)])),
                inventory,
                SITE,
            ).ok,
        ).toBe(false);
        expect(parseManagedSiteBackupRetentionPreview(JSON.stringify([{ keep: [] }]), inventory, SITE).ok).toBe(false);
        expect(parseManagedSiteBackupRetentionPreview("", inventory, SITE).ok).toBe(false);
        expect(parseManagedSiteBackupRetentionPreview("[]", inventory, SITE).ok).toBe(false);
        expect(parseManagedSiteBackupRetentionPreview("not json", inventory, SITE).ok).toBe(false);
        expect(parseManagedSiteBackupRetentionPreview("", [], SITE)).toEqual({
            ok: true,
            preview: { total: 0, keep: [], remove: [] },
        });
    });
});

describe("managedSiteRetentionProtection", () => {
    test("names the recorded facts the removal set contains", () => {
        const remove = [{ id: A, at: T1 }];
        expect(managedSiteRetentionProtection(remove, { lastSuccess: A, lastProof: B })).toEqual({
            removesLastSuccess: true,
            removesLastProof: false,
        });
        expect(managedSiteRetentionProtection(remove, { lastSuccess: B, lastProof: A })).toEqual({
            removesLastSuccess: false,
            removesLastProof: true,
        });
        expect(managedSiteRetentionProtection(remove, { lastSuccess: null, lastProof: null })).toEqual({
            removesLastSuccess: false,
            removesLastProof: false,
        });
    });
});

describe("runManagedSiteBackupRetentionPreview", () => {
    function docker(calls: string[][], answers: { snapshots: string; forget?: string; forgetCode?: number }): DockerRunner {
        return async (args) => {
            calls.push(args);
            if (args.includes("snapshots")) return commandOk(answers.snapshots);
            if (args.includes("forget")) return commandOk(answers.forget ?? "");
            return commandOk();
        };
    }

    test("runs exactly snapshots and a dry-run forget, then reports the split", async () => {
        const calls: string[][] = [];
        const output: string[] = [];
        const result = await runManagedSiteBackupRetentionPreview(
            { stackDir: STACK, manifest, onOutput: (chunk) => output.push(chunk) },
            {
                docker: docker(calls, {
                    snapshots: JSON.stringify([snapshot(A, T1), snapshot(B, T2)]),
                    forget: JSON.stringify(group([snapshot(A, T1)], [snapshot(B, T2)])),
                }),
            },
        );
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.total).toBe(2);
        expect(result.keep.map((entry) => entry.id)).toEqual([A]);
        expect(result.remove.map((entry) => entry.id)).toEqual([B]);
        expect(calls).toHaveLength(2);
        expect(calls[0]).toContain("snapshots");
        expect(calls[1]).toContain("forget");
        expect(calls[1]).toContain("--dry-run");
        expect(calls[1]).toContain("--keep-last");
        expect(calls.some((args) => args.includes("--prune") || args.includes("prune"))).toBe(false);
        expect(calls.every((args) => args.includes("--no-lock"))).toBe(true);
        expect(output.join("")).toContain(B.slice(0, 12));
        expect(output.join("")).not.toContain("restic-password");
    });

    test("an empty repository stops after the snapshot list", async () => {
        const calls: string[][] = [];
        const result = await runManagedSiteBackupRetentionPreview(
            { stackDir: STACK, manifest },
            { docker: docker(calls, { snapshots: "[]" }) },
        );
        expect(result).toEqual({ ok: true, total: 0, keep: [], remove: [] });
        expect(calls).toHaveLength(1);
    });

    test("fails closed on a failed call or an inconsistent preview", async () => {
        const failed: DockerRunner = async () => ({
            code: 1,
            stdout: "",
            stderr: "Fatal: repository is already locked",
            timedOut: false,
            truncated: false,
        });
        const listFailure = await runManagedSiteBackupRetentionPreview({ stackDir: STACK, manifest }, { docker: failed });
        expect(listFailure.ok).toBe(false);
        if (!listFailure.ok) expect(listFailure.reason).toContain("Nothing was deleted");

        const calls: string[][] = [];
        const previewFailure = await runManagedSiteBackupRetentionPreview(
            { stackDir: STACK, manifest },
            {
                docker: async (args) => {
                    calls.push(args);
                    if (args.includes("snapshots")) return commandOk(JSON.stringify([snapshot(A, T1)]));
                    return { code: 0, stdout: JSON.stringify(group([], [snapshot(B, T2)])), stderr: "", timedOut: false, truncated: false };
                },
            },
        );
        expect(previewFailure.ok).toBe(false);
        expect(calls).toHaveLength(2);

        const inconsistent = await runManagedSiteBackupRetentionPreview(
            { stackDir: STACK, manifest },
            {
                docker: docker(calls, {
                    snapshots: JSON.stringify([snapshot(A, T1), snapshot(B, T2)]),
                    forget: JSON.stringify(group([snapshot(A, T1)], [])),
                }),
            },
        );
        expect(inconsistent.ok).toBe(false);
    });

    test("uses the bounded output budget for both calls", async () => {
        const budgets: (number | undefined)[] = [];
        const runner: DockerRunner = async (args, options) => {
            budgets.push(options?.maxBytes);
            if (args.includes("snapshots")) return commandOk(JSON.stringify([snapshot(A, T1)]));
            return commandOk(JSON.stringify(group([snapshot(A, T1)], [])));
        };
        await runManagedSiteBackupRetentionPreview({ stackDir: STACK, manifest }, { docker: runner });
        expect(budgets).toEqual([MANAGED_SITE_BACKUP_RETENTION_OUTPUT_MAX_BYTES, MANAGED_SITE_BACKUP_RETENTION_OUTPUT_MAX_BYTES]);
    });
});
