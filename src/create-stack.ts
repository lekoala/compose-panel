import { constants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, readdir, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { StackError, validateStackName } from "./stacks.ts";
import { dirIdentity, hashContent, randomSuffix, readFileSafe, sameDirIdentity } from "./fs-safe.ts";
import { parseComposeLs } from "./compose-state.ts";
import type { ComposeProvider } from "./compose-provider.ts";

export interface CreateStackRequest { name: string; composeSource: string; envSource: string }
export class StackCreationPartialError extends StackError {
    constructor() { super("Creation could not be fully cleaned up. Inspect the stack folder before retrying; no Docker resources were started.", 500); }
}

/** Raw-file creation only. The caller holds the shared stack lock. */
export async function createStack(root: string, draft: CreateStackRequest, provider: ComposeProvider, maxBytes: number, beforeCommit?: () => void): Promise<void> {
    validateStackName(draft.name);
    if (!draft.composeSource.trim()) throw new StackError("Enter a Compose file.");
    if ([draft.composeSource, draft.envSource].some(text => Buffer.byteLength(text, "utf8") > maxBytes)) throw new StackError("The files are too large for the panel.", 413);
    const directory = join(root, draft.name);
    const rootIdentity = await dirIdentity(root);
    const rootHandle = process.platform === "linux" ? await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW) : null;
    const rooted = rootHandle ? `/proc/self/fd/${rootHandle.fd}` : root;
    let directoryHandle: Awaited<ReturnType<typeof open>> | null = null;
    let identity: Stats | null = null;
    let anchored = directory;
    let reserved = false;
    let committed = false;
    const owned = new Map<string, Stats>();
    const checkIdentity = async () => {
        if (!sameDirIdentity(await dirIdentity(root), rootIdentity) || !identity || !sameDirIdentity(await dirIdentity(directory), identity)) throw new StackError("The stack folder changed while it was being checked.", 409);
    };
    const write = async (filename: string, source: string) => {
        const handle = await open(join(anchored, filename), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
        try {
            owned.set(filename, await handle.stat());
            await handle.writeFile(source, "utf8");
            await handle.sync();
        } finally { await handle.close(); }
    };
    const publish = async (source: string, destination: string) => {
        await link(join(anchored, source), join(anchored, destination));
        owned.set(destination, owned.get(source)!);
    };
    const checkProjects = async (project: string) => {
        const result = await provider.listProjects();
        if (result.code !== 0 || result.timedOut || result.truncated) throw new StackError("Docker project ownership could not be checked. Try again when Docker is available.", 503);
        let projects;
        try { projects = parseComposeLs(result.stdout); }
        catch { throw new StackError("Docker project ownership could not be checked.", 503); }
        if (projects.some(item => item.name === project)) throw new StackError("The resolved Compose project already exists in Docker. Choose another project name.", 409);
    };
    try {
        if (rootHandle && !sameDirIdentity(await rootHandle.stat(), rootIdentity)) throw new StackError("The stacks folder changed.", 409);
        try { await mkdir(join(rooted, draft.name), { mode: 0o700 }); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new StackError("A file or folder with this stack name already exists.", 409);
            throw error;
        }
        reserved = true;
        identity = await lstat(join(rooted, draft.name));
        if (identity.isSymbolicLink() || !identity.isDirectory()) throw new StackError("The stack folder changed.", 409);
        directoryHandle = rootHandle ? await open(join(rooted, draft.name), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW) : null;
        if (directoryHandle && !sameDirIdentity(await directoryHandle.stat(), identity)) throw new StackError("The stack folder changed.", 409);
        anchored = directoryHandle ? `/proc/self/fd/${directoryHandle.fd}` : directory;
        await checkIdentity();
        const composeTmp = `.cp-create-${randomSuffix()}.yaml`;
        const envName = draft.envSource.length ? ".env" : `.cp-create-env-${randomSuffix()}`;
        // A real temporary .env is needed for relative service env_file: .env.
        // The directory is private and not discoverable as a stack yet.
        await write(composeTmp, draft.composeSource);
        await write(envName, draft.envSource);
        const composeFile = join(directory, composeTmp);
        const envFile = join(directory, envName);
        const validation = await provider.validateConfig({ directory, composeFile, envFile });
        if (validation.code !== 0 || validation.timedOut || validation.truncated) throw new StackError("Compose validation failed or was unavailable. Check the Compose file and variables, then try again.");
        await checkIdentity();
        const project = await provider.projectName({ cwd: directory, composeFile, envFile });
        if (!project) throw new StackError("The Compose project name could not be resolved.", 503);
        await checkIdentity();
        await checkProjects(project);
        await checkIdentity();
        const compose = await readFileSafe(join(anchored, composeTmp), maxBytes);
        const env = await readFileSafe(join(anchored, envName), maxBytes);
        if (compose?.hash !== hashContent(draft.composeSource) || env?.hash !== hashContent(draft.envSource)) throw new StackError("The draft files changed while they were being checked.", 409);
        for (const filename of [composeTmp, envName]) {
            if (!sameDirIdentity(await lstat(join(anchored, filename)), owned.get(filename)!)) throw new StackError("The draft files were replaced while they were being checked.", 409);
        }
        const files = await readdir(anchored);
        if (files.length !== 2 || !files.includes(composeTmp) || !files.includes(envName)) throw new StackError("Files were added while this stack was being checked.", 409);
        await checkProjects(project);
        await checkIdentity();
        beforeCommit?.();
        await publish(composeTmp, "compose.yaml");
        committed = true;
    } finally {
        let incomplete = false;
        if (reserved) {
            for (const [filename, info] of owned) {
                if (committed && (filename === "compose.yaml" || filename === ".env")) continue;
                try {
                    const current = await lstat(join(anchored, filename));
                    if (!sameDirIdentity(current, info) || !current.isFile()) { incomplete = true; continue; }
                    await unlink(join(anchored, filename));
                } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") incomplete = true; }
            }
            if (!committed) {
                try {
                    if (!identity || !sameDirIdentity(await dirIdentity(join(rooted, draft.name)), identity)) incomplete = true;
                    else await rmdir(join(rooted, draft.name));
                } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") incomplete = true; }
            }
        }
        await directoryHandle?.close();
        await rootHandle?.close();
        if (incomplete) throw new StackCreationPartialError();
    }
}
