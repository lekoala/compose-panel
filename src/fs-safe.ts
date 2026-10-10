import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import type { Stats } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

export function randomSuffix(): string {
    return randomBytes(9).toString("hex");
}

export function hashContent(text: string): string {
    return createHash("sha256").update(text, "utf8").digest("hex");
}

export class FileSafetyError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "FileSafetyError";
    }
}

export interface SafeFile {
    path: string;
    source: string;
    mode: number;
    hash: string;
}

/** Read a regular file, refusing symlinks and enforcing a size limit. */
export async function readFileSafe(path: string, maxBytes: number): Promise<SafeFile | null> {
    let info: Stats;
    try {
        info = await lstat(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
    }
    if (info.isSymbolicLink()) throw new FileSafetyError("Symbolic file not allowed.");
    if (!info.isFile()) throw new FileSafetyError("Not a regular file.");

    // O_NOFOLLOW closes the symlink race between lstat and open on Linux.
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
        const stat = await handle.stat();
        if (stat.size > maxBytes) throw new FileSafetyError("File too large.");
        const source = await handle.readFile({ encoding: "utf8" });
        if (Buffer.byteLength(source, "utf8") > maxBytes) throw new FileSafetyError("File too large.");
        return { path, source, mode: stat.mode & 0o777, hash: hashContent(source) };
    } finally {
        await handle.close();
    }
}

/** Write via a temp file in the same directory then rename, preserving the mode. */
export async function writeFileAtomic(path: string, content: string, mode: number): Promise<void> {
    const dir = dirname(path);
    const tmp = join(dir, `.cp-tmp-${randomSuffix()}`);
    const handle = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
    try {
        await handle.writeFile(content, { encoding: "utf8" });
        await handle.sync();
    } finally {
        await handle.close();
    }
    try {
        await chmod(tmp, mode);
    } catch {
        // Best effort; some platforms (Windows) ignore POSIX modes.
    }
    await rename(tmp, path);
}

/** Copy a file into a backup directory, returning the backup path. */
export async function backupFile(path: string, backupDir: string, label: string): Promise<string> {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const destination = join(backupDir, `${label}.${stamp}.${randomSuffix()}`);
    await copyFile(path, destination, constants.COPYFILE_EXCL);
    return destination;
}

/** Identity of a directory object, for detecting replacement between checks. */
export interface DirIdentity {
    dev: number;
    ino: number;
}

/** lstat a directory and refuse symlinks. The dev/ino pair names the object. */
export async function dirIdentity(path: string): Promise<DirIdentity> {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new FileSafetyError("Directory not allowed.");
    return { dev: info.dev, ino: info.ino };
}

export function sameDirIdentity(a: DirIdentity, b: DirIdentity): boolean {
    return a.dev === b.dev && a.ino === b.ino;
}

/**
 * Ensure <root>/.compose-panel/backups/<name> exists as real directories.
 * Every managed component is lstat-checked: symlinks and non-directories are
 * refused, so backups cannot be redirected outside the stacks root. Created
 * directories are owner-only (backups hold Compose files and .env secrets).
 */
export async function ensureBackupDir(root: string, name: string): Promise<string> {
    let current = root;
    for (const component of [".compose-panel", "backups", name]) {
        current = join(current, component);
        let info: Stats | null = null;
        try {
            info = await lstat(current);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (!info) {
            await mkdir(current, { recursive: false, mode: 0o700 });
            try {
                await chmod(current, 0o700);
            } catch {
                // Best effort; some platforms (Windows) ignore POSIX modes.
            }
            continue;
        }
        if (info.isSymbolicLink() || !info.isDirectory()) {
            throw new FileSafetyError("Backup path is not a real directory.");
        }
    }
    return current;
}
