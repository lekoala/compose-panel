import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult, DockerRunner } from "../src/docker.ts";
import type { ManagedSiteManifest } from "../src/managed-site.ts";
import {
    MANAGED_SITE_BACKUP_RESTIC_PASSWORD_FILE,
    managedSiteBackupAttemptPath,
    managedSiteBackupStagingDir,
    readManagedSiteBackupAttempt,
    writeManagedSiteBackupAttempt,
} from "../src/managed-site-backup.ts";
import {
    parseResticBackupSnapshot,
    parseResticListContains,
    parseResticSnapshotList,
    runManagedSiteBackup,
} from "../src/managed-site-backup-run.ts";

const SNAPSHOT = "a".repeat(64);

function ok(stdout = ""): CommandResult {
    return { code: 0, stdout, stderr: "", timedOut: false, truncated: false };
}

function failure(code = 1, stderr = "boom"): CommandResult {
    return { code, stdout: "", stderr, timedOut: false, truncated: false };
}

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
        backup: { kind: "restic", repository: "rest:https://backup.example.test/acme-shop" },
        ...overrides,
    };
}

async function siteRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "compose-panel-backup-run-"));
    await mkdir(join(root, "site", "shared", "uploads"), { recursive: true });
    await mkdir(join(root, "site", "private", "backup"), { recursive: true, mode: 0o700 });
    await writeFile(join(root, "site", "shared", "uploads", "a.txt"), "alpha");
    await writeFile(join(root, "site", "private", "backup", MANAGED_SITE_BACKUP_RESTIC_PASSWORD_FILE), "secret\n");
    return root;
}

interface Plan {
    dump?: CommandResult;
    upload?: CommandResult;
    snapshots?: CommandResult;
    ls?: CommandResult;
    onDump?: (args: string[]) => Promise<void>;
    onUpload?: (args: string[]) => Promise<void>;
}

function fakeDocker(plan: Plan = {}): { docker: DockerRunner; calls: string[][] } {
    const calls: string[][] = [];
    const docker: DockerRunner = async (args) => {
        calls.push(args);
        if (args[0] === "rm") return ok();
        if (args.includes("mariadb-dump")) {
            await plan.onDump?.(args);
            return plan.dump ?? ok();
        }
        if (args.includes("backup")) {
            await plan.onUpload?.(args);
            return plan.upload ?? ok(`${JSON.stringify({ message_type: "summary", snapshot_id: SNAPSHOT })}\n`);
        }
        if (args.includes("snapshots")) {
            return plan.snapshots ?? ok(JSON.stringify([{ id: SNAPSHOT, tags: ["site:acme-shop"] }]));
        }
        if (args.includes("ls")) {
            return plan.ls ?? ok(`${JSON.stringify({ struct_type: "node", path: "/backup/backup.json" })}\n`);
        }
        return ok();
    };
    return { docker, calls };
}

const now = () => new Date("2026-11-25T10:00:00.000Z");
const checkCredentials = async () => ({ ok: true as const });

function mountSource(args: string[], suffix: string): string {
    for (let index = 0; index < args.length; index += 1) {
        const value = args[index]!;
        if (value.endsWith(suffix)) return value.slice(0, -suffix.length);
    }
    throw new Error(`no mount ending in ${suffix}`);
}

describe("runManagedSiteBackup", () => {
    test("uploads the declared files, verifies the snapshot and clears the marker", async () => {
        const root = await siteRoot();
        try {
            const captured: { value: Record<string, unknown> | null } = { value: null };
            const { docker, calls } = fakeDocker({
                onUpload: async (args) => {
                    const staging = mountSource(args, ":/backup:ro");
                    captured.value = JSON.parse(await readFile(`${staging}/backup.json`, "utf8")) as Record<string, unknown>;
                },
            });
            const result = await runManagedSiteBackup(
                {
                    stackDir: root,
                    manifest: manifest(),
                    attemptId: "attempt0001",
                    releaseId: "b".repeat(40),
                    runtimeImage: { reference: "php:8.3-fpm-alpine", id: "sha256:" + "c".repeat(64) },
                },
                { docker, now, checkCredentials },
            );
            if (!result.ok) throw new Error(result.reason);
            expect(result.ok).toBe(true);
            expect(result.snapshotId).toBe(SNAPSHOT);
            expect(result.stagingRemoved).toBe(true);
            expect(captured.value?.mode).toBe("files");
            expect(captured.value?.siteId).toBe("acme-shop");
            expect(captured.value?.release).toBe("b".repeat(40));
            expect(await readManagedSiteBackupAttempt(root)).toEqual({ kind: "none" });
            expect(await Bun.file(managedSiteBackupStagingDir(root, "attempt0001")).exists()).toBe(false);
            const upload = calls.find((args) => args.includes("backup"))!;
            expect(upload).toContain("--read-only");
            expect(upload).toContain(`RESTIC_REPOSITORY=${manifest().backup!.repository}`);
            expect(upload).toContain(`site:acme-shop`);
            expect(upload.join(" ")).not.toContain("sh -c");
            expect(await readManagedSiteBackupAttempt(root)).toEqual({ kind: "none" });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("dumps one named MariaDB database with fixed arguments before uploading", async () => {
        const root = await siteRoot();
        try {
            const withSql = manifest({
                database: { kind: "existing", engine: "mariadb", network: "acme-db" },
                generation: "2",
                backup: {
                    kind: "restic",
                    repository: "rest:https://backup.example.test/acme-shop",
                    sql: { engine: "mariadb", database: "acme_shop" },
                },
            });
            let sqlBytes = 0;
            const { docker, calls } = fakeDocker({
                onDump: async (args) => {
                    sqlBytes = Buffer.byteLength("CREATE TABLE t (id INT);\n");
                    await writeFile(`${mountSource(args, ":/backup:rw")}/database.sql`, "CREATE TABLE t (id INT);\n");
                },
            });
            const result = await runManagedSiteBackup(
                { stackDir: root, manifest: withSql, attemptId: "attempt0002", releaseId: null, runtimeImage: null },
                { docker, now, checkCredentials },
            );
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.sqlBytes).toBe(sqlBytes);
            const dump = calls.find((args) => args.includes("mariadb-dump"))!;
            expect(dump).toContain("--network");
            expect(dump).toContain("acme-db");
            expect(dump).toContain("--env-file");
            expect(dump).toContain("--databases");
            expect(dump[dump.indexOf("--databases") + 1]).toBe("acme_shop");
            expect(dump).toContain("--single-transaction");
            expect(dump).not.toContain("--all-databases");
            expect(dump.join(" ")).not.toContain("sh -c");
            expect(calls.findIndex((args) => args.includes("mariadb-dump"))).toBeLessThan(
                calls.findIndex((args) => args.includes("backup")),
            );
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("a failed dump never starts an upload and leaves no pending marker", async () => {
        const root = await siteRoot();
        try {
            const withSql = manifest({
                database: { kind: "existing", engine: "mariadb", network: "acme-db" },
                generation: "2",
                backup: {
                    kind: "restic",
                    repository: "rest:https://backup.example.test/acme-shop",
                    sql: { engine: "mariadb", database: "acme_shop" },
                },
            });
            const { docker, calls } = fakeDocker({ dump: failure(2, "access denied") });
            const result = await runManagedSiteBackup(
                { stackDir: root, manifest: withSql, attemptId: "attempt0003", releaseId: null, runtimeImage: null },
                { docker, now, checkCredentials },
            );
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.reason).toContain("access denied");
            expect(calls.some((args) => args.includes("backup"))).toBe(false);
            expect(calls.some((args) => args[0] === "rm")).toBe(true);
            expect(await readManagedSiteBackupAttempt(root)).toEqual({ kind: "none" });
            expect(await Bun.file(managedSiteBackupStagingDir(root, "attempt0003")).exists()).toBe(false);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("a failed upload is proven, clears its marker and removes staging", async () => {
        const root = await siteRoot();
        try {
            const { docker } = fakeDocker({ upload: failure(1, "repository is locked") });
            const result = await runManagedSiteBackup(
                { stackDir: root, manifest: manifest(), attemptId: "attempt0004", releaseId: null, runtimeImage: null },
                { docker, now, checkCredentials },
            );
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.outcome).toBe("failed");
            expect(await readManagedSiteBackupAttempt(root)).toEqual({ kind: "none" });
            expect(await Bun.file(managedSiteBackupStagingDir(root, "attempt0004")).exists()).toBe(false);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("an upload timeout keeps an unknown marker for acknowledgement", async () => {
        const root = await siteRoot();
        try {
            const timeout: CommandResult = { code: -1, stdout: "", stderr: "", timedOut: true, truncated: false };
            const { docker } = fakeDocker({ upload: timeout });
            const result = await runManagedSiteBackup(
                { stackDir: root, manifest: manifest(), attemptId: "attempt0005", releaseId: null, runtimeImage: null },
                { docker, now, checkCredentials },
            );
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.outcome).toBe("unknown");
            const marker = await readManagedSiteBackupAttempt(root);
            expect(marker.kind).toBe("pending");
            if (marker.kind !== "pending") return;
            expect(marker.attempt.outcome).toBe("failed");
            expect(await Bun.file(managedSiteBackupStagingDir(root, "attempt0005")).exists()).toBe(false);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("refuses to run while a previous attempt marker exists", async () => {
        const root = await siteRoot();
        try {
            await writeManagedSiteBackupAttempt(root, {
                version: 1,
                siteId: "acme-shop",
                attemptId: "attempt0006",
                repository: "rest:https://backup.example.test/acme-shop",
                startedAt: "2026-11-25T09:00:00.000Z",
                phase: "upload",
                outcome: "pending",
            });
            const { docker, calls } = fakeDocker();
            const result = await runManagedSiteBackup(
                { stackDir: root, manifest: manifest(), attemptId: "attempt0007", releaseId: null, runtimeImage: null },
                { docker, now, checkCredentials },
            );
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.reason).toContain("unconfirmed outcome");
            expect(calls).toEqual([]);
            expect(await Bun.file(managedSiteBackupStagingDir(root, "attempt0007")).exists()).toBe(false);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("never runs a container when the credentials are refused", async () => {
        const root = await siteRoot();
        try {
            const { docker, calls } = fakeDocker();
            const result = await runManagedSiteBackup(
                { stackDir: root, manifest: manifest(), attemptId: "attempt0008", releaseId: null, runtimeImage: null },
                { docker, now, checkCredentials: async () => ({ ok: false as const, reason: "password missing" }) },
            );
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.reason).toContain("password missing");
            expect(calls).toEqual([]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("refuses a snapshot the repository does not return or that lacks its manifest", async () => {
        const root = await siteRoot();
        try {
            const wrong = fakeDocker({ snapshots: ok(JSON.stringify([{ id: "d".repeat(64), tags: ["site:acme-shop"] }])) });
            const first = await runManagedSiteBackup(
                { stackDir: root, manifest: manifest(), attemptId: "attempt0009", releaseId: null, runtimeImage: null },
                { docker: wrong.docker, now, checkCredentials },
            );
            expect(first.ok).toBe(false);
            if (first.ok) return;
            expect(first.outcome).toBe("unknown");

            const root2 = await siteRoot();
            try {
                const noManifest = fakeDocker({ ls: ok("") });
                const second = await runManagedSiteBackup(
                    { stackDir: root2, manifest: manifest(), attemptId: "attempt0010", releaseId: null, runtimeImage: null },
                    { docker: noManifest.docker, now, checkCredentials },
                );
                expect(second.ok).toBe(false);
                if (second.ok) return;
                expect(second.reason).toContain("manifest");
            } finally {
                await rm(root2, { recursive: true, force: true });
            }
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("removes its staging tree when the walk refuses a declared root", async () => {
        const root = await siteRoot();
        try {
            const { docker } = fakeDocker();
            const result = await runManagedSiteBackup(
                {
                    stackDir: root,
                    manifest: manifest({ paths: ["shared/missing"] }),
                    attemptId: "attempt0012",
                    releaseId: null,
                    runtimeImage: null,
                },
                { docker, now, checkCredentials },
            );
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.reason).toContain("missing");
            expect(await Bun.file(managedSiteBackupStagingDir(root, "attempt0012")).exists()).toBe(false);
            expect(await readManagedSiteBackupAttempt(root)).toEqual({ kind: "none" });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("refuses a backup declaration without persistent roots", async () => {
        const root = await siteRoot();
        try {
            const { docker, calls } = fakeDocker();
            const result = await runManagedSiteBackup(
                { stackDir: root, manifest: manifest({ paths: [] }), attemptId: "attempt0011", releaseId: null, runtimeImage: null },
                { docker, now, checkCredentials },
            );
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.reason).toContain("persistent roots");
            expect(calls).toEqual([]);
            expect(await Bun.file(managedSiteBackupAttemptPath(root)).exists()).toBe(false);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});

describe("restic output parsing", () => {
    test("accepts only a complete summary with a full snapshot id", () => {
        expect(
            parseResticBackupSnapshot(
                `${JSON.stringify({ message_type: "status" })}\n${JSON.stringify({ message_type: "summary", snapshot_id: SNAPSHOT })}\n`,
            ),
        ).toBe(SNAPSHOT);
        expect(parseResticBackupSnapshot(`${JSON.stringify({ message_type: "summary", snapshot_id: "short" })}\n`)).toBeNull();
        expect(parseResticBackupSnapshot("not json\n")).toBeNull();
        expect(parseResticBackupSnapshot(`${JSON.stringify({ message_type: "summary", snapshot_id: SNAPSHOT })}`)).toBe(SNAPSHOT);
    });

    test("requires exactly the uploaded snapshot and the site tag", () => {
        const list = (value: unknown) => ok(JSON.stringify(value));
        expect(parseResticSnapshotList(list([{ id: SNAPSHOT, tags: ["site:acme-shop"] }]).stdout, SNAPSHOT, "acme-shop")).toBe(true);
        expect(parseResticSnapshotList(list([{ id: SNAPSHOT, tags: ["site:other"] }]).stdout, SNAPSHOT, "acme-shop")).toBe(false);
        expect(parseResticSnapshotList(list([{ id: SNAPSHOT }]).stdout, SNAPSHOT, "acme-shop")).toBe(false);
        expect(
            parseResticSnapshotList(
                list([
                    { id: SNAPSHOT, tags: ["site:acme-shop"] },
                    { id: SNAPSHOT, tags: ["site:acme-shop"] },
                ]).stdout,
                SNAPSHOT,
                "acme-shop",
            ),
        ).toBe(false);
        expect(parseResticSnapshotList("[]", SNAPSHOT, "acme-shop")).toBe(false);
    });

    test("finds only the exact manifest path in restic ls output", () => {
        expect(parseResticListContains(`${JSON.stringify({ path: "/backup/backup.json" })}\n`, "/backup/backup.json")).toBe(true);
        expect(parseResticListContains(`${JSON.stringify({ path: "/backup/files/x" })}\n`, "/backup/backup.json")).toBe(false);
        expect(parseResticListContains("garbage\n", "/backup/backup.json")).toBe(false);
    });
});
