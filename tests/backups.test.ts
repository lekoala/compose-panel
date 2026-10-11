import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listBackups, pruneBackups } from "../src/backups.ts";
import { backupFile, ensureBackupDir, FileSafetyError } from "../src/fs-safe.ts";

let root: string;
let dir: string;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "compose-panel-backups-"));
    dir = await ensureBackupDir(root, "demo");
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

/** A backup name as `backupFile` writes it, for a given second of a fixed day. */
function backupName(label: string, second: number): string {
    return `${label}.2026-10-11T08-00-${String(second).padStart(2, "0")}-000Z.${"a".repeat(18)}`;
}

async function plant(label: string, second: number, content = "x"): Promise<string> {
    const name = backupName(label, second);
    await writeFile(join(dir, name), content);
    return name;
}

describe("listBackups", () => {
    test("recognizes the files backupFile writes", async () => {
        const source = join(root, "compose.yaml");
        await writeFile(source, "services: {}\n");
        const made = await backupFile(source, dir, "compose.yaml");
        expect(await listBackups(root, "demo")).toEqual([
            expect.objectContaining({ filename: made.slice(dir.length + 1), label: "compose.yaml", size: 13 }),
        ]);
    });

    test("lists newest first", async () => {
        await plant("compose.yaml", 1, "abc");
        await plant(".env", 3);
        await plant("compose.yaml", 2);
        expect((await listBackups(root, "demo")).map(entry => [entry.label, entry.size])).toEqual([[".env", 1], ["compose.yaml", 1], ["compose.yaml", 3]]);
    });

    test("is empty when the stack never had a backup", async () => {
        expect(await listBackups(root, "other")).toEqual([]);
    });

    test("ignores files that are not panel backups", async () => {
        await plant(".env", 1);
        await writeFile(join(dir, "notes.txt"), "kept by hand");
        await writeFile(join(dir, "compose.yaml.bak"), "copy");
        await mkdir(join(dir, backupName("compose.yaml", 2)));
        expect((await listBackups(root, "demo")).map(entry => entry.filename)).toEqual([backupName(".env", 1)]);
    });

    test("rejects an invalid stack name", async () => {
        await expect(listBackups(root, "../demo")).rejects.toThrow();
    });

    test.skipIf(process.platform === "win32")("refuses a symlinked backup folder", async () => {
        const outside = await mkdtemp(join(tmpdir(), "compose-panel-outside-"));
        try {
            await writeFile(join(outside, backupName("compose.yaml", 1)), "outside");
            await rm(dir, { recursive: true });
            await symlink(outside, dir);
            await expect(listBackups(root, "demo")).rejects.toThrow(FileSafetyError);
            await expect(pruneBackups(root, "demo", 0)).rejects.toThrow(FileSafetyError);
            expect(await readdir(outside)).toHaveLength(1);
        } finally {
            await rm(outside, { recursive: true, force: true });
        }
    });

    test.skipIf(process.platform === "win32")("ignores a symlink named like a backup", async () => {
        const outside = await mkdtemp(join(tmpdir(), "compose-panel-outside-"));
        try {
            await writeFile(join(outside, "target"), "outside");
            await symlink(join(outside, "target"), join(dir, backupName(".env", 1)));
            expect(await listBackups(root, "demo")).toEqual([]);
            await pruneBackups(root, "demo", 0);
            expect(await readdir(outside)).toEqual(["target"]);
        } finally {
            await rm(outside, { recursive: true, force: true });
        }
    });
});

describe("pruneBackups", () => {
    test("keeps the newest backups of each file separately", async () => {
        for (let second = 1; second <= 4; second++) await plant("compose.yaml", second);
        for (let second = 1; second <= 3; second++) await plant(".env", second);
        expect(await pruneBackups(root, "demo", 2)).toBe(3);
        expect((await readdir(dir)).sort()).toEqual([
            backupName(".env", 2), backupName(".env", 3),
            backupName("compose.yaml", 3), backupName("compose.yaml", 4),
        ].sort());
    });

    test("deletes every backup with keep 0 and leaves other files alone", async () => {
        await plant("compose.yaml", 1);
        await plant(".env", 1);
        await writeFile(join(dir, "notes.txt"), "kept by hand");
        expect(await pruneBackups(root, "demo", 0)).toBe(2);
        expect(await readdir(dir)).toEqual(["notes.txt"]);
    });

    test("does nothing without a backup folder", async () => {
        expect(await pruneBackups(root, "other", 0)).toBe(0);
        expect(await readdir(join(root, ".compose-panel", "backups"))).toEqual(["demo"]);
    });
});
