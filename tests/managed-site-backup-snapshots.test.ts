import { describe, expect, test } from "bun:test";
import { runManagedSiteBackupSnapshotList, managedSiteBackupSnapshotsNewestFirst } from "../src/managed-site-backup-snapshots.ts";
import type { CommandResult, DockerRunner } from "../src/docker.ts";
import { MANAGED_SITE_RESTIC_IMAGE } from "../src/managed-site-restic.ts";
import type { ManagedSiteManifest } from "../src/managed-site.ts";

const SITE = "acme-shop";
const STACK = "/opt/stacks/acme-shop";
const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const T1 = "2026-11-21T10:00:00Z";
const T2 = "2026-11-22T10:00:00Z";
const T3 = "2026-11-23T10:00:00Z";

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
    backup: { kind: "restic", repository: "rest:https://backup.example.test/acme-shop" },
};

function snapshot(id: string, time: string, tags: string[] = [`site:${SITE}`]): Record<string, unknown> {
    return { id, short_id: id.slice(0, 8), time, tags, paths: ["/backup"], host: "panel" };
}

const commandOk = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "", timedOut: false, truncated: false });

function fakeDocker(calls: string[][], result: CommandResult = commandOk()): DockerRunner {
    return async (args) => {
        calls.push(args);
        return result;
    };
}

describe("snapshot list command", () => {
    test("reads only this site's snapshot inventory and never mutates the repository", async () => {
        const calls: string[][] = [];
        const result = await runManagedSiteBackupSnapshotList(
            { stackDir: STACK, manifest },
            { docker: fakeDocker(calls, commandOk(JSON.stringify([snapshot(A, T1)]))) },
        );
        expect(result.ok).toBe(true);
        expect(calls).toHaveLength(1);
        const args = calls[0]!;
        expect(args).toContain(MANAGED_SITE_RESTIC_IMAGE);
        expect(args).toContain("snapshots");
        expect(args).toContain("--json");
        expect(args).toContain("--no-lock");
        expect(args).toContain(`site:${SITE}`);
        // No mutation, no id, no deletion flag, no second command.
        expect(args).not.toContain("forget");
        expect(args).not.toContain("prune");
        expect(args).not.toContain("--prune");
        expect(args).not.toContain("backup");
        expect(args).not.toContain("restore");
        expect(args.some((entry) => /^[0-9a-f]{64}$/.test(entry))).toBe(false);
    });

    test("returns the newest snapshot first", async () => {
        const result = await runManagedSiteBackupSnapshotList(
            { stackDir: STACK, manifest },
            { docker: fakeDocker([], commandOk(JSON.stringify([snapshot(A, T1), snapshot(C, T3), snapshot(B, T2)]))) },
        );
        expect(result).toEqual({
            ok: true,
            snapshots: [
                { id: C, at: T3 },
                { id: B, at: T2 },
                { id: A, at: T1 },
            ],
        });
    });

    test("orders timestamps by instant, not by their textual offset", () => {
        expect(
            managedSiteBackupSnapshotsNewestFirst([
                { id: A, at: "2026-11-22T11:00:00+01:00" },
                { id: B, at: "2026-11-22T10:30:00Z" },
                { id: C, at: "2026-11-21T10:30:00Z" },
            ]).map((entry) => entry.id),
        ).toEqual([B, A, C]);
    });

    test("accepts an empty repository list", async () => {
        const result = await runManagedSiteBackupSnapshotList({ stackDir: STACK, manifest }, { docker: fakeDocker([], commandOk("[]")) });
        expect(result).toEqual({ ok: true, snapshots: [] });
    });

    test("refuses a malformed, foreign, duplicated or oversized reply without a partial list", async () => {
        const cases = [
            "not json",
            JSON.stringify({}),
            JSON.stringify([snapshot(A, T1, ["site:other"])]),
            JSON.stringify([snapshot("short", T1)]),
            JSON.stringify([snapshot(A, "yesterday")]),
            JSON.stringify([snapshot(A, T1), snapshot(A, T2)]),
            JSON.stringify([{ id: A, time: T1, tags: `site:${SITE}` }]),
        ];
        for (const stdout of cases) {
            const result = await runManagedSiteBackupSnapshotList(
                { stackDir: STACK, manifest },
                { docker: fakeDocker([], commandOk(stdout)) },
            );
            expect(result.ok).toBe(false);
        }
    });

    test("refuses more snapshots than the bound", async () => {
        const many = Array.from({ length: 2001 }, (_, index) => snapshot(index.toString(16).padStart(64, "0"), T1));
        const result = await runManagedSiteBackupSnapshotList(
            { stackDir: STACK, manifest },
            { docker: fakeDocker([], commandOk(JSON.stringify(many))) },
        );
        expect(result.ok).toBe(false);
    });

    test("reports a failure, a timeout and truncated output without inventing a list", async () => {
        const failed = await runManagedSiteBackupSnapshotList(
            { stackDir: STACK, manifest },
            {
                docker: fakeDocker([], {
                    code: 1,
                    stdout: "",
                    stderr: "Fatal: unable to open repository\nsecond line",
                    timedOut: false,
                    truncated: false,
                }),
            },
        );
        expect(failed).toEqual({ ok: false, reason: "The snapshot list failed: Fatal: unable to open repository" });

        const timedOut = await runManagedSiteBackupSnapshotList(
            { stackDir: STACK, manifest },
            { docker: fakeDocker([], { code: 0, stdout: "", stderr: "", timedOut: true, truncated: false }) },
        );
        expect(timedOut.ok).toBe(false);
        if (!timedOut.ok) expect(timedOut.reason).toContain("did not finish");

        const truncated = await runManagedSiteBackupSnapshotList(
            { stackDir: STACK, manifest },
            { docker: fakeDocker([], { code: 0, stdout: "", stderr: "", timedOut: false, truncated: true }) },
        );
        expect(truncated.ok).toBe(false);
        if (!truncated.ok) expect(truncated.reason).toContain("more output");
    });

    test("refuses a site without a backup block before running a container", async () => {
        const calls: string[][] = [];
        const result = await runManagedSiteBackupSnapshotList(
            { stackDir: STACK, manifest: { ...manifest, backup: undefined } },
            { docker: fakeDocker(calls, commandOk("[]")) },
        );
        expect(result).toEqual({ ok: false, reason: "This site declares no backup block." });
        expect(calls).toEqual([]);
    });
});
