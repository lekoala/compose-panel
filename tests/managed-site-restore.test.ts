import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult, DockerRunner } from "../src/docker.ts";
import type { ManagedSiteManifest } from "../src/managed-site.ts";
import {
    MANAGED_SITE_BACKUP_RESTIC_PASSWORD_FILE,
    managedSiteBackupDir,
    managedSiteBackupAttemptPath,
} from "../src/managed-site-backup.ts";
import {
    MANAGED_SITE_RESTORE_DIR,
    managedSiteRestoreDir,
    parseRestoreSnapshotManifest,
    runManagedSiteRestore,
} from "../src/managed-site-restore.ts";

const SNAPSHOT = "a".repeat(64);
const SITE = "acme-shop";
const SQL = "CREATE TABLE t (id INT);\n";

function ok(stdout = ""): CommandResult {
    return { code: 0, stdout, stderr: "", timedOut: false, truncated: false };
}

function manifest(overrides: Partial<ManagedSiteManifest> = {}): ManagedSiteManifest {
    return {
        version: 3,
        siteId: SITE,
        owner: "managed",
        project: SITE,
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

function withSql(): ManagedSiteManifest {
    return manifest({
        database: { kind: "existing", engine: "mariadb", network: "acme-db" },
        generation: "2",
        backup: {
            kind: "restic",
            repository: "rest:https://backup.example.test/acme-shop",
            sql: { engine: "mariadb", database: "acme_shop" },
        },
    });
}

async function siteRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "compose-panel-restore-"));
    await mkdir(managedSiteBackupDir(root), { recursive: true, mode: 0o700 });
    await writeFile(`${managedSiteBackupDir(root)}/${MANAGED_SITE_BACKUP_RESTIC_PASSWORD_FILE}`, "secret\n");
    return root;
}

function sha256(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

function snapshotManifest(
    options: { siteId?: string; mode?: "files" | "files+sql"; size?: number; hash?: string; sqlBytes?: number } = {},
): string {
    const content = "alpha";
    return JSON.stringify({
        version: 1,
        siteId: options.siteId ?? SITE,
        attemptId: "backup0001",
        mode: options.mode ?? "files",
        sql: options.mode === "files+sql" ? { engine: "mariadb", database: "acme_shop", clientImage: "mariadb:11" } : null,
        sqlBytes: options.mode === "files+sql" ? (options.sqlBytes ?? SQL.length) : null,
        inventory: [
            {
                path: "files/shared/uploads/a.txt",
                type: "file",
                size: options.size ?? content.length,
                sha256: options.hash ?? sha256(content),
            },
        ],
    });
}

interface Plan {
    snapshot?: string;
    listOk?: boolean;
    dump?: CommandResult;
    restore?: (target: string) => Promise<void>;
    importResult?: CommandResult;
    tables?: string;
    onCall?: (args: string[]) => void;
}

function fakeDocker(plan: Plan = {}): { docker: DockerRunner; calls: string[][] } {
    const calls: string[][] = [];
    const docker: DockerRunner = async (args) => {
        calls.push(args);
        plan.onCall?.(args);
        if (args[0] === "rm") return ok();
        if (args[0] === "network") return ok();
        if (args.includes("dump")) return plan.dump ?? ok(plan.snapshot ?? snapshotManifest());
        if (args.includes("snapshots")) {
            return plan.listOk === false ? ok("[]") : ok(JSON.stringify([{ id: SNAPSHOT, tags: [`site:${SITE}`] }]));
        }
        if (args.includes("ls")) return ok(`${JSON.stringify({ path: "/backup/backup.json" })}\n`);
        if (args.includes("restore")) {
            const mount = args.find((value) => value.endsWith(":/restore"))!;
            await plan.restore?.(mount.slice(0, -":/restore".length));
            return ok();
        }
        if (args.includes("exec")) return ok("1\n");
        if (args.includes("mariadb")) {
            if (args.includes("SELECT 1")) return ok("1\n");
            if (args.some((value) => value.startsWith("SELECT COUNT"))) return ok(`${plan.tables ?? "1"}\n`);
            return plan.importResult ?? ok();
        }
        return ok();
    };
    return { docker, calls };
}

const checkCredentials = async () => ({ ok: true as const });

async function restoreFiles(target: string, options: { sql?: boolean; content?: string } = {}): Promise<void> {
    const files = `${target}/backup/files/shared/uploads`;
    await mkdir(files, { recursive: true });
    await writeFile(`${files}/a.txt`, options.content ?? "alpha");
    if (options.sql) await writeFile(`${target}/backup/database.sql`, SQL);
}

describe("parseRestoreSnapshotManifest", () => {
    test("accepts a matching inventory and rejects a foreign site or unsafe entry", () => {
        expect(parseRestoreSnapshotManifest(snapshotManifest(), manifest()).ok).toBe(true);
        expect(parseRestoreSnapshotManifest(snapshotManifest({ siteId: "other" }), manifest()).ok).toBe(false);
        expect(parseRestoreSnapshotManifest(snapshotManifest({ hash: "z".repeat(64) }), manifest()).ok).toBe(false);
        const traversal = JSON.stringify({
            version: 1,
            siteId: SITE,
            mode: "files",
            inventory: [{ path: "files/../escape", type: "file", size: 1, sha256: "a".repeat(64) }],
        });
        expect(parseRestoreSnapshotManifest(traversal, manifest()).ok).toBe(false);
        expect(parseRestoreSnapshotManifest("not json", manifest()).ok).toBe(false);
        expect(parseRestoreSnapshotManifest(snapshotManifest({ mode: "files+sql" }), manifest()).ok).toBe(false);
        expect(parseRestoreSnapshotManifest(snapshotManifest({ mode: "files+sql" }), withSql()).ok).toBe(true);
    });
});

describe("runManagedSiteRestore", () => {
    test("extracts and verifies a files-only snapshot without starting a database", async () => {
        const root = await siteRoot();
        try {
            const { docker, calls } = fakeDocker({ restore: (target) => restoreFiles(target) });
            const result = await runManagedSiteRestore(
                { stackDir: root, manifest: manifest(), attemptId: "restore01", snapshotId: SNAPSHOT },
                { docker, checkCredentials },
            );
            expect(result.ok).toBe(true);
            if (!result.ok) throw new Error(result.reason);
            expect(result.files).toBe(1);
            expect(result.bytes).toBe(5);
            expect(result.completed).toEqual(["files"]);
            expect(result.sql).toBeNull();
            expect(await readFile(`${result.restoreDir}/backup/files/shared/uploads/a.txt`, "utf8")).toBe("alpha");
            expect(calls.some((args) => args.includes("mariadb"))).toBe(false);
            expect(calls.some((args) => args[0] === "network")).toBe(false);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("imports SQL into a disposable database with no production network or credentials", async () => {
        const root = await siteRoot();
        try {
            const { docker, calls } = fakeDocker({
                snapshot: snapshotManifest({ mode: "files+sql" }),
                restore: (target) => restoreFiles(target, { sql: true }),
                tables: "2",
            });
            const result = await runManagedSiteRestore(
                { stackDir: root, manifest: withSql(), attemptId: "restore02", snapshotId: SNAPSHOT },
                { docker, checkCredentials, resticNetwork: "host" },
            );
            expect(result.ok).toBe(true);
            if (!result.ok) throw new Error(result.reason);
            expect(result.completed).toEqual(["files", "sql"]);
            expect(result.sql?.tables).toBe(2);
            expect(result.sql?.database).toBe("acme_shop");
            const network = calls.find((args) => args[0] === "network" && args[1] === "create");
            expect(network).toContain("--internal");
            const server = calls.find((args) => args.includes("mariadb") && args.includes("SELECT 1"));
            expect(server).toBeDefined();
            const serverRun = calls.find((args) => args.includes("MARIADB_ALLOW_EMPTY_ROOT_PASSWORD=1"));
            expect(serverRun).toBeDefined();
            expect(serverRun!.join(" ")).not.toContain("--publish");
            expect(serverRun!.join(" ")).not.toContain("acme-db");
            const imported = calls.find((args) => args.includes("mariadb") && args.includes("source /backup/database.sql"));
            expect(imported).toBeDefined();
            expect(imported!.join(" ")).not.toContain("acme-db");
            expect(imported!.join(" ")).not.toContain("--env-file");
            const checked = calls.find((args) => args.some((value) => value.startsWith("SELECT COUNT")));
            expect(checked).toBeDefined();
            expect(calls.some((args) => args[0] === "rm")).toBe(true);
            expect(calls.some((args) => args[0] === "network" && args[1] === "rm")).toBe(true);
            expect(await readFile(`${managedSiteRestoreDir(root, "restore02")}/backup/database.sql`, "utf8")).toBe(SQL);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("refuses latest, a malformed id and a foreign snapshot before extracting", async () => {
        const root = await siteRoot();
        try {
            for (const snapshotId of ["latest", "ABC", "a".repeat(63)]) {
                const { docker, calls } = fakeDocker({ restore: (target) => restoreFiles(target) });
                const result = await runManagedSiteRestore(
                    { stackDir: root, manifest: manifest(), attemptId: "restore03", snapshotId },
                    { docker, checkCredentials },
                );
                expect(result.ok).toBe(false);
                if (result.ok) continue;
                expect(result.phase).toBe("check");
                expect(calls).toEqual([]);
            }
            const foreign = fakeDocker({ snapshot: snapshotManifest({ siteId: "other" }), restore: (target) => restoreFiles(target) });
            const result = await runManagedSiteRestore(
                { stackDir: root, manifest: manifest(), attemptId: "restore04", snapshotId: SNAPSHOT },
                { docker: foreign.docker, checkCredentials },
            );
            expect(result.ok).toBe(false);
            expect(foreign.calls.some((args) => args.includes("restore"))).toBe(false);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("refuses a restored file that does not match its recorded hash", async () => {
        const root = await siteRoot();
        try {
            const { docker } = fakeDocker({ restore: (target) => restoreFiles(target, { content: "tampered" }) });
            const result = await runManagedSiteRestore(
                { stackDir: root, manifest: manifest(), attemptId: "restore05", snapshotId: SNAPSHOT },
                { docker, checkCredentials },
            );
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.phase).toBe("verify");
            expect(result.completed).toEqual([]);
            expect(
                await lstat(managedSiteRestoreDir(root, "restore05")).then(
                    (info) => info.isDirectory(),
                    () => false,
                ),
            ).toBe(true);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("refuses a symbolic link in the restored tree", async () => {
        const root = await siteRoot();
        try {
            const { docker } = fakeDocker({
                restore: async (target) => {
                    await restoreFiles(target);
                    try {
                        await symlink(`${target}/backup/files/shared/uploads/a.txt`, `${target}/backup/files/link`);
                    } catch {
                        // Windows without symlink privilege: the Linux lab covers it.
                    }
                },
            });
            const result = await runManagedSiteRestore(
                { stackDir: root, manifest: manifest(), attemptId: "restore06", snapshotId: SNAPSHOT },
                { docker, checkCredentials },
            );
            if (process.platform === "win32") return;
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.phase).toBe("verify");
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("reports files as completed when the SQL import fails, and cleans disposable resources", async () => {
        const root = await siteRoot();
        try {
            const { docker, calls } = fakeDocker({
                snapshot: snapshotManifest({ mode: "files+sql" }),
                restore: (target) => restoreFiles(target, { sql: true }),
                importResult: { code: 2, stdout: "", stderr: "import denied", timedOut: false, truncated: false },
            });
            const result = await runManagedSiteRestore(
                { stackDir: root, manifest: withSql(), attemptId: "restore07", snapshotId: SNAPSHOT },
                { docker, checkCredentials },
            );
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.phase).toBe("sql");
            expect(result.completed).toEqual(["files"]);
            expect(result.reason).toContain("import denied");
            expect(calls.some((args) => args[0] === "rm")).toBe(true);
            expect(calls.some((args) => args[0] === "network" && args[1] === "rm")).toBe(true);
            expect(result.restoreDir).toBe(managedSiteRestoreDir(root, "restore07"));
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("refuses while a backup marker is unconfirmed", async () => {
        const root = await siteRoot();
        try {
            await mkdir(`${root}/site/private/backup`, { recursive: true });
            await writeFile(
                managedSiteBackupAttemptPath(root),
                JSON.stringify({
                    version: 1,
                    siteId: SITE,
                    attemptId: "backup0009",
                    repository: "rest:https://backup.example.test/acme-shop",
                    startedAt: "2026-11-25T10:00:00.000Z",
                    phase: "upload",
                    outcome: "failed",
                }),
            );
            const { docker, calls } = fakeDocker();
            const result = await runManagedSiteRestore(
                { stackDir: root, manifest: manifest(), attemptId: "restore08", snapshotId: SNAPSHOT },
                { docker, checkCredentials },
            );
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.reason).toContain("unconfirmed outcome");
            expect(calls).toEqual([]);
            expect(await lstat(managedSiteRestoreDir(root, "restore08")).catch(() => null)).toBeNull();
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
