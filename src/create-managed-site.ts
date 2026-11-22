/**
 * Create the files of an `owner: "managed"` site (ADR 0042).
 *
 * The raw creation path (ADR 0024) stays untouched. A managed site is built in
 * a hidden draft directory under the stacks root and published with one
 * `rename`, so the final folder never exists in a half-managed, pilotable
 * state: it is either absent or complete. Validation uses the same provider as
 * every other mutation and happens before the rename. No release is fetched and
 * no container is started.
 */
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { assertProjectAvailable } from "./create-stack.ts";
import type { ComposeProvider } from "./compose-provider.ts";
import { configValidationResult } from "./editor.ts";
import { dirIdentity, FileSafetyError, randomSuffix, readFileSafe, sameDirIdentity, type DirIdentity } from "./fs-safe.ts";
import { listStacks, StackError, validateStackName } from "./stacks.ts";
import {
    MANAGED_SITE_MANIFEST_FILE,
    MANAGED_SITE_MANIFEST_MAX_BYTES,
    MANAGED_SITE_PATHS,
    parseManagedSiteManifest,
} from "./managed-site.ts";
import { MANAGED_SITE_GATEWAY_CONFIG, MANAGED_SITE_OPCACHE_CONFIG, type ManagedSiteArtifacts } from "./managed-site-generate.ts";

export interface ManagedSiteCreation {
    stackName: string;
    manifestSource: string;
    artifacts: ManagedSiteArtifacts;
}

export interface CreateManagedSiteOptions {
    /** Called after validation and before the atomic publication rename. */
    beforePublish?: () => void | Promise<void>;
}

export class ManagedSiteCreationPartialError extends StackError {
    constructor(reason: string) {
        super(
            `${reason}\nNo final stack folder was published and no container was started, but a private draft folder may remain under the stacks root. Inspect it on the host before retrying.`,
            500,
        );
    }
}

const PRIVATE_DIRS = [
    ["site", "staging"],
    ["site", "private"],
] as const;
const PUBLIC_DIRS = [["site"], ["site", "runtime"], ["site", "runtime", "releases"], ["site", "shared"]] as const;

/** Create one managed site. The caller holds a lock covering the port and name. */
export async function createManagedSite(
    root: string,
    site: ManagedSiteCreation,
    provider: ComposeProvider,
    maxBytes: number,
    options: CreateManagedSiteOptions = {},
): Promise<void> {
    validateStackName(site.stackName);
    const parsed = parseManagedSiteManifest(site.manifestSource);
    if (!parsed.ok) throw new StackError(parsed.reason);
    if (parsed.manifest.owner !== "managed") throw new StackError("The generated manifest is not a managed site.");
    const manifest = parsed.manifest;
    const finalDir = join(root, site.stackName);
    const rootIdentity = await dirIdentity(root);
    const draftName = `.cp-site-${randomSuffix()}`;
    const draftDir = join(root, draftName);
    let draftIdentity: DirIdentity | null = null;
    let committed = false;
    let failure: unknown = null;

    try {
        // A dot-prefixed draft is never discovered as a stack (`listStacks`
        // rejects the name), so no operation or save can select it.
        await mkdir(draftDir, { mode: 0o755 });
        if (process.platform !== "win32") await chmod(draftDir, 0o755);
        draftIdentity = await dirIdentity(draftDir);
        await writeSite(draftDir, site, manifest.paths ?? []);
        await validateDraft(draftDir, maxBytes, provider, manifest.project);

        if (!sameDirIdentity(await dirIdentity(root), rootIdentity))
            throw new StackError("The stacks folder changed while the site was created.", 409);
        if (await lstatOrNull(finalDir)) throw new StackError("A file or folder with this stack name already exists.", 409);
        await options.beforePublish?.();
        if (!sameDirIdentity(await dirIdentity(root), rootIdentity))
            throw new StackError("The stacks folder changed while the site was created.", 409);

        // One rename publishes every file or none. A concurrent creation that
        // won the name makes this fail without merging two site trees.
        try {
            await rename(draftDir, finalDir);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (["EEXIST", "ENOTEMPTY", "ENOTDIR"].includes(code ?? ""))
                throw new StackError("A file or folder with this stack name already exists.", 409);
            throw error;
        }
        committed = true;
    } catch (error) {
        failure = error;
    } finally {
        if (!committed && draftIdentity) {
            try {
                if (sameDirIdentity(await dirIdentity(draftDir), draftIdentity)) await rm(draftDir, { recursive: true, force: true });
            } catch {
                failure = new ManagedSiteCreationPartialError("The site draft could not be cleaned up.");
            }
        }
    }
    if (failure) throw failure;
}

async function writeSite(root: string, site: ManagedSiteCreation, paths: string[]): Promise<void> {
    try {
        await mkdir(join(root, MANAGED_SITE_PATHS.generated), { mode: 0o755 });
        for (const components of PUBLIC_DIRS) await makeDirectory(root, components, 0o755);
        for (const components of PRIVATE_DIRS) await makeDirectory(root, components, 0o700);
        await writeNewFile(join(root, "compose.yaml"), site.artifacts.compose, 0o600);
        await writeNewFile(join(root, MANAGED_SITE_GATEWAY_CONFIG), site.artifacts.gateway, 0o644);
        await writeNewFile(join(root, MANAGED_SITE_OPCACHE_CONFIG), site.artifacts.opcache, 0o644);
        // The manifest is part of the published tree now, not a later marker:
        // a site is managed from the moment its folder becomes visible.
        await writeNewFile(join(root, MANAGED_SITE_MANIFEST_FILE), site.manifestSource, 0o644);
        for (const path of paths) {
            let current = join(root, MANAGED_SITE_PATHS.shared);
            for (const segment of path.split("/").slice(1)) {
                current = join(current, segment);
                await mkdir(current, { mode: 0o755 });
                if (process.platform !== "win32") await chmod(current, 0o755);
            }
        }
    } catch (error) {
        if (error instanceof StackError) throw error;
        throw new StackError("The site files could not all be written.", 500);
    }
}

async function validateDraft(root: string, maxBytes: number, provider: ComposeProvider, project: string): Promise<void> {
    const source = await readFileSafe(join(root, "compose.yaml"), maxBytes);
    if (!source) throw new StackError("The generated Compose file could not be read.", 500);
    const composeFile = join(root, "compose.yaml");
    const validation = configValidationResult(await provider.validateConfig({ directory: root, composeFile }), []);
    if (!validation.ok) throw new StackError(validation.message ?? "Compose validation failed.");
    const resolved = await provider.projectName({ composeFile, cwd: root });
    if (!resolved) throw new StackError("The Compose project name could not be resolved.", 503);
    if (resolved !== project) {
        throw new StackError(
            `The generated Compose file resolves the project "${resolved}", not "${project}". Nothing was published.`,
            409,
        );
    }
    await assertProjectAvailable(provider, project);
}

async function makeDirectory(root: string, components: readonly string[], mode: number): Promise<void> {
    const path = join(root, ...components);
    await mkdir(path, { mode });
    if (process.platform !== "win32") await chmod(path, mode);
}

async function writeNewFile(path: string, source: string, mode: number): Promise<void> {
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
    try {
        await handle.writeFile(source, "utf8");
        await handle.sync();
        if (process.platform !== "win32") await handle.chmod(mode);
    } finally {
        await handle.close();
    }
}

async function lstatOrNull(path: string) {
    try {
        return await lstat(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
    }
}

export type ManagedSitePortCheck = { kind: "free" } | { kind: "used"; stack: string } | { kind: "unavailable"; reason: string };

/**
 * Refuse a port already declared by another managed site's generated Compose.
 * A manifest that cannot be read is not silently treated as free: the caller
 * must be able to rely on this answer.
 */
export async function findManagedSitePortOwner(root: string, port: number, except: string | null): Promise<ManagedSitePortCheck> {
    let stacks;
    try {
        stacks = await listStacks(root);
    } catch {
        return { kind: "unavailable", reason: "The stacks folder could not be listed." };
    }
    for (const stack of stacks) {
        if (stack.name === except) continue;
        const directory = join(root, stack.name);
        let source: string;
        try {
            const file = await readFileSafe(join(directory, MANAGED_SITE_MANIFEST_FILE), MANAGED_SITE_MANIFEST_MAX_BYTES);
            if (!file) continue;
            source = file.source;
        } catch (error) {
            if (error instanceof FileSafetyError) {
                return { kind: "unavailable", reason: `The site manifest of the stack "${stack.name}" cannot be read.` };
            }
            return { kind: "unavailable", reason: `The site manifest of the stack "${stack.name}" could not be checked.` };
        }
        const manifest = parseManagedSiteManifest(source);
        if (!manifest.ok) return { kind: "unavailable", reason: `The site manifest of the stack "${stack.name}" is not valid.` };
        if (manifest.manifest.owner === "managed" && manifest.manifest.gateway?.port === port) {
            return { kind: "used", stack: stack.name };
        }
    }
    return { kind: "free" };
}
