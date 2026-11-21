/**
 * Bounded Git release adapter (ADRs 0043 and 0044): fetch one operator-configured
 * Git branch, resolve it to a full commit SHA, verify the staged tree, write
 * the fixed revision script and publish the release by one rename.
 *
 * Everything here is a fixed command with an explicit argument array. The URL
 * and ref come from the trusted manifest, never from a request. The checkout is
 * content: it is never executed, sourced or read as Compose input, and it is
 * never mounted into the panel.
 */
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, rm, statfs, unlink } from "node:fs/promises";
import type { Stats } from "node:fs";
import { isAbsolute, join, normalize, sep } from "node:path";
import { runCommand, type CommandResult, type RunOptions } from "./docker.ts";
import {
    checkManagedDir,
    dirIdentity,
    ensureManagedDir,
    readFileSafe,
    sameDirIdentity,
    randomSuffix,
    FileSafetyError,
    type DirIdentity,
} from "./fs-safe.ts";
import {
    isManagedSiteReleaseId,
    deployGitTransport,
    isValidDeployRef,
    isManagedSiteAttemptId,
    MANAGED_SITE_PATHS,
} from "./managed-site.ts";

export const GIT_RELEASE_PHASES = ["layout", "fetch", "resolve", "inspect", "checkout", "prepare", "publish"] as const;
export type GitReleasePhase = (typeof GIT_RELEASE_PHASES)[number];

export interface GitReleaseLimits {
    /** Total time allowed for the network fetch. */
    fetchTimeoutMs: number;
    /** Time allowed for one local Git command or the checkout. */
    commandTimeoutMs: number;
    /** Captured Git diagnostics; the operation view never receives the tree. */
    maxOutputBytes: number;
    /** Bytes allowed in the fetched pack/objects while the transfer runs. */
    maxDownloadBytes: number;
    /** Poll interval of the transfer monitor; tests use a short one. */
    monitorIntervalMs: number;
    /** Files allowed in one release. */
    maxFiles: number;
    /** Total bytes allowed in one release. */
    maxTreeBytes: number;
    /** Directory depth allowed in one release. */
    maxDepth: number;
}

export const DEFAULT_GIT_RELEASE_LIMITS: GitReleaseLimits = {
    fetchTimeoutMs: 120_000,
    commandTimeoutMs: 30_000,
    maxOutputBytes: 64 * 1024,
    maxDownloadBytes: 128 * 1024 * 1024,
    monitorIntervalMs: 200,
    maxFiles: 20_000,
    maxTreeBytes: 256 * 1024 * 1024,
    maxDepth: 64,
};

/** Free space kept beyond a bounded transfer or checkout. */
const FREE_SPACE_HEADROOM = 64 * 1024 * 1024;

export type GitRunner = (args: string[], options: RunOptions) => Promise<CommandResult>;

export interface GitReleaseRequest {
    /** Canonical absolute stack directory, identical in the panel and on the host. */
    stackDir: string;
    /** Bounded attempt identifier used as the staging directory name. */
    attemptId: string;
    /** Manifest site id; bound into the release metadata. */
    siteId: string;
    url: string;
    ref: string;
    limits?: Partial<GitReleaseLimits>;
    /** Injectable for tests; production always uses the fixed `git` executable. */
    runner?: GitRunner;
    onOutput?: (chunk: string) => void;
    signal?: AbortSignal;
}

export type GitReleaseSuccess = {
    ok: true;
    releaseId: string;
    /** Absolute path of the published immutable release. */
    releasePath: string;
    metadataPath: string;
    /** True when a complete release for the same SHA was revalidated, not rewritten. */
    reused: boolean;
};

export type GitReleaseFailure = {
    ok: false;
    phase: GitReleasePhase;
    reason: string;
    /** Bounded Git diagnostic, only for the operation view; never audited. */
    detail?: string;
    /** The Git command could not be confirmed to have exited. */
    unconfirmed: boolean;
    /** What happened to this attempt's staging directory. */
    cleanup: "removed" | "kept" | "none";
};

export type GitReleaseResult = GitReleaseSuccess | GitReleaseFailure;

const COMMIT = /^[0-9a-f]{40}$/;
const REVISION_BYTES_MAX = 1024;
const METADATA_BYTES_MAX = 4096;
const SSH_CREDENTIALS_MAX_BYTES = 64 * 1024;

/**
 * Neutralised Git environment. Built from an allow-list, never inherited: an
 * operator's global config, credential helper, hooks, askpass, prompts or
 * protocol settings cannot reach the fetch.
 */
export function gitEnvironment(gitRoot: string, ceiling = gitRoot): Record<string, string> {
    const env: Record<string, string> = {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: join(gitRoot, "home"),
        XDG_CONFIG_HOME: join(gitRoot, "xdg"),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: join(gitRoot, "gitconfig"),
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "",
        SSH_ASKPASS: "",
        GIT_ALLOW_PROTOCOL: "https",
        GIT_PROTOCOL_FROM_USER: "0",
        GIT_HTTP_FOLLOW_REDIRECTS: "0",
        GIT_LFS_SKIP_SMUDGE: "1",
        GIT_CEILING_DIRECTORIES: ceiling,
        LC_ALL: "C",
        LANG: "C",
        TMPDIR: join(gitRoot, "tmp"),
    };
    if (process.platform === "win32") {
        for (const key of [
            "SystemRoot",
            "SystemDrive",
            "windir",
            "COMSPEC",
            "PATHEXT",
            "TEMP",
            "TMP",
            "USERPROFILE",
            "HOMEDRIVE",
            "HOMEPATH",
            "APPDATA",
            "LOCALAPPDATA",
            "ProgramFiles",
            "ProgramData",
            "NUMBER_OF_PROCESSORS",
            "PROCESSOR_ARCHITECTURE",
            "OS",
        ]) {
            const value = process.env[key];
            if (value !== undefined) env[key] = value;
        }
    }
    return env;
}

/**
 * Parse the exact output of `git rev-parse --verify FETCH_HEAD^{commit}`: one
 * full lowercase SHA and nothing else. A short, decorated or ambiguous answer is
 * never used to name a release directory.
 */
export function parseGitCommit(stdout: string): string | null {
    const value = stdout.replace(/\r?\n$/, "");
    return COMMIT.test(value) ? value : null;
}

export type GitTreeListing = { ok: true; files: number; bytes: number } | { ok: false; reason: string };

/**
 * Inspect `git ls-tree -r -l -z --full-tree` before any checkout. Symlinks
 * (`120000`) and gitlinks/submodules (`160000`) are refused from the tree
 * object itself, so a filesystem that materialises symlinks differently cannot
 * hide one. Paths must stay relative, without `..`, `.git` components or
 * control characters.
 */
export function parseGitTreeListing(stdout: string, limits: Pick<GitReleaseLimits, "maxFiles" | "maxTreeBytes">): GitTreeListing {
    const records = stdout.split("\0");
    let files = 0;
    let bytes = 0;
    for (const record of records) {
        if (record === "") continue;
        const tab = record.indexOf("\t");
        if (tab <= 0) return { ok: false, reason: "The fetched tree listing is not the expected format." };
        const header = record.slice(0, tab).trim().split(/\s+/);
        if (header.length !== 4) return { ok: false, reason: "The fetched tree listing has an unexpected entry." };
        const [mode, type, object, size] = header as [string, string, string, string];
        if (!/^[0-9a-f]{40,64}$/.test(object)) return { ok: false, reason: "The fetched tree listing has an unexpected object id." };
        if (mode === "120000" || type === "commit" || mode === "160000") {
            return { ok: false, reason: "The repository contains a symbolic link or a submodule, which the pilot refuses." };
        }
        if (type !== "blob" || (mode !== "100644" && mode !== "100755" && mode !== "100664")) {
            return { ok: false, reason: "The repository contains an unsupported file mode." };
        }
        const path = record.slice(tab + 1);
        const pathRefusal = checkTreePath(path);
        if (pathRefusal) return { ok: false, reason: pathRefusal };
        if (!/^\d+$/.test(size)) return { ok: false, reason: "The fetched tree listing has an unexpected size." };
        files++;
        bytes += Number(size);
        if (files > limits.maxFiles) return { ok: false, reason: "The repository contains too many files for the pilot." };
        if (bytes > limits.maxTreeBytes) return { ok: false, reason: "The repository is larger than the pilot allows." };
    }
    return { ok: true, files, bytes };
}

function checkTreePath(path: string): string | null {
    if (path.length === 0) return "The fetched tree contains an empty path.";
    if (path.length > 4096) return "The fetched tree contains an over-long path.";
    if (path.startsWith("/") || path.includes("\\")) return "The fetched tree contains a non-relative path.";
    for (const character of path) {
        const code = character.codePointAt(0)!;
        if (code < 0x20 || code === 0x7f) return "The fetched tree contains a control character in a path.";
    }
    const segments = path.split("/");
    for (const segment of segments) {
        if (segment === "" || segment === "." || segment === "..") return "The fetched tree contains a traversing path.";
        if (segment.toLowerCase() === ".git") return "The repository contains a .git entry, which the panel refuses.";
    }
    return null;
}

export interface ReleaseMetadata {
    siteId: string;
    release: string;
}

/** Read the completed-release metadata; anything unexpected is `null`. */
export function parseReleaseMetadata(source: string): ReleaseMetadata | null {
    let value: unknown;
    try {
        value = JSON.parse(source);
    } catch {
        return null;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.join(",") !== "release,siteId,status,version") return null;
    if (record.version !== 1 || record.status !== "complete") return null;
    const siteId = record.siteId;
    const release = record.release;
    if (typeof siteId !== "string" || siteId.length === 0 || siteId.length > 64) return null;
    if (typeof release !== "string" || !isManagedSiteReleaseId(release)) return null;
    return { siteId, release };
}

/** Fixed revision script content, identical for every release. */
export function revisionScript(releaseId: string): string {
    return `<?php\nheader('Content-Type: text/plain; charset=utf-8');\necho '${releaseId}', "\\n";\n`;
}

/**
 * Fetch, verify and publish one release. On failure the active release is
 * untouched and only this attempt's staging directory is removed, after its
 * device/inode identity is compared with the one created here. After
 * publication nothing is deleted automatically: a release is kept for rollback
 * and inspection.
 */
export async function fetchAndPublishGitRelease(request: GitReleaseRequest): Promise<GitReleaseResult> {
    const limits: GitReleaseLimits = { ...DEFAULT_GIT_RELEASE_LIMITS, ...request.limits };
    const runner: GitRunner = request.runner ?? ((args, options) => runCommand("git", args, options));
    const stackDir = request.stackDir;

    if (!isCanonicalAbsolute(stackDir)) {
        return {
            ok: false,
            phase: "layout",
            reason: "The stack directory is not a canonical absolute path.",
            unconfirmed: false,
            cleanup: "none",
        };
    }
    if (!isManagedSiteAttemptId(request.attemptId)) {
        return { ok: false, phase: "layout", reason: "The attempt identifier is not valid.", unconfirmed: false, cleanup: "none" };
    }
    const transport = deployGitTransport(request.url);
    if (!transport || !isValidDeployRef(request.ref)) {
        return {
            ok: false,
            phase: "layout",
            reason: "The repository URL or branch is not one the pilot accepts.",
            unconfirmed: false,
            cleanup: "none",
        };
    }

    let phase: GitReleasePhase = "layout";
    let attemptDir: string | null = null;
    let attemptIdentity: DirIdentity | null = null;
    let published: { path: string; identity: DirIdentity } | null = null;
    let publishedComplete = false;
    let unconfirmed = false;

    const fail = async (reason: string, detail?: string): Promise<GitReleaseFailure> => {
        let cleanup: GitReleaseFailure["cleanup"] = "none";
        if (published && !publishedComplete) {
            await removeProvenDirectory(published.path, published.identity);
        }
        if (attemptDir && unconfirmed) {
            cleanup = "kept";
        } else if (attemptDir) {
            // The directory was created here exclusively, so it is ours. A
            // failed identity capture is retried instead of deleting blindly.
            if (!attemptIdentity) attemptIdentity = await dirIdentity(attemptDir).catch(() => null);
            if (attemptIdentity) cleanup = (await removeProvenDirectory(attemptDir, attemptIdentity)) ? "removed" : "kept";
        }
        return { ok: false, phase, reason, ...(detail ? { detail } : {}), unconfirmed, cleanup };
    };

    /** Drop only this attempt's staging directory; publication is never undone. */
    const cleanupAttempt = async (): Promise<void> => {
        if (!attemptDir || !attemptIdentity) return;
        await removeProvenDirectory(attemptDir, attemptIdentity);
    };

    try {
        const layout = await checkLayout(stackDir);
        if (!layout.ok) return fail(layout.reason);
        const { staging, releases, metadataRoot, gitRoot } = layout;
        if (transport === "ssh") {
            phase = "fetch";
            await checkSshCredentials(stackDir);
            phase = "layout";
        }

        // Panel-owned private Git home: config, HOME, XDG, tmp and an empty
        // hooks directory. None of it is mounted into a container.
        const gitConfig = join(gitRoot, "gitconfig");
        for (const name of ["home", "xdg", "tmp", "hooks"]) {
            await ensureManagedDir(stackDir, ["site", "private", "git", name], PRIVATE_DIR_MESSAGE);
        }
        await ensureEmptyFile(gitConfig);
        const hooks = join(gitRoot, "hooks");

        const newAttempt = join(staging, request.attemptId);
        try {
            await mkdir(newAttempt, { mode: 0o700 });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST") {
                return fail("A staging directory already exists for this attempt; nothing was fetched.");
            }
            throw error;
        }
        attemptDir = newAttempt;
        await setMode(attemptDir, 0o700);
        attemptIdentity = await dirIdentity(attemptDir);
        const env = gitEnvironment(gitRoot, attemptDir);
        // GIT_ALLOW_PROTOCOL overrides the base config for this command only.
        const fetchEnv =
            transport === "ssh"
                ? { ...env, GIT_ALLOW_PROTOCOL: "ssh", GIT_SSH: join(import.meta.dir, "scripts", "git-ssh.sh"), GIT_SSH_VARIANT: "ssh" }
                : env;

        const repo = join(attemptDir, "repo");
        const tree = join(attemptDir, "tree");
        const gitDir = join(repo, ".git");
        const config = gitConfiguration(hooks);

        phase = "fetch";
        const init = await runGit(runner, [...config, "init", "--quiet", repo], {
            cwd: attemptDir,
            env,
            timeoutMs: limits.commandTimeoutMs,
            maxBytes: limits.maxOutputBytes,
            signal: request.signal,
        });
        unconfirmed ||= init.terminationUnconfirmed === true;
        if (!commandSucceeded(init)) return fail("The staging repository could not be created.", diagnostic(init));

        const freeBeforeFetch = await availableBytes(staging);
        if (freeBeforeFetch !== null && freeBeforeFetch < limits.maxDownloadBytes + FREE_SPACE_HEADROOM) {
            return fail("The release filesystem does not have enough free space for a bounded fetch.");
        }

        // Bound the transfer itself, not only the final tree: the pack can fill
        // the staging directory long before the checkout is inspected.
        const transfer = new AbortController();
        const forwardAbort = () => transfer.abort();
        request.signal?.addEventListener("abort", forwardAbort, { once: true });
        if (request.signal?.aborted) forwardAbort();
        let downloadExceeded = false;
        const monitor = startTransferMonitor(
            gitDir,
            limits.maxDownloadBytes,
            () => {
                downloadExceeded = true;
                transfer.abort();
            },
            limits.monitorIntervalMs,
        );
        let fetched: CommandResult;
        try {
            fetched = await runGit(
                runner,
                [
                    ...config,
                    "-C",
                    repo,
                    "fetch",
                    "--quiet",
                    "--depth",
                    "1",
                    "--no-tags",
                    "--no-recurse-submodules",
                    "--",
                    request.url,
                    request.ref,
                ],
                {
                    cwd: attemptDir,
                    env: fetchEnv,
                    timeoutMs: limits.fetchTimeoutMs,
                    maxBytes: limits.maxOutputBytes,
                    onChunk: transport === "https" ? request.onOutput : undefined,
                    signal: transfer.signal,
                    stopOnOutputLimit: true,
                },
            );
        } finally {
            monitor.stop();
            request.signal?.removeEventListener("abort", forwardAbort);
        }
        unconfirmed ||= fetched.terminationUnconfirmed === true;
        const fetchDiagnostic = transport === "https" ? diagnostic(fetched) : undefined;
        if (downloadExceeded) {
            return fail("The download exceeded the pilot's byte limit; the attempt was stopped.", fetchDiagnostic);
        }
        if (fetched.timedOut) return fail("The fetch timed out; nothing was published.", fetchDiagnostic);
        if (fetched.terminationUnconfirmed === true) return fail("The Git fetch could not be confirmed to have exited.");
        if (fetched.truncated) return fail("Git exceeded the fetch output limit; nothing was published.");
        if (fetched.code !== 0) {
            return fail(
                transport === "ssh"
                    ? "SSH fetch failed. Check the deploy key, pinned host key and repository access."
                    : "The configured branch could not be fetched.",
                fetchDiagnostic,
            );
        }

        phase = "resolve";
        const resolved = await runGit(runner, [...config, "-C", repo, "rev-parse", "--verify", "FETCH_HEAD^{commit}"], {
            cwd: attemptDir,
            env,
            timeoutMs: limits.commandTimeoutMs,
            maxBytes: limits.maxOutputBytes,
            signal: request.signal,
        });
        unconfirmed ||= resolved.terminationUnconfirmed === true;
        if (!commandSucceeded(resolved)) return fail("The fetched branch could not be resolved to a commit.", diagnostic(resolved));
        const releaseId = parseGitCommit(resolved.stdout);
        if (!releaseId) return fail("The fetched branch did not resolve to one full lowercase commit SHA.");

        phase = "inspect";
        const releasePath = join(releases, releaseId);
        const metadataPath = join(metadataRoot, `${releaseId}.json`);
        const existing = await lstatOrNull(releasePath);
        if (existing) {
            const reused = await revalidateExistingRelease(releasePath, metadataPath, request.siteId, releaseId);
            if (!reused.ok) return fail(reused.reason);
            await cleanupAttempt();
            return { ok: true, releaseId, releasePath, metadataPath, reused: true };
        }
        if (await lstatOrNull(metadataPath)) {
            return fail("Completed-release metadata exists without its release directory; the site needs inspection.");
        }

        const listing = await runGit(runner, [...config, "-C", repo, "ls-tree", "-r", "-l", "-z", "--full-tree", releaseId], {
            cwd: attemptDir,
            env,
            timeoutMs: limits.commandTimeoutMs,
            maxBytes: Math.min(limits.maxFiles * 512 + 8192, 16 * 1024 * 1024),
            signal: request.signal,
        });
        unconfirmed ||= listing.terminationUnconfirmed === true;
        if (!commandSucceeded(listing)) return fail("The fetched tree could not be inspected.", diagnostic(listing));
        const treeFacts = parseGitTreeListing(listing.stdout, limits);
        if (!treeFacts.ok) return fail(treeFacts.reason);

        phase = "checkout";
        const freeBeforeCheckout = await availableBytes(staging);
        if (freeBeforeCheckout !== null && freeBeforeCheckout < treeFacts.bytes + FREE_SPACE_HEADROOM) {
            return fail("The release filesystem does not have enough free space for the checked-out tree.");
        }
        await mkdir(tree, { mode: 0o755 });
        const checkedOut = await runGit(
            runner,
            [...config, "--git-dir", gitDir, "--work-tree", tree, "checkout", "--quiet", "--force", "--detach", releaseId],
            {
                cwd: attemptDir,
                env,
                timeoutMs: limits.commandTimeoutMs,
                maxBytes: limits.maxOutputBytes,
                signal: request.signal,
            },
        );
        unconfirmed ||= checkedOut.terminationUnconfirmed === true;
        if (checkedOut.timedOut) return fail("The checkout timed out; nothing was published.", diagnostic(checkedOut));
        if (checkedOut.terminationUnconfirmed === true) return fail("The Git checkout could not be confirmed to have exited.");
        if (checkedOut.code !== 0) return fail("The fetched tree could not be checked out.", diagnostic(checkedOut));

        phase = "prepare";
        const inspected = await inspectStagedTree(tree, limits);
        if (!inspected.ok) return fail(inspected.reason);
        const prepared = await writeRevisionScript(tree, releaseId);
        if (!prepared.ok) return fail(prepared.reason);

        phase = "publish";
        const treeIdentity = await dirIdentity(tree);
        // Publication is one rename. A non-empty destination cannot be replaced
        // by rename, and the check above refused any existing release for this
        // SHA, so a concurrent publisher can never overwrite a release.
        await rename(tree, releasePath);
        published = { path: releasePath, identity: treeIdentity };

        const metadata = JSON.stringify({ version: 1, siteId: request.siteId, release: releaseId, status: "complete" });
        const temp = join(metadataRoot, `.cp-${request.attemptId}-${randomSuffix()}.tmp`);
        try {
            await writeNewFile(temp, `${metadata}\n`, 0o600);
            await rename(temp, metadataPath);
        } catch (error) {
            await unlink(temp).catch(() => {});
            throw error;
        }
        publishedComplete = true;
        await cleanupAttempt();
        return { ok: true, releaseId, releasePath, metadataPath, reused: false };
    } catch (error) {
        if (error instanceof FileSafetyError) return fail(error.message);
        return fail(describeFailure(error, phase));
    }
}

const PRIVATE_DIR_MESSAGE =
    "The site layout is missing or unsafe: site/staging, site/runtime/releases and site/private must be real directories below the stack.";

async function checkSshCredentials(stackDir: string): Promise<void> {
    if (process.platform !== "linux") throw new FileSafetyError("Private Git over SSH requires a Linux panel.");
    const message = "Provision site/private/ssh/identity and known_hosts as private regular files owned by the panel user.";
    const sshDir = await checkManagedDir(stackDir, ["site", "private", "ssh"], message);
    if (!sshDir) throw new FileSafetyError(message);

    // OpenSSH reads these paths itself. The private directories must be
    // controlled by the panel UID so another user cannot swap a checked file.
    const uid = process.geteuid!();
    for (const path of [join(stackDir, MANAGED_SITE_PATHS.staging), join(stackDir, MANAGED_SITE_PATHS.private), sshDir]) {
        const info = await lstat(path);
        if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o077) !== 0) throw new FileSafetyError(message);
    }
    for (const path of [stackDir, join(stackDir, "site")]) {
        const info = await lstat(path);
        if (!info.isDirectory() || (info.mode & 0o022) !== 0) {
            throw new FileSafetyError(
                "The stack and site directories must be real directories writable only by their owner for SSH deploys.",
            );
        }
    }
    for (const name of ["identity", "known_hosts"]) {
        const info = await lstatOrNull(join(sshDir, name));
        if (!info?.isFile() || info.nlink !== 1 || info.uid !== uid || (info.mode & 0o077) !== 0) throw new FileSafetyError(message);
        if (info.size === 0 || info.size > SSH_CREDENTIALS_MAX_BYTES) throw new FileSafetyError(message);
    }
}

async function checkLayout(
    stackDir: string,
): Promise<{ ok: true; staging: string; releases: string; metadataRoot: string; gitRoot: string } | { ok: false; reason: string }> {
    const staging = await checkManagedDir(stackDir, ["site", "staging"], PRIVATE_DIR_MESSAGE);
    if (!staging)
        return { ok: false, reason: `${MANAGED_SITE_PATHS.staging} is missing; the operator must initialise the release layout.` };
    const releases = await checkManagedDir(stackDir, ["site", "runtime", "releases"], PRIVATE_DIR_MESSAGE);
    if (!releases)
        return { ok: false, reason: `${MANAGED_SITE_PATHS.releases} is missing; the operator must initialise the release layout.` };
    const privateRoot = await checkManagedDir(stackDir, ["site", "private"], PRIVATE_DIR_MESSAGE);
    if (!privateRoot)
        return { ok: false, reason: `${MANAGED_SITE_PATHS.private} is missing; the operator must initialise the release layout.` };
    if (process.platform === "linux") {
        for (const [path, label] of [
            [staging, MANAGED_SITE_PATHS.staging],
            [privateRoot, MANAGED_SITE_PATHS.private],
        ] as const) {
            const info = await lstat(path);
            if ((info.mode & 0o077) !== 0) {
                return { ok: false, reason: `${label} must stay private: run chmod 700 on it before deploying.` };
            }
        }
    }
    const metadataRoot = await ensureManagedDir(stackDir, ["site", "private", "releases"], PRIVATE_DIR_MESSAGE);
    const gitRoot = await ensureManagedDir(stackDir, ["site", "private", "git"], PRIVATE_DIR_MESSAGE);
    return { ok: true, staging, releases, metadataRoot, gitRoot };
}

/** `-c` overrides applied to every command, before the subcommand. */
function gitConfiguration(hooks: string): string[] {
    return [
        "-c",
        "protocol.allow=never",
        "-c",
        "protocol.https.allow=always",
        "-c",
        "http.followRedirects=false",
        "-c",
        `core.hooksPath=${hooks}`,
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.autocrlf=false",
        "-c",
        "advice.detachedHead=false",
        "-c",
        "fetch.recurseSubmodules=false",
        "-c",
        "fetch.unpackLimit=1",
        "-c",
        "transfer.unpackLimit=1",
        "-c",
        "submodule.recurse=false",
        "-c",
        "gc.auto=0",
        "-c",
        "maintenance.auto=false",
        "-c",
        "credential.helper=",
    ];
}

function runGit(runner: GitRunner, args: string[], options: RunOptions): Promise<CommandResult> {
    return runner(args, options);
}

function commandSucceeded(result: CommandResult): boolean {
    return result.code === 0 && !result.timedOut && result.terminationUnconfirmed !== true && !result.truncated;
}

/** One bounded, single-line diagnostic for the operation view. */
function diagnostic(result: CommandResult): string | undefined {
    const text = (result.stderr || result.stdout).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ");
    const line = text
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean)
        .sort((a, b) => b.length - a.length)[0];
    if (!line) return undefined;
    return line.length > 300 ? `${line.slice(0, 300)}...` : line;
}

/** Map filesystem failures to actionable, non-secret reasons. */
function describeFailure(error: unknown, phase: GitReleasePhase): string {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOSPC" || code === "EDQUOT") {
        return "The release filesystem is out of space; nothing was published.";
    }
    if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
        return "The panel is not allowed to write the release filesystem; nothing was published.";
    }
    if (phase === "publish") return "The release could not be published; the active release is untouched.";
    if (phase === "prepare" || phase === "checkout") return "The fetched tree could not be prepared safely; nothing was published.";
    return "The release could not be prepared; the active release is untouched.";
}

async function removeProvenDirectory(path: string, identity: DirIdentity): Promise<boolean> {
    try {
        const current = await dirIdentity(path);
        if (!sameDirIdentity(current, identity)) return false;
        await rm(path, { recursive: true, force: false, maxRetries: 0 });
        return true;
    } catch {
        return false;
    }
}

/** The staged tree is content: real directories and regular files only. */
async function inspectStagedTree(tree: string, limits: GitReleaseLimits): Promise<{ ok: true } | { ok: false; reason: string }> {
    const reserved = await lstatOrNull(join(tree, ".compose-panel"));
    if (reserved) return { ok: false, reason: "The repository contains .compose-panel, which the panel reserves." };

    let files = 0;
    let bytes = 0;
    const pending: Array<{ path: string; depth: number }> = [{ path: tree, depth: 0 }];
    while (pending.length > 0) {
        const { path, depth } = pending.pop()!;
        if (depth > limits.maxDepth) return { ok: false, reason: "The repository is nested more deeply than the pilot allows." };
        for (const entry of await readdir(path, { withFileTypes: true })) {
            const full = join(path, entry.name);
            const info = await lstat(full);
            if (info.isSymbolicLink()) return { ok: false, reason: "The repository contains a symbolic link, which the pilot refuses." };
            if (info.isDirectory()) {
                await setMode(full, 0o755);
                pending.push({ path: full, depth: depth + 1 });
                continue;
            }
            if (!info.isFile()) return { ok: false, reason: "The repository contains a file type the pilot does not allow." };
            files++;
            bytes += info.size;
            if (files > limits.maxFiles) return { ok: false, reason: "The repository contains too many files for the pilot." };
            if (bytes > limits.maxTreeBytes) return { ok: false, reason: "The repository is larger than the pilot allows." };
            await setMode(full, 0o644);
        }
    }

    const publicRoot = join(tree, "public");
    const publicInfo = await lstatOrNull(publicRoot);
    if (!publicInfo || publicInfo.isSymbolicLink() || !publicInfo.isDirectory()) {
        return { ok: false, reason: "The release has no public/ directory." };
    }
    const index = await lstatOrNull(join(publicRoot, "index.php"));
    if (!index || index.isSymbolicLink() || !index.isFile()) {
        return { ok: false, reason: "The release has no public/index.php front controller." };
    }
    return { ok: true };
}

/** Write the fixed probe script outside public/, refusing a pre-existing path. */
async function writeRevisionScript(tree: string, releaseId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const directory = join(tree, ".compose-panel");
    try {
        await mkdir(directory, { mode: 0o755 });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            return { ok: false, reason: "The repository already carries .compose-panel, which the panel reserves." };
        }
        throw error;
    }
    await setMode(directory, 0o755);
    await writeNewFile(join(directory, "revision.php"), revisionScript(releaseId), 0o644);
    return { ok: true };
}

/** Revalidate a complete release without rewriting it. */
async function revalidateExistingRelease(
    releasePath: string,
    metadataPath: string,
    siteId: string,
    releaseId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
    const info = await lstat(releasePath);
    if (info.isSymbolicLink() || !info.isDirectory()) {
        return { ok: false, reason: "The release path exists but is not a real directory; the site needs inspection." };
    }
    let metadataSource: string;
    try {
        const metadata = await readFileSafe(metadataPath, METADATA_BYTES_MAX);
        if (!metadata) return { ok: false, reason: "The release exists without completed-release metadata; the site needs inspection." };
        metadataSource = metadata.source;
    } catch (error) {
        if (error instanceof FileSafetyError)
            return { ok: false, reason: "The release metadata is a symbolic link; the site needs inspection." };
        throw error;
    }
    const metadata = parseReleaseMetadata(metadataSource);
    if (!metadata || metadata.release !== releaseId || metadata.siteId !== siteId) {
        return { ok: false, reason: "The release metadata does not mark this SHA complete for this site; the site needs inspection." };
    }
    try {
        const revision = await readFileSafe(join(releasePath, ".compose-panel", "revision.php"), REVISION_BYTES_MAX);
        if (!revision || revision.source !== revisionScript(releaseId)) {
            return { ok: false, reason: "The release does not carry the expected revision script; the site needs inspection." };
        }
    } catch {
        return { ok: false, reason: "The release does not carry a readable revision script; the site needs inspection." };
    }
    return { ok: true };
}

async function writeNewFile(path: string, content: string, mode: number): Promise<void> {
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
    try {
        await handle.writeFile(content, { encoding: "utf8" });
        await handle.sync();
    } finally {
        await handle.close();
    }
}

async function ensureEmptyFile(path: string): Promise<void> {
    const existing = await lstatOrNull(path);
    if (existing) {
        if (existing.isSymbolicLink() || !existing.isFile()) {
            throw new FileSafetyError("The private Git configuration is a symbolic link or not a regular file.");
        }
        return;
    }
    try {
        await writeNewFile(path, "", 0o600);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
}

async function lstatOrNull(path: string): Promise<Stats | null> {
    try {
        return await lstat(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
    }
}

async function setMode(path: string, mode: number): Promise<void> {
    try {
        await chmod(path, mode);
    } catch (error) {
        // POSIX modes are not meaningful on Windows; tests run there.
        if (process.platform !== "linux") return;
        throw error;
    }
}

/** Free bytes on the filesystem holding `path`, or null when unavailable. */
async function availableBytes(path: string): Promise<number | null> {
    try {
        const stats = await statfs(path);
        return stats.bavail * stats.bsize;
    } catch {
        return null;
    }
}

/**
 * Poll the Git directory during a transfer. Once the bytes exceed the cap, the
 * controller is aborted and `runCommand` kills the process group. The walk is
 * bounded and only touches `.git`, so it stays cheap.
 */
function startTransferMonitor(root: string, maxBytes: number, onExceed: () => void, intervalMs: number): { stop: () => void } {
    let stopped = false;
    let running = false;
    const check = async () => {
        if (stopped || running) return;
        running = true;
        try {
            const size = await directoryBytes(root, maxBytes);
            if (size > maxBytes) {
                stopped = true;
                onExceed();
            }
        } catch {
            /* a transient read error is retried on the next tick */
        } finally {
            running = false;
        }
    };
    const timer = setInterval(() => void check(), Math.max(10, intervalMs));
    void check();
    return {
        stop() {
            stopped = true;
            clearInterval(timer);
        },
    };
}

/** Recursive size, stopping as soon as the cap is exceeded. */
async function directoryBytes(root: string, limit: number): Promise<number> {
    let total = 0;
    let visited = 0;
    const pending = [root];
    while (pending.length > 0) {
        const dir = pending.pop()!;
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            const full = join(dir, entry.name);
            const info = await lstat(full).catch(() => null);
            if (!info) continue;
            if (info.isDirectory()) {
                pending.push(full);
                continue;
            }
            if (!info.isFile()) continue;
            total += info.size;
            if (total > limit) return total;
        }
        visited++;
        if (visited > 10_000) return total;
    }
    return total;
}

function isCanonicalAbsolute(value: string): boolean {
    if (value.length === 0 || value.includes("\0")) return false;
    if (!isAbsolute(value)) return false;
    if (value.length > 1 && value.endsWith(sep)) return false;
    return normalize(value) === value;
}
