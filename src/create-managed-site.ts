/**
 * Create the files of an `owner: "managed"` site (ADR 0042).
 *
 * The raw creation path (ADR 0024) stays untouched. This module validates the
 * generated Compose file through the same provider before publishing it, then
 * writes the trusted manifest and the approved gateway configuration. It never
 * fetches a release and never starts a container: the first release is a
 * separate, explicit step.
 */
import { chmod, mkdir, open } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { createStack } from "./create-stack.ts";
import type { ComposeProvider } from "./compose-provider.ts";
import { FileSafetyError, readFileSafe } from "./fs-safe.ts";
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
    beforeCommit?: () => void;
}

export class ManagedSiteCreationPartialError extends StackError {
    constructor(reason: string) {
        super(
            `${reason}\nThe Compose project was not started, but the folder exists. Inspect it on the host before retrying; an existing folder is never replaced.`,
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
    const manifest = parseManagedSiteManifest(site.manifestSource);
    if (!manifest.ok) throw new StackError(manifest.reason);
    if (manifest.manifest.owner !== "managed") throw new StackError("The generated manifest is not a managed site.");
    const directory = join(root, site.stackName);

    // The ordinary creation path validates the generated Compose file in its
    // final directory, resolves the project name through Compose and refuses a
    // project Docker already knows. It publishes compose.yaml last.
    await createStack(root, { name: site.stackName, composeSource: site.artifacts.compose, envSource: "" }, provider, maxBytes, options);

    try {
        // Services run with their image's own UID and must traverse the stack
        // path; the release layout has always documented 0755 here.
        if (process.platform !== "win32") await chmod(directory, 0o755);
        await mkdir(join(directory, MANAGED_SITE_PATHS.generated), { mode: 0o755 });
        for (const components of PUBLIC_DIRS) await makeDirectory(directory, components, 0o755);
        for (const components of PRIVATE_DIRS) await makeDirectory(directory, components, 0o700);
        await writeNewFile(join(directory, MANAGED_SITE_GATEWAY_CONFIG), site.artifacts.gateway, 0o644);
        await writeNewFile(join(directory, MANAGED_SITE_OPCACHE_CONFIG), site.artifacts.opcache, 0o644);
        // The manifest is written last: until it exists the folder is only an
        // ordinary stack, never a half-managed site.
        await writeNewFile(join(directory, MANAGED_SITE_MANIFEST_FILE), site.manifestSource, 0o644);
    } catch (error) {
        if (error instanceof StackError) throw error;
        throw new ManagedSiteCreationPartialError("The site files could not all be written.");
    }
}

async function makeDirectory(root: string, components: readonly string[], mode: number): Promise<void> {
    const path = join(root, ...components);
    try {
        await mkdir(path, { mode });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new StackError("A managed site file already exists.", 409);
        throw error;
    }
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
