import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chown, mkdtemp, mkdir, readdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileSafetyError, backupFile, dirIdentity, ensureBackupDir, readFileSafe, sameDirIdentity, writeFileAtomic } from "../src/fs-safe.ts";
import { foreignOwner } from "./helpers/ownership.ts";

let root: string;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "compose-panel-fssafe-"));
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

describe("ensureBackupDir", () => {
    test("creates the managed hierarchy and accepts backups", async () => {
        const dir = await ensureBackupDir(root, "demo");
        expect(dir).toBe(join(root, ".compose-panel", "backups", "demo"));
        const source = join(root, "source.txt");
        await writeFile(source, "backup me\n");
        const backup = await backupFile(source, dir, "probe");
        expect(backup.startsWith(dir)).toBe(true);
        // Second call reuses the existing hierarchy.
        expect(await ensureBackupDir(root, "demo")).toBe(dir);
        expect(await readdir(dir)).toHaveLength(1);
    });

    test.skipIf(process.platform === "win32")("restricts created directories to owner-only", async () => {
        const dir = await ensureBackupDir(root, "demo");
        let current = root;
        for (const component of [".compose-panel", "backups", "demo"]) {
            current = join(current, component);
            expect((await stat(current)).mode & 0o777).toBe(0o700);
        }
        expect(dir).toBe(current);
    });

    test("refuses a regular file blocking the hierarchy", async () => {
        await writeFile(join(root, ".compose-panel"), "blocker");
        await expect(ensureBackupDir(root, "demo")).rejects.toThrow(FileSafetyError);
    });

    test.skipIf(process.platform === "win32")("refuses a symlinked component and leaves the target alone", async () => {
        const outside = await mkdtemp(join(tmpdir(), "compose-panel-outside-"));
        try {
            await writeFile(join(outside, "planted.txt"), "outside\n");
            await symlink(outside, join(root, ".compose-panel"));
            await expect(ensureBackupDir(root, "demo")).rejects.toThrow(FileSafetyError);
            expect(await readdir(outside)).toEqual(["planted.txt"]);
        } finally {
            await rm(outside, { recursive: true, force: true });
        }
    });

    test.skipIf(process.platform === "win32")("refuses a symlinked stack backup directory", async () => {
        await ensureBackupDir(root, "demo");
        const outside = await mkdtemp(join(tmpdir(), "compose-panel-outside-"));
        try {
            await writeFile(join(outside, "planted.txt"), "outside\n");
            await rm(join(root, ".compose-panel", "backups", "demo"), { recursive: true });
            await symlink(outside, join(root, ".compose-panel", "backups", "demo"));
            await expect(ensureBackupDir(root, "demo")).rejects.toThrow(FileSafetyError);
            expect(await readdir(outside)).toEqual(["planted.txt"]);
        } finally {
            await rm(outside, { recursive: true, force: true });
        }
    });
});

describe("dirIdentity", () => {
    test.skipIf(process.platform === "win32")("names the directory object, not its path", async () => {
        const target = join(root, "stack");
        await mkdir(target);
        await writeFile(join(target, "compose.yaml"), "services: {}\n");
        const before = await dirIdentity(target);
        expect(sameDirIdentity(before, await dirIdentity(target))).toBe(true);
        // Replace the directory with byte-identical content: same path, new object.
        // Keep the first object alive: dev/ino is not a generation counter
        // and Linux is allowed to recycle an inode after deletion.
        await rename(target, join(root, "original-stack"));
        await mkdir(target);
        await writeFile(join(target, "compose.yaml"), "services: {}\n");
        expect(sameDirIdentity(before, await dirIdentity(target))).toBe(false);
    });

    test.skipIf(process.platform === "win32")("refuses symlinks", async () => {
        const outside = await mkdtemp(join(tmpdir(), "compose-panel-outside-"));
        try {
            await symlink(outside, join(root, "link"));
            await expect(dirIdentity(join(root, "link"))).rejects.toThrow(FileSafetyError);
        } finally {
            await rm(outside, { recursive: true, force: true });
        }
    });
});

describe("writeFileAtomic", () => {
    test.skipIf(process.platform === "win32")("keeps the mode of the replaced file", async () => {
        const path = join(root, ".env");
        await writeFile(path, "A=1\n", { mode: 0o640 });
        const original = (await readFileSafe(path, 1024))!;
        await writeFileAtomic(path, "A=2\n", original);
        expect((await stat(path)).mode & 0o777).toBe(0o640);
        expect(await readFile(path, "utf8")).toBe("A=2\n");
    });

    // Regression: the temp file + rename used to leave the file owned by the
    // panel process (root in the image), locking the user out of their .env.
    test.skipIf(foreignOwner === null)("keeps the owner and group of the replaced file", async () => {
        const owner = foreignOwner!;
        const path = join(root, ".env");
        await writeFile(path, "A=1\n", { mode: 0o600 });
        await chown(path, owner.uid, owner.gid);
        const original = (await readFileSafe(path, 1024))!;
        await writeFileAtomic(path, "A=2\n", original);
        const after = await stat(path);
        expect({ uid: after.uid, gid: after.gid }).toEqual(owner);
        expect(after.mode & 0o777).toBe(0o600);
    });
});

