import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import type { Stats } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
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

/** Permission bits and ownership a rewritten file must keep. */
export interface FileAttributes {
    mode: number;
    uid: number;
    gid: number;
}

export interface SafeFile extends FileAttributes {
    path: string;
    source: string;
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
    if (info.isSymbolicLink()) throw new FileSafetyError("The file is a symbolic link. For safety, the panel only uses regular files.");
    if (!info.isFile()) throw new FileSafetyError("This is not a regular file, so the panel will not use it.");

    // O_NOFOLLOW closes the symlink race between lstat and open on Linux.
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
        const stat = await handle.stat();
        if (stat.size > maxBytes) throw new FileSafetyError("The file is too large for the panel.");
        const source = await handle.readFile({ encoding: "utf8" });
        if (Buffer.byteLength(source, "utf8") > maxBytes) throw new FileSafetyError("The file is too large for the panel.");
        return { path, source, mode: stat.mode & 0o777, uid: stat.uid, gid: stat.gid, hash: hashContent(source) };
    } finally {
        await handle.close();
    }
}

/**
 * Write via a temp file in the same directory then rename, preserving the mode
 * and ownership. The rename replaces the inode, so without a chown a panel
 * running as root would hand the user's compose.yaml/.env over to root.
 */
export async function writeFileAtomic(path: string, content: string, attributes: FileAttributes): Promise<void> {
    const { mode, uid, gid } = attributes;
    const dir = dirname(path);
    const tmp = join(dir, `.cp-tmp-${randomSuffix()}`);
    const handle = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
    try {
        try {
            await handle.writeFile(content, { encoding: "utf8" });
            const created = await handle.stat();
            if (process.platform === "linux" && (created.uid !== uid || created.gid !== gid)) {
                try {
                    await handle.chown(uid, gid);
                } catch {
                    throw new FileSafetyError("The file owner and group could not be preserved. The original file was not replaced.");
                }
            }
            try { await handle.chmod(mode); }
            catch { if (process.platform === "linux") throw new FileSafetyError("The file permissions could not be preserved. The original file was not replaced."); }
            await handle.sync();
        } finally {
            await handle.close();
        }
        await rename(tmp, path);
    } catch (error) {
        // A failed commit must not leave a draft .env behind.
        await unlink(tmp).catch(() => {});
        throw error;
    }
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
    if (info.isSymbolicLink() || !info.isDirectory()) throw new FileSafetyError("This folder is a symbolic link or not a folder, so the panel will not use it.");
    return { dev: info.dev, ino: info.ino };
}

export function sameDirIdentity(a: DirIdentity, b: DirIdentity): boolean {
    return a.dev === b.dev && a.ino === b.ino;
}

/**
 * Walk `components` below `root`, lstat-checking each one: a symlink or a
 * non-directory throws `message`, so a managed tree cannot be redirected
 * outside `root`. A missing component is created owner-only when `create`
 * is set; otherwise the walk stops and returns null. `root` itself is trusted.
 */
async function walkManagedDir(root: string, components: string[], create: boolean, message: string): Promise<string | null> {
    let current = root;
    for (const component of components) {
        current = join(current, component);
        let info: Stats | null = null;
        try {
            info = await lstat(current);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (!info) {
            if (!create) return null;
            await mkdir(current, { recursive: false, mode: 0o700 });
            try {
                await chmod(current, 0o700);
            } catch {
                // Best effort; some platforms (Windows) ignore POSIX modes.
            }
            continue;
        }
        if (info.isSymbolicLink() || !info.isDirectory()) throw new FileSafetyError(message);
    }
    return current;
}

/** Create the managed directories below a trusted root, refusing symlinked components. */
export async function ensureManagedDir(root: string, components: string[], message: string): Promise<string> {
    return (await walkManagedDir(root, components, true, message))!;
}

/** Check existing managed directories below a trusted root; null when one is missing. */
export function checkManagedDir(root: string, components: string[], message: string): Promise<string | null> {
    return walkManagedDir(root, components, false, message);
}

/**
 * Ensure <root>/.compose-panel/backups/<name> exists as real directories.
 * Every managed component is lstat-checked: symlinks and non-directories are
 * refused, so backups cannot be redirected outside the stacks root. Created
 * directories are owner-only (backups hold Compose files and .env secrets).
 */
export function ensureBackupDir(root: string, name: string): Promise<string> {
    return ensureManagedDir(root, [".compose-panel", "backups", name], "The backup folder is a symbolic link or not a folder, so nothing was saved.");
}
