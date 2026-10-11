import type { Stats } from "node:fs";
import { lstat, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { checkManagedDir } from "./fs-safe.ts";
import { validateStackName } from "./stacks.ts";

const LINKED_DIR = "The backup folder is a symbolic link or not a folder, so the panel will not use it.";

/**
 * Exactly what `backupFile` writes: `<label>.<ISO time with ":" and "." as "-">.<18 hex>`.
 * Anything else in the folder (notes, copies made by hand) is never listed or deleted.
 */
const BACKUP_NAME = /^(.+)\.(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.[0-9a-f]{18}$/;

export interface BackupEntry {
    filename: string;
    /** The live file this is a copy of (`compose.yaml`, `.env`, ...). */
    label: string;
    /** Sortable UTC timestamp from the filename. */
    stamp: string;
    size: number;
}

/**
 * Backups of one stack, newest first. Only regular files with the backup name
 * format count; a missing folder means no backups. A symlinked folder throws.
 */
export async function listBackups(root: string, name: string): Promise<BackupEntry[]> {
    validateStackName(name);
    const dir = await checkManagedDir(root, [".compose-panel", "backups", name], LINKED_DIR);
    if (dir === null) return [];
    const entries: BackupEntry[] = [];
    for (const filename of await readdir(dir)) {
        const match = BACKUP_NAME.exec(filename);
        if (!match) continue;
        let info: Stats;
        try {
            info = await lstat(join(dir, filename));
        } catch {
            continue; // Removed meanwhile.
        }
        if (!info.isFile()) continue;
        entries.push({ filename, label: match[1]!, stamp: match[2]!, size: info.size });
    }
    return entries.sort((a, b) => b.stamp.localeCompare(a.stamp) || b.filename.localeCompare(a.filename));
}

/**
 * Delete all but the `keep` newest backups of each file of a stack; `keep` 0
 * deletes them all. Returns the number of files removed. `unlink` never follows
 * a symlink, so an entry swapped after the listing cannot redirect the delete.
 */
export async function pruneBackups(root: string, name: string, keep: number): Promise<number> {
    const entries = await listBackups(root, name);
    if (entries.length === 0) return 0;
    const dir = join(root, ".compose-panel", "backups", name);
    const kept = new Map<string, number>();
    let removed = 0;
    for (const entry of entries) {
        const seen = kept.get(entry.label) ?? 0;
        if (seen < keep) {
            kept.set(entry.label, seen + 1);
            continue;
        }
        try {
            await unlink(join(dir, entry.filename));
            removed += 1;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
    }
    return removed;
}
