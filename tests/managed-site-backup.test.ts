import { describe, expect, test } from "bun:test";
import type { Stats } from "node:fs";
import { link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ManagedSiteManifest } from "../src/managed-site.ts";
import {
    checkManagedSiteBackupCredentials,
    MANAGED_SITE_BACKUP_CREDENTIAL_MAX_BYTES,
    MANAGED_SITE_BACKUP_RESTIC_PASSWORD_FILE,
    MANAGED_SITE_BACKUP_REST_ENV_FILE,
    MANAGED_SITE_BACKUP_DATABASE_CREDENTIALS_FILE,
    managedSiteBackupAttemptPath,
    managedSiteBackupDir,
    managedSiteBackupStagingDir,
    parseManagedSiteBackupAttempt,
    readManagedSiteBackupAttempt,
    removeManagedSiteBackupAttempt,
    removeManagedSiteBackupStaging,
    stageManagedSiteBackup,
    writeManagedSiteBackupAttempt,
    type ManagedSiteBackupAttempt,
} from "../src/managed-site-backup.ts";
import { dirIdentity } from "../src/fs-safe.ts";

const stackDir = "/opt/stacks/acme-shop";

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

interface StatOptions {
    mode?: number;
    uid?: number;
    size?: number;
    nlink?: number;
    file?: boolean;
    directory?: boolean;
    link?: boolean;
}

function stats(options: StatOptions = {}): Stats {
    return {
        isFile: () => options.file ?? true,
        isDirectory: () => options.directory ?? false,
        isSymbolicLink: () => options.link ?? false,
        mode: options.mode ?? 0o100600,
        uid: options.uid ?? 1000,
        size: options.size ?? 32,
        nlink: options.nlink ?? 1,
    } as unknown as Stats;
}

const directoryStat = stats({ file: false, directory: true, mode: 0o40700 });

function fakeFs(entries: Record<string, Stats>) {
    return {
        ownerUid: 1000,
        lstat: async (path: string) => {
            const entry = entries[path];
            if (!entry) throw Object.assign(new Error("missing"), { code: "ENOENT" });
            return entry;
        },
    };
}

const dir = managedSiteBackupDir(stackDir);
const path = (file: string) => `${dir}/${file}`;

describe("checkManagedSiteBackupCredentials", () => {
    test("does nothing when no backup is declared", async () => {
        const checked = await checkManagedSiteBackupCredentials(stackDir, manifest({ backup: undefined }), fakeFs({}));
        expect(checked).toEqual({ ok: true });
    });

    test("accepts a 0700 directory with a 0600 password and optional REST env", async () => {
        const checked = await checkManagedSiteBackupCredentials(
            stackDir,
            manifest(),
            fakeFs({ [dir]: directoryStat, [path(MANAGED_SITE_BACKUP_RESTIC_PASSWORD_FILE)]: stats() }),
        );
        expect(checked).toEqual({ ok: true });
    });

    test("refuses a missing, symlinked or loose credential directory", async () => {
        expect((await checkManagedSiteBackupCredentials(stackDir, manifest(), fakeFs({}))).ok).toBe(false);
        expect(
            (await checkManagedSiteBackupCredentials(stackDir, manifest(), fakeFs({ [dir]: stats({ file: false, link: true }) }))).ok,
        ).toBe(false);
        expect(
            (
                await checkManagedSiteBackupCredentials(
                    stackDir,
                    manifest(),
                    fakeFs({ [dir]: stats({ file: false, directory: true, mode: 0o40755 }) }),
                )
            ).ok,
        ).toBe(false);
        expect(
            (
                await checkManagedSiteBackupCredentials(
                    stackDir,
                    manifest(),
                    fakeFs({ [dir]: stats({ file: false, directory: true, uid: 1001 }) }),
                )
            ).ok,
        ).toBe(false);
    });

    test("refuses a missing, loose, hard-linked or oversized password file", async () => {
        const base = { [dir]: directoryStat };
        expect((await checkManagedSiteBackupCredentials(stackDir, manifest(), fakeFs(base))).ok).toBe(false);
        expect(
            (
                await checkManagedSiteBackupCredentials(
                    stackDir,
                    manifest(),
                    fakeFs({ ...base, [path(MANAGED_SITE_BACKUP_RESTIC_PASSWORD_FILE)]: stats({ mode: 0o100644 }) }),
                )
            ).ok,
        ).toBe(false);
        expect(
            (
                await checkManagedSiteBackupCredentials(
                    stackDir,
                    manifest(),
                    fakeFs({ ...base, [path(MANAGED_SITE_BACKUP_RESTIC_PASSWORD_FILE)]: stats({ nlink: 2 }) }),
                )
            ).ok,
        ).toBe(false);
        expect(
            (
                await checkManagedSiteBackupCredentials(
                    stackDir,
                    manifest(),
                    fakeFs({
                        ...base,
                        [path(MANAGED_SITE_BACKUP_RESTIC_PASSWORD_FILE)]: stats({ size: MANAGED_SITE_BACKUP_CREDENTIAL_MAX_BYTES + 1 }),
                    }),
                )
            ).ok,
        ).toBe(false);
        expect(
            (
                await checkManagedSiteBackupCredentials(
                    stackDir,
                    manifest(),
                    fakeFs({ ...base, [path(MANAGED_SITE_BACKUP_RESTIC_PASSWORD_FILE)]: stats({ size: 0 }) }),
                )
            ).ok,
        ).toBe(false);
    });

    test("requires the backup database credentials file only when SQL is declared", async () => {
        const withSql = manifest({
            database: { kind: "existing", engine: "mariadb", network: "acme-db" },
            generation: "2",
            backup: {
                kind: "restic",
                repository: "rest:https://backup.example.test/acme-shop",
                sql: { engine: "mariadb", database: "acme_shop" },
            },
        });
        const base = { [dir]: directoryStat, [path(MANAGED_SITE_BACKUP_RESTIC_PASSWORD_FILE)]: stats() };
        expect(
            (
                await checkManagedSiteBackupCredentials(
                    stackDir,
                    withSql,
                    fakeFs({ ...base, [path(MANAGED_SITE_BACKUP_DATABASE_CREDENTIALS_FILE)]: stats() }),
                )
            ).ok,
        ).toBe(true);
        expect((await checkManagedSiteBackupCredentials(stackDir, withSql, fakeFs(base))).ok).toBe(false);
        expect(
            (await checkManagedSiteBackupCredentials(stackDir, manifest({ database: withSql.database, generation: "2" }), fakeFs(base))).ok,
        ).toBe(true);
    });

    test("checks the optional REST env file when it exists", async () => {
        const base = { [dir]: directoryStat, [path(MANAGED_SITE_BACKUP_RESTIC_PASSWORD_FILE)]: stats() };
        expect(
            (
                await checkManagedSiteBackupCredentials(
                    stackDir,
                    manifest(),
                    fakeFs({ ...base, [path(MANAGED_SITE_BACKUP_REST_ENV_FILE)]: stats({ mode: 0o100644 }) }),
                )
            ).ok,
        ).toBe(false);
        expect(
            (
                await checkManagedSiteBackupCredentials(
                    stackDir,
                    manifest(),
                    fakeFs({ ...base, [path(MANAGED_SITE_BACKUP_REST_ENV_FILE)]: stats() }),
                )
            ).ok,
        ).toBe(true);
    });

    test("skips the ownership check where the platform has no process uid", async () => {
        const checked = await checkManagedSiteBackupCredentials(stackDir, manifest(), {
            ...fakeFs({
                [dir]: stats({ file: false, directory: true, mode: 0o40700, uid: 9999 }),
                [path("restic-password")]: stats({ uid: 9999 }),
            }),
            ownerUid: null,
        });
        expect(checked).toEqual({ ok: true });
    });
});

async function siteRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "compose-panel-backup-"));
    await mkdir(join(root, "site", "shared", "uploads"), { recursive: true });
    await mkdir(join(root, "site", "private", "backup"), { recursive: true, mode: 0o700 });
    return root;
}

describe("stageManagedSiteBackup", () => {
    test("copies declared roots with an inventory and preserves file modes", async () => {
        const root = await siteRoot();
        try {
            await mkdir(join(root, "site", "shared", "uploads", "nested"), { recursive: true });
            await writeFile(join(root, "site", "shared", "uploads", "a.txt"), "alpha");
            await writeFile(join(root, "site", "shared", "uploads", "nested", "b.bin"), Buffer.from([1, 2, 3]));
            const staged = await stageManagedSiteBackup(root, manifest(), "attempt0001");
            expect(staged.ok).toBe(true);
            if (!staged.ok) return;
            expect(staged.bytes).toBe(8);
            expect(staged.entries).toBe(3);
            expect(staged.inventory.map((entry) => entry.path)).toEqual([
                "files/shared/uploads/a.txt",
                "files/shared/uploads/nested/b.bin",
            ]);
            expect(await readFile(join(staged.stagingDir, "files", "shared", "uploads", "a.txt"), "utf8")).toBe("alpha");
            expect(staged.inventory[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
            expect(managedSiteBackupStagingDir(root, "attempt0001")).toBe(staged.stagingDir);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("refuses a missing declared root", async () => {
        const root = await siteRoot();
        try {
            const staged = await stageManagedSiteBackup(root, manifest({ paths: ["shared/missing"] }), "attempt0002");
            expect(staged.ok).toBe(false);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("refuses overlapping roots, no roots and no backup block", async () => {
        const root = await siteRoot();
        try {
            await mkdir(join(root, "site", "shared", "uploads", "nested"), { recursive: true });
            const overlapping = await stageManagedSiteBackup(
                root,
                manifest({ paths: ["shared/uploads", "shared/uploads/nested"] }),
                "attempt0003",
            );
            expect(overlapping.ok).toBe(false);
            if (!overlapping.ok) expect(overlapping.reason).toContain("overlap");
            expect((await stageManagedSiteBackup(root, manifest({ paths: [] }), "attempt0004")).ok).toBe(false);
            expect((await stageManagedSiteBackup(root, manifest({ backup: undefined }), "attempt0005")).ok).toBe(false);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("enforces the byte and entry limits", async () => {
        const root = await siteRoot();
        try {
            await writeFile(join(root, "site", "shared", "uploads", "a.txt"), "0123456789");
            const bytes = await stageManagedSiteBackup(root, manifest(), "attempt0006", { maxBytes: 5 });
            expect(bytes.ok).toBe(false);
            const entries = await stageManagedSiteBackup(root, manifest(), "attempt0007", { maxEntries: 0 });
            expect(entries.ok).toBe(false);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("refuses a symbolic link inside a declared root", async () => {
        const root = await siteRoot();
        try {
            await writeFile(join(root, "site", "shared", "uploads", "real.txt"), "x");
            try {
                await symlink(join(root, "site", "shared", "uploads", "real.txt"), join(root, "site", "shared", "uploads", "link.txt"));
            } catch {
                return; // Windows without symlink privilege: covered on Linux CI.
            }
            const staged = await stageManagedSiteBackup(root, manifest(), "attempt0008");
            expect(staged.ok).toBe(false);
            if (!staged.ok) expect(staged.reason).toContain("symbolic link");
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("refuses a hard link inside a declared root", async () => {
        const root = await siteRoot();
        try {
            const first = join(root, "site", "shared", "uploads", "a.txt");
            await writeFile(first, "x");
            await link(first, join(root, "site", "shared", "uploads", "b.txt"));
            const staged = await stageManagedSiteBackup(root, manifest(), "attempt0009");
            expect(staged.ok).toBe(false);
            if (!staged.ok) expect(staged.reason).toContain("hard link");
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});

describe("backup attempt marker", () => {
    const attempt: ManagedSiteBackupAttempt = {
        version: 1,
        siteId: "acme-shop",
        attemptId: "attempt0010",
        repository: "rest:https://backup.example.test/acme-shop",
        startedAt: "2026-11-25T10:00:00.000Z",
        phase: "stage",
        outcome: "pending",
    };

    test("round-trips through the fixed private path", async () => {
        const root = await siteRoot();
        try {
            expect(await readManagedSiteBackupAttempt(root)).toEqual({ kind: "none" });
            await writeManagedSiteBackupAttempt(root, attempt);
            expect(managedSiteBackupAttemptPath(root)).toBe(`${root}/site/private/backup/backup-attempt.json`);
            const read = await readManagedSiteBackupAttempt(root);
            expect(read.kind).toBe("pending");
            if (read.kind !== "pending") return;
            expect(read.attempt).toEqual(attempt);
            if (process.platform === "linux") expect((await lstat(managedSiteBackupAttemptPath(root))).mode & 0o777).toBe(0o600);
            await removeManagedSiteBackupAttempt(root);
            expect(await readManagedSiteBackupAttempt(root)).toEqual({ kind: "none" });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("treats a malformed or unexpected marker as unreadable, never as absent", async () => {
        const root = await siteRoot();
        try {
            await writeFile(managedSiteBackupAttemptPath(root), "{not json");
            expect(await readManagedSiteBackupAttempt(root)).toEqual({ kind: "unreadable" });
            await writeFile(managedSiteBackupAttemptPath(root), JSON.stringify({ ...attempt, extra: true }));
            expect(await readManagedSiteBackupAttempt(root)).toEqual({ kind: "unreadable" });
            expect(parseManagedSiteBackupAttempt(JSON.stringify({ ...attempt, snapshotId: "z".repeat(64) }))).toBeNull();
            expect(parseManagedSiteBackupAttempt(JSON.stringify({ ...attempt, phase: "unknown" }))).toBeNull();
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("removes staging only when its identity is the recorded one", async () => {
        const root = await siteRoot();
        try {
            const staging = managedSiteBackupStagingDir(root, "attempt0011");
            await mkdir(join(staging, "files"), { recursive: true });
            const identity = await dirIdentity(staging);
            await rm(staging, { recursive: true, force: true });
            await mkdir(staging, { recursive: true });
            expect(await removeManagedSiteBackupStaging(root, "attempt0011", identity)).toBe(false);
            expect(await removeManagedSiteBackupStaging(root, "attempt0011")).toBe(true);
            expect(await removeManagedSiteBackupStaging(root, "attempt0011")).toBe(true);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
