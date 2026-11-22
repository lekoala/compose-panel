/**
 * Fixed Composer preparation for a managed release (ADR 0045).
 *
 * One release is prepared in a single disposable container: only the attempt's
 * staging tree is mounted writable, the container is unprivileged and
 * read-only, no Docker socket, secret or production path is passed, and the
 * output, memory, CPU, process count and time are bounded. The build never
 * publishes anything; the caller removes the staging tree on failure.
 *
 * Project code is not executed: Composer runs with `--no-scripts --no-plugins`,
 * and `config.platform.php` in composer.json must name the site's PHP channel so
 * the committed lock file is verified for the runtime the site actually runs.
 */
import { lstat, rm, statfs } from "node:fs/promises";
import { join } from "node:path";
import { runCommand, type CommandResult, type RunOptions } from "./docker.ts";
import { FileSafetyError, randomSuffix, readFileSafe } from "./fs-safe.ts";
import { MANAGED_SITE_CHANNELS, MANAGED_SITE_PATHS, isManagedSiteAttemptId, type ManagedSiteManifest } from "./managed-site.ts";
import type { GitReleasePrepare } from "./git-release.ts";

/** One pinned Composer image for every channel; only Composer itself runs. */
export const MANAGED_SITE_BUILD_IMAGE = "composer:2.8";
/** Scratch directory created inside the staging tree and removed afterwards. */
export const MANAGED_SITE_BUILD_SCRATCH = ".compose-panel-build";
/** A built release is larger than its source tree; this is its own hard cap. */
export const MANAGED_SITE_RELEASE_LIMITS = {
    maxFiles: 120_000,
    maxTreeBytes: 512 * 1024 * 1024,
    maxDepth: 64,
} as const;
export const MANAGED_SITE_BUILD_TIMEOUT_MS = 5 * 60 * 1000;

const COMPOSER_JSON_MAX_BYTES = 256 * 1024;
const COMPOSER_LOCK_MAX_BYTES = 32 * 1024 * 1024;
const BUILD_OUTPUT_MAX_BYTES = 256 * 1024;
const CONTAINER_PREFIX = "compose-panel-build-";

export type BuildRunner = (args: string[], options: RunOptions) => Promise<CommandResult>;

export interface ComposerBuildRequest {
    /** Canonical absolute stack directory, identical in the panel and on the host. */
    stackDir: string;
    /** Bounded attempt identifier that names the staging directory. */
    attemptId: string;
    /** The attempt's checked-out tree, already inspected for symlinks. */
    tree: string;
    /** `8.3` or `8.4`: the PHP channel the lock must be verified for. */
    phpMinor: string;
    runner?: BuildRunner;
    onOutput?: (chunk: string) => void;
    signal?: AbortSignal;
    timeoutMs?: number;
}

export type ComposerBuildResult =
    | { ok: true; image: string }
    | {
          ok: false;
          reason: string;
          /** The container may still exist: the caller must keep the attempt. */
          unconfirmed: boolean;
      };

/**
 * Run `composer install` for one staged release. A refusal happens before any
 * container is created; a failure always tries to remove the container and
 * reports whether that removal is proven.
 */
export async function runComposerPreparation(request: ComposerBuildRequest): Promise<ComposerBuildResult> {
    const fail = (reason: string, unconfirmed = false): ComposerBuildResult => ({ ok: false, reason, unconfirmed });
    if (!isCanonicalAbsolute(request.stackDir) || !isCanonicalAbsolute(request.tree)) {
        return fail("The build needs canonical absolute paths.");
    }
    if (!isManagedSiteAttemptId(request.attemptId)) return fail("The build attempt identifier is not valid.");
    if (!MANAGED_SITE_CHANNELS.some((channel) => channel.phpMinor === request.phpMinor)) {
        return fail("The build has no pinned PHP channel.");
    }
    const expected = join(request.stackDir, ...MANAGED_SITE_PATHS.staging.split("/"), request.attemptId, "tree");
    if (request.tree !== expected) return fail("The build directory is not this attempt's staging tree.");

    let treeInfo;
    try {
        treeInfo = await lstat(request.tree);
    } catch {
        return fail("The build directory is missing; nothing was prepared.");
    }
    if (treeInfo.isSymbolicLink() || !treeInfo.isDirectory()) {
        return fail("The build directory is not a real directory; nothing was prepared.");
    }

    let composerJson;
    try {
        composerJson = await readFileSafe(join(request.tree, "composer.json"), COMPOSER_JSON_MAX_BYTES);
    } catch (error) {
        if (error instanceof FileSafetyError) return fail(`composer.json cannot be used: ${error.message}`);
        throw error;
    }
    if (!composerJson) return fail("The release has no composer.json, so Composer cannot be prepared.");
    const platform = declaredPlatform(composerJson.source);
    if (platform === "invalid") return fail("composer.json is not a usable JSON object.");
    if (platform === "missing") {
        return fail(
            `composer.json must declare config.platform.php as "${request.phpMinor}.x" so the committed lock file is resolved and verified for the site's PHP channel.`,
        );
    }
    if (platform !== request.phpMinor) {
        return fail(
            `composer.json declares config.platform.php for PHP ${platform}, but the site runs PHP ${request.phpMinor}. Nothing was prepared.`,
        );
    }

    let lock;
    try {
        lock = await readFileSafe(join(request.tree, "composer.lock"), COMPOSER_LOCK_MAX_BYTES);
    } catch (error) {
        if (error instanceof FileSafetyError) return fail(`composer.lock cannot be used: ${error.message}`);
        throw error;
    }
    if (!lock) return fail("The release has no composer.lock; the pilot requires a committed dependency lock file.");

    // The container writes only into the staging tree, so the release
    // filesystem is the one that must hold the bounded result.
    const free = await statfs(request.tree)
        .then((stats) => stats.bavail * stats.bsize)
        .catch(() => null);
    if (free !== null && free < MANAGED_SITE_RELEASE_LIMITS.maxTreeBytes + 64 * 1024 * 1024) {
        return fail("The release filesystem does not have enough free space for a bounded Composer build.");
    }

    const runner: BuildRunner = request.runner ?? ((args, options) => runCommand("docker", args, options));
    const timeoutMs = request.timeoutMs ?? MANAGED_SITE_BUILD_TIMEOUT_MS;
    const name = `${CONTAINER_PREFIX}${request.attemptId}-${randomSuffix()}`;
    const args = buildArguments(request.tree, treeInfo.uid, treeInfo.gid, name, timeoutMs);

    let result: CommandResult;
    try {
        result = await runner(args, {
            timeoutMs,
            maxBytes: BUILD_OUTPUT_MAX_BYTES,
            onChunk: request.onOutput,
            signal: request.signal,
            stopOnOutputLimit: true,
        });
    } catch {
        result = { code: -1, stdout: "", stderr: "", timedOut: false, truncated: false };
    }

    // The Docker CLI can be killed while the container keeps running, and
    // `--rm` only removes it once it exits. Prove it is gone before releasing
    // the stack lock or touching the attempt.
    const removed = await removeContainer(runner, name);
    if (!removed) {
        return fail("The preparation container could not be confirmed removed; the site needs inspection.", true);
    }
    if (result.timedOut) return fail("The Composer build timed out; its container was removed and nothing was published.");
    if (result.truncated)
        return fail("Composer produced more output than the pilot allows; its container was removed and nothing was published.");
    if (result.terminationUnconfirmed) {
        return fail("The Composer command could not be confirmed to have exited; its container was removed and nothing was published.");
    }
    if (result.code !== 0) return fail("Composer could not install the locked dependencies in the disposable container.");

    try {
        await rm(join(request.tree, MANAGED_SITE_BUILD_SCRATCH), { recursive: true, force: true });
    } catch {
        return fail("The Composer build succeeded but its scratch directory could not be removed; nothing was published.");
    }
    const autoload = await lstat(join(request.tree, "vendor", "autoload.php")).catch(() => null);
    if (!autoload || autoload.isSymbolicLink() || !autoload.isFile()) {
        return fail("The Composer build left no regular vendor/autoload.php; nothing was published.");
    }
    return { ok: true, image: MANAGED_SITE_BUILD_IMAGE };
}

/** The prepare callback for a manifest, or `undefined` when it declares none. */
export function composerPreparation(manifest: ManagedSiteManifest): GitReleasePrepare | undefined {
    if (manifest.build?.kind !== "composer") return undefined;
    const channel = MANAGED_SITE_CHANNELS.find((entry) => entry.image === manifest.runtime.image);
    if (!channel) {
        return async () => ({ ok: false, reason: "The site does not declare a pinned PHP channel, so Composer cannot be prepared." });
    }
    return (context) =>
        runComposerPreparation({
            stackDir: context.stackDir,
            attemptId: context.attemptId,
            tree: context.tree,
            phpMinor: channel.phpMinor,
            onOutput: context.onOutput,
            ...(context.signal ? { signal: context.signal } : {}),
        });
}

function buildArguments(tree: string, uid: number, gid: number, name: string, timeoutMs: number): string[] {
    // Composer's own process timeout stays below the container deadline so a
    // stuck download is reported by Composer before the panel kills the CLI.
    const processTimeout = Math.max(30, Math.floor(timeoutMs / 1000) - 30);
    return [
        "run",
        "--rm",
        "--init",
        "--name",
        name,
        "--network",
        "bridge",
        "--user",
        `${uid}:${gid}`,
        "--read-only",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=64m",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "512",
        "--memory",
        "1g",
        "--memory-swap",
        "1g",
        "--cpus",
        "1",
        "--stop-timeout",
        "10",
        "-e",
        `COMPOSER_HOME=/build/${MANAGED_SITE_BUILD_SCRATCH}/home`,
        "-e",
        `COMPOSER_CACHE_DIR=/build/${MANAGED_SITE_BUILD_SCRATCH}/cache`,
        "-e",
        "COMPOSER_NO_INTERACTION=1",
        "-e",
        "COMPOSER_BIN_COMPAT=proxy",
        "-e",
        "COMPOSER_DISABLE_XDEBUG_WARN=1",
        "-e",
        `COMPOSER_PROCESS_TIMEOUT=${processTimeout}`,
        "-v",
        `${tree}:/build`,
        "-w",
        "/build",
        MANAGED_SITE_BUILD_IMAGE,
        "install",
        "--no-interaction",
        "--no-dev",
        "--no-progress",
        "--prefer-dist",
        "--no-scripts",
        "--no-plugins",
        "--optimize-autoloader",
        "--no-ansi",
    ];
}

/** `docker rm -f` then prove the name is absent from `docker ps -a`. */
async function removeContainer(runner: BuildRunner, name: string): Promise<boolean> {
    const removed = await runner(["rm", "-f", name], { timeoutMs: 30_000, maxBytes: 16 * 1024 }).catch(() => null);
    if (!removed || removed.terminationUnconfirmed) return false;
    const listed = await runner(["ps", "-a", "--filter", `name=^${name}$`, "--format", "{{.Names}}"], {
        timeoutMs: 30_000,
        maxBytes: 16 * 1024,
    }).catch(() => null);
    if (!listed || listed.terminationUnconfirmed || listed.truncated || listed.code !== 0) return false;
    return listed.stdout.trim() === "";
}

/** `config.platform.php` as a major.minor, `missing`, or `invalid`. */
function declaredPlatform(source: string): string | "missing" | "invalid" {
    let value: unknown;
    try {
        value = JSON.parse(source);
    } catch {
        return "invalid";
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) return "invalid";
    const config = (value as Record<string, unknown>).config;
    if (config === undefined) return "missing";
    if (typeof config !== "object" || config === null || Array.isArray(config)) return "invalid";
    const platform = (config as Record<string, unknown>).platform;
    if (platform === undefined) return "missing";
    if (typeof platform !== "object" || platform === null || Array.isArray(platform)) return "invalid";
    const php = (platform as Record<string, unknown>).php;
    if (typeof php !== "string") return "missing";
    const match = /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(php);
    return match ? `${match[1]}.${match[2]}` : "invalid";
}

function isCanonicalAbsolute(value: string): boolean {
    if (value.length === 0 || value.includes("\0")) return false;
    if (!/^(?:\/|[A-Za-z]:[\\/])/.test(value)) return false;
    if (value.length > 1 && /[\\/]$/.test(value)) return false;
    return !value.includes("/../") && !value.includes("\\..\\");
}
