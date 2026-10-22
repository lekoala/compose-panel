import { constants } from "node:fs";
import type { Stats } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

export const COMPOSE_FILES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"] as const;
const OVERRIDE_FILES = [
    "compose.override.yaml",
    "compose.override.yml",
    "docker-compose.override.yaml",
    "docker-compose.override.yml",
] as const;
const MAX_COMPOSE_BYTES = 1024 * 1024;
export const ENV_FILENAME = ".env";
const STACK_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export class StackError extends Error {
    readonly status: number;
    constructor(message: string, status = 400) {
        super(message);
        this.status = status;
        this.name = "StackError";
    }
}

export function validateStackName(name: string): void {
    if (!STACK_NAME.test(name)) throw new StackError("This stack name is not valid.");
}

export async function resolveRoot(input: string): Promise<string> {
    if (!isAbsolute(input)) throw new Error("STACKS_DIR must be an absolute path.");
    const root = await realpath(input);
    if (!(await lstat(root)).isDirectory()) throw new Error("STACKS_DIR must be a directory.");
    return root;
}

async function stackDir(root: string, name: string): Promise<string> {
    validateStackName(name);
    const candidate = join(root, name);
    let info: Stats;
    try {
        info = await lstat(candidate);
    } catch {
        throw new StackError("There is no stack with this name.", 404);
    }
    if (!info.isDirectory() || info.isSymbolicLink())
        throw new StackError("This stack cannot be managed: it is a symbolic link or not a folder.", 404);
    const canonical = await realpath(candidate);
    const delta = relative(root, canonical);
    if (!delta || delta === ".." || delta.startsWith(`..${sep}`) || isAbsolute(delta) || delta.includes(sep)) {
        throw new StackError("This folder is outside the stacks folder.");
    }
    return canonical;
}

export interface StackDescriptor {
    name: string;
    composeFile: string;
}

export async function locateComposeFile(root: string, name: string): Promise<{ path: string; filename: string }> {
    const dir = await stackDir(root, name);
    const found: string[] = [];
    for (const filename of [...COMPOSE_FILES, ...OVERRIDE_FILES]) {
        const candidate = join(dir, filename);
        let info: Stats;
        try {
            info = await lstat(candidate);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
            throw error;
        }
        if (info.isSymbolicLink())
            throw new StackError("The Compose file is a symbolic link. For safety, the panel only manages regular files.");
        if (info.isFile()) {
            if ((OVERRIDE_FILES as readonly string[]).includes(filename)) {
                throw new StackError(
                    "This stack has a Compose override file. The panel does not support override files yet: manage this stack with the docker compose CLI.",
                );
            }
            found.push(filename);
        }
    }
    if (found.length === 0)
        throw new StackError(
            "This folder has no Compose file (compose.yaml, compose.yml, docker-compose.yaml or docker-compose.yml).",
            404,
        );
    if (found.length !== 1)
        throw new StackError("This folder has more than one Compose file. Keep only one so the panel knows which to use.");
    return { path: join(dir, found[0]!), filename: found[0]! };
}

export async function listStacks(root: string): Promise<StackDescriptor[]> {
    const list: StackDescriptor[] = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !STACK_NAME.test(entry.name)) continue;
        try {
            const located = await locateComposeFile(root, entry.name);
            list.push({ name: entry.name, composeFile: located.filename });
        } catch (error) {
            // Unsafe, missing or ambiguous stacks are NOT silently editable.
            // A later diagnostic UI may list them as unavailable.
            if (!(error instanceof StackError)) throw error;
        }
    }
    return list.sort((a, b) => a.name.localeCompare(b.name));
}

export async function readStackCompose(root: string, name: string): Promise<{ name: string; filename: string; source: string }> {
    const located = await locateComposeFile(root, name);
    // Linux: opening O_NOFOLLOW closes the final symlink race between lstat and open.
    const handle = await open(located.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > MAX_COMPOSE_BYTES) {
            throw new StackError("The Compose file cannot be read: it is not a regular file or it is too large.");
        }
        const source = await handle.readFile({ encoding: "utf8" });
        if (Buffer.byteLength(source, "utf8") > MAX_COMPOSE_BYTES) throw new StackError("The Compose file is too large for the panel.");
        return { name, filename: located.filename, source };
    } finally {
        await handle.close();
    }
}
