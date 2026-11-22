/**
 * Fixed Composer preparation for a managed release (ADR 0045).
 *
 * One release is prepared in two disposable containers: a read-only lock-file
 * check with no network, then one unprivileged install. Only the attempt's
 * staging tree is mounted; Composer's home and cache live on a bounded tmpfs so
 * they never reach the release filesystem. Output, memory, CPU, process count
 * and time are bounded, and the tree is size-monitored while the install runs.
 *
 * Project code is not executed: Composer runs with `--no-scripts --no-plugins`,
 * and the lock's `platform-overrides.php` must name the site's PHP channel, so
 * the committed lock is verified for the runtime the site actually runs (not
 * for the PHP inside the Composer image).
 */
import { lstat, readdir, statfs } from "node:fs/promises";
import { join } from "node:path";
import { runCommand, type CommandResult, type RunOptions } from "./docker.ts";
import { FileSafetyError, randomSuffix, readFileSafe } from "./fs-safe.ts";
import {
    MANAGED_SITE_CHANNELS,
    MANAGED_SITE_PATHS,
    MANAGED_SITE_RESERVED_TREE_ENTRIES,
    isManagedSiteAttemptId,
    type ManagedSiteManifest,
} from "./managed-site.ts";
import type { GitReleasePrepare } from "./git-release.ts";

/**
 * Pinned Composer image. It only runs Composer; project code is never executed.
 * 2.10.3 is the first release that fixes CVE-2026-59944 (symlinked package bin
 * paths) for the 2.10 line.
 */
export const MANAGED_SITE_BUILD_IMAGE = "composer:2.10.3";
/** A built release is larger than its source tree; this is its own hard cap. */
export const MANAGED_SITE_RELEASE_LIMITS = {
    maxFiles: 120_000,
    maxTreeBytes: 512 * 1024 * 1024,
    maxDepth: 64,
} as const;
export const MANAGED_SITE_BUILD_TIMEOUT_MS = 5 * 60 * 1000;
/** Runtime guard for writes to the release filesystem while the install runs. */
export const MANAGED_SITE_BUILD_MONITOR_MS = 250;
/** Free space kept beyond the release cap: preflight, monitor overshoot, metadata. */
const FREE_SPACE_HEADROOM = 256 * 1024 * 1024;

const COMPOSER_JSON_MAX_BYTES = 256 * 1024;
const COMPOSER_LOCK_MAX_BYTES = 32 * 1024 * 1024;
const BUILD_OUTPUT_MAX_BYTES = 256 * 1024;
const VALIDATE_OUTPUT_MAX_BYTES = 64 * 1024;
const VALIDATE_TIMEOUT_MS = 60_000;
const CLEANUP_TIMEOUT_MS = 30_000;
/** On shutdown the panel's 30 s grace must cover the whole cleanup. */
const CLEANUP_TIMEOUT_ON_ABORT_MS = 4_000;
const CONTAINER_PREFIX = "compose-panel-build-";
const VALIDATE_PREFIX = "compose-panel-check-";

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
    /** Test seam: how often the tree size is checked while installing. */
    monitorIntervalMs?: number;
    /** Test seam: the release cap enforced during the install. */
    maxTreeBytes?: number;
    /** Test seam: the file-count cap enforced during the install. */
    maxFiles?: number;
}

export type ComposerBuildResult =
    | { ok: true; image: string }
    | {
          ok: false;
          reason: string;
          /** A container may still exist: the caller must keep the attempt. */
          unconfirmed: boolean;
      };

/**
 * Run `composer install` for one staged release. Every refusal before the
 * install happens without a container; a failure always tries to remove both
 * containers and reports whether that removal is proven.
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
    for (const entry of MANAGED_SITE_RESERVED_TREE_ENTRIES) {
        if (await lstatOrNull(join(request.tree, entry))) {
            return fail(`The repository contains ${entry}, which the panel reserves.`);
        }
    }
    // The build starts from source only: a committed vendor/ could carry
    // metadata from another install (CVE-2026-59944) and would not be verified.
    if (await lstatOrNull(join(request.tree, "vendor"))) {
        return fail("The repository must not commit vendor/; Composer installs it in the disposable container.");
    }

    let composerJson;
    try {
        composerJson = await readFileSafe(join(request.tree, "composer.json"), COMPOSER_JSON_MAX_BYTES);
    } catch (error) {
        if (error instanceof FileSafetyError) return fail(`composer.json cannot be used: ${error.message}`);
        throw error;
    }
    if (!composerJson) return fail("The release has no composer.json, so Composer cannot be prepared.");
    const composerPlatform = declaredPhpPlatform(composerJson.source);
    if (composerPlatform === "invalid") return fail("composer.json is not a usable JSON object.");
    if (composerPlatform === "missing") {
        return fail(
            `composer.json must declare config.platform.php as "${request.phpMinor}.x" so the committed lock file is resolved and verified for the site's PHP channel.`,
        );
    }
    if (composerPlatform !== request.phpMinor) {
        return fail(
            `composer.json declares config.platform.php for PHP ${composerPlatform}, but the site runs PHP ${request.phpMinor}. Nothing was prepared.`,
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
    // `composer install` verifies the lock against the lock's own
    // `platform-overrides`, not against composer.json. An absent or different
    // value would silently verify the wrong PHP version.
    const lockPlatform = lockPlatformOverride(lock.source);
    if (lockPlatform === "invalid") return fail("composer.lock is not a usable JSON object.");
    if (lockPlatform === "missing") {
        return fail(
            `composer.lock has no platform-overrides.php. Regenerate it with config.platform.php "${request.phpMinor}.x" so install verifies the site's PHP channel.`,
        );
    }
    if (lockPlatform !== request.phpMinor) {
        return fail(
            `composer.lock pins platform-overrides.php to PHP ${lockPlatform}, but the site runs PHP ${request.phpMinor}. Regenerate the lock for this channel.`,
        );
    }

    // The container writes into the staging tree, so the release filesystem is
    // the one that must hold the bounded result (with room for the monitor's
    // overshoot window and the release metadata).
    const maxTreeBytes = request.maxTreeBytes ?? MANAGED_SITE_RELEASE_LIMITS.maxTreeBytes;
    const maxFiles = request.maxFiles ?? MANAGED_SITE_RELEASE_LIMITS.maxFiles;
    const free = await statfs(request.tree)
        .then((stats) => stats.bavail * stats.bsize)
        .catch(() => null);
    if (free !== null && free < maxTreeBytes + FREE_SPACE_HEADROOM) {
        return fail("The release filesystem does not have enough free space for a bounded Composer build.");
    }

    const runner: BuildRunner = request.runner ?? ((args, options) => runCommand("docker", args, options));
    const timeoutMs = request.timeoutMs ?? MANAGED_SITE_BUILD_TIMEOUT_MS;
    const cleanupTimeout = () => (request.signal?.aborted ? CLEANUP_TIMEOUT_ON_ABORT_MS : CLEANUP_TIMEOUT_MS);
    const uid = treeInfo.uid;
    const gid = treeInfo.gid;

    // ---- lock freshness and composer.json schema, offline ----
    const validateName = `${VALIDATE_PREFIX}${request.attemptId}-${randomSuffix()}`;
    const validation = await runDisposable(runner, validateName, validateArguments(request.tree, uid, gid, validateName), {
        timeoutMs: Math.min(VALIDATE_TIMEOUT_MS, timeoutMs),
        maxBytes: VALIDATE_OUTPUT_MAX_BYTES,
        ...(request.signal ? { signal: request.signal } : {}),
        cleanupTimeout,
    });
    if (!validation.removed) {
        return fail("The lock-file check container could not be confirmed removed; the site needs inspection.", true);
    }
    if (request.signal?.aborted) return fail("The Composer build was cancelled; its container was removed and nothing was published.");
    if (validation.result.timedOut) return fail("The lock-file check timed out; its container was removed and nothing was published.");
    if (validation.result.truncated || validation.result.terminationUnconfirmed) {
        return fail("The lock-file check did not finish cleanly; nothing was published.");
    }
    if (validation.result.code !== 0) {
        return fail("composer.lock is missing, stale or inconsistent with composer.json. Run composer update and commit the lock.");
    }

    // ---- bounded install ----
    const name = `${CONTAINER_PREFIX}${request.attemptId}-${randomSuffix()}`;
    const install = new AbortController();
    const forwardAbort = () => install.abort();
    request.signal?.addEventListener("abort", forwardAbort, { once: true });
    if (request.signal?.aborted) forwardAbort();
    let exceeded = false;
    const monitor = startSizeMonitor(
        request.tree,
        maxTreeBytes,
        maxFiles,
        () => {
            exceeded = true;
            install.abort();
        },
        request.monitorIntervalMs ?? MANAGED_SITE_BUILD_MONITOR_MS,
    );
    let result: CommandResult;
    try {
        result = await runner(installArguments(request.tree, uid, gid, name, timeoutMs), {
            timeoutMs,
            maxBytes: BUILD_OUTPUT_MAX_BYTES,
            onChunk: request.onOutput,
            signal: install.signal,
            stopOnOutputLimit: true,
        });
    } catch {
        result = { code: -1, stdout: "", stderr: "", timedOut: false, truncated: false };
    } finally {
        monitor.stop();
        request.signal?.removeEventListener("abort", forwardAbort);
    }

    const removed = await removeContainer(runner, name, cleanupTimeout());
    if (!removed) {
        return fail("The preparation container could not be confirmed removed; the site needs inspection.", true);
    }
    if (exceeded) {
        return fail("The build exceeded the release size cap; its container was removed and nothing was published.");
    }
    if (request.signal?.aborted) return fail("The Composer build was cancelled; its container was removed and nothing was published.");
    if (result.timedOut) return fail("The Composer build timed out; its container was removed and nothing was published.");
    if (result.truncated)
        return fail("Composer produced more output than the pilot allows; its container was removed and nothing was published.");
    if (result.terminationUnconfirmed) {
        return fail("The Composer command could not be confirmed to have exited; its container was removed and nothing was published.");
    }
    if (result.code !== 0) return fail("Composer could not install the locked dependencies in the disposable container.");

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

interface DisposableOptions {
    timeoutMs: number;
    maxBytes: number;
    onChunk?: (chunk: string) => void;
    signal?: AbortSignal;
    /** Evaluated after the run, so a shutdown during it shortens the budget. */
    cleanupTimeout: () => number;
}

/** Run one fixed container, then prove its name is gone from `docker ps -a`. */
async function runDisposable(
    runner: BuildRunner,
    name: string,
    args: string[],
    options: DisposableOptions,
): Promise<{ result: CommandResult; removed: boolean }> {
    let result: CommandResult;
    try {
        result = await runner(args, {
            timeoutMs: options.timeoutMs,
            maxBytes: options.maxBytes,
            ...(options.onChunk ? { onChunk: options.onChunk } : {}),
            ...(options.signal ? { signal: options.signal } : {}),
            ...(options.onChunk ? { stopOnOutputLimit: true } : {}),
        });
    } catch {
        result = { code: -1, stdout: "", stderr: "", timedOut: false, truncated: false };
    }
    const removed = await removeContainer(runner, name, options.cleanupTimeout());
    return { result, removed };
}

function validateArguments(tree: string, uid: number, gid: number, name: string): string[] {
    return [
        "run",
        "--rm",
        "--init",
        "--name",
        name,
        // No registry access is needed to check a local lock file.
        "--network",
        "none",
        "--user",
        `${uid}:${gid}`,
        "--read-only",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=128m",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "128",
        "--memory",
        "256m",
        "--memory-swap",
        "256m",
        "--cpus",
        "0.5",
        "--stop-timeout",
        "10",
        "-e",
        "COMPOSER_HOME=/tmp/composer-home",
        "-e",
        "COMPOSER_CACHE_DIR=/tmp/composer-cache",
        "-e",
        "COMPOSER_NO_INTERACTION=1",
        "-e",
        "COMPOSER_DISABLE_XDEBUG_WARN=1",
        "-v",
        `${tree}:/src:ro`,
        "-w",
        "/src",
        MANAGED_SITE_BUILD_IMAGE,
        "--no-plugins",
        "--no-interaction",
        "validate",
        "--no-check-publish",
        "--no-check-all",
        "--no-ansi",
    ];
}

function installArguments(tree: string, uid: number, gid: number, name: string, timeoutMs: number): string[] {
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
        "/tmp:rw,noexec,nosuid,size=128m",
        // Home and cache are bounded in memory and never touch the release
        // filesystem. Only vendor/ is written to the staging tree.
        "--tmpfs",
        "/composer:rw,noexec,nosuid,nodev,size=256m,mode=1777",
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
        "COMPOSER_HOME=/composer/home",
        "-e",
        "COMPOSER_CACHE_DIR=/composer/cache",
        "-e",
        "COMPOSER_NO_INTERACTION=1",
        "-e",
        "COMPOSER_BIN_COMPAT=proxy",
        "-e",
        "COMPOSER_DISABLE_XDEBUG_WARN=1",
        "-e",
        `COMPOSER_PROCESS_TIMEOUT=${processTimeout}`,
        "-v",
        `${tree}:/src`,
        "-w",
        "/src",
        MANAGED_SITE_BUILD_IMAGE,
        "--no-plugins",
        "--no-interaction",
        "install",
        "--no-dev",
        "--no-progress",
        "--prefer-dist",
        "--no-scripts",
        "--no-ansi",
    ];
}

/** `docker rm -f` then prove the name is absent from `docker ps -a`. */
async function removeContainer(runner: BuildRunner, name: string, timeoutMs: number): Promise<boolean> {
    const removed = await runner(["rm", "-f", name], { timeoutMs, maxBytes: 16 * 1024 }).catch(() => null);
    if (!removed || removed.terminationUnconfirmed) return false;
    const listed = await runner(["ps", "-a", "--filter", `name=^${name}$`, "--format", "{{.Names}}"], {
        timeoutMs,
        maxBytes: 16 * 1024,
    }).catch(() => null);
    if (!listed || listed.terminationUnconfirmed || listed.truncated || listed.code !== 0) return false;
    return listed.stdout.trim() === "";
}

/** `config.platform.php` as a major.minor, `missing`, or `invalid`. */
function declaredPhpPlatform(source: string): string | "missing" | "invalid" {
    const config = jsonObject(source)?.config;
    if (config === undefined) return "missing";
    if (!isJsonObject(config)) return "invalid";
    const platform = config.platform;
    if (platform === undefined) return "missing";
    if (!isJsonObject(platform)) return "invalid";
    return phpMinor(platform.php);
}

/** The lock's `platform-overrides.php`, which is what `composer install` uses. */
function lockPlatformOverride(source: string): string | "missing" | "invalid" {
    const overrides = jsonObject(source)?.["platform-overrides"];
    if (overrides === undefined) return "missing";
    if (!isJsonObject(overrides)) return "invalid";
    return phpMinor(overrides.php);
}

function phpMinor(value: unknown): string | "missing" | "invalid" {
    if (value === undefined) return "missing";
    if (typeof value !== "string") return "invalid";
    const match = /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(value);
    return match ? `${match[1]}.${match[2]}` : "invalid";
}

function jsonObject(source: string): Record<string, unknown> | null {
    let value: unknown;
    try {
        value = JSON.parse(source);
    } catch {
        return null;
    }
    return isJsonObject(value) ? value : null;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function lstatOrNull(path: string) {
    try {
        return await lstat(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
    }
}

function isCanonicalAbsolute(value: string): boolean {
    if (value.length === 0 || value.includes("\0")) return false;
    if (!/^(?:\/|[A-Za-z]:[\\/])/.test(value)) return false;
    if (value.length > 1 && /[\\/]$/.test(value)) return false;
    return !value.includes("/../") && !value.includes("\\..\\");
}

/**
 * Poll the staging tree while the install runs. The tmpfs cache is already
 * bounded; this guard stops a runaway vendor/ before it can fill the release
 * filesystem or its inode table. A short interval bounds the overshoot, and the
 * post-build inspection still enforces the exact cap.
 */
function startSizeMonitor(
    root: string,
    maxBytes: number,
    maxFiles: number,
    onExceed: () => void,
    intervalMs: number,
): { stop: () => void } {
    let stopped = false;
    let running = false;
    const check = async () => {
        if (stopped || running) return;
        running = true;
        try {
            if (await treeExceeds(root, maxBytes, maxFiles)) {
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

/** Whether the tree is over its byte or file cap; stops as soon as it is. */
async function treeExceeds(root: string, maxBytes: number, maxFiles: number): Promise<boolean> {
    let total = 0;
    let files = 0;
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
            files += 1;
            total += info.size;
            if (total > maxBytes || files > maxFiles) return true;
        }
        visited++;
        if (visited > 20_000) return false;
    }
    return false;
}
