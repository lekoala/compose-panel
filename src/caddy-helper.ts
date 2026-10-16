/**
 * Privileged Caddy helper core (ADR 0030, PR2).
 *
 * Runs on the host (not in the panel container) as the `caddy` user, activated
 * on demand through a systemd socket. It owns exactly one directory of
 * per-domain files (e.g. `/etc/caddy/compose-panel.d/`) and only ever writes
 * files it generated itself. The main `Caddyfile` is never edited.
 *
 * This module holds the policy (validation, locking, the safe
 * prepare → validate → publish → reload sequence, honest rollback). It takes
 * an injected Caddy runner so tests exercise every branch without touching a
 * real Caddy. The stdio entry point lives in `src/scripts/caddy-helper.ts`.
 */

import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, readFile, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { runCommand, type CommandResult } from "./docker.ts";
import {
    buildSiteFile,
    isValidDomain,
    isValidServiceName,
    isValidStackName,
    isValidUpstreamPort,
    normalizeDomain,
    parseSiteFile,
    type CaddySiteRequest,
} from "./caddy.ts";

export type HelperCode = "invalid" | "conflict" | "unavailable" | "failed" | "unknown";

export type HelperRequest =
    | { action: "status" }
    | { action: "attach"; domain: string; stack: string; service: string; port: number }
    | { action: "detach"; domain: string; stack: string };

export type HelperResponse =
    | { ok: true; action: "status"; sites: CaddySiteRequest[]; unparseable: string[]; importConfigured: boolean }
    | { ok: true; action: "attach"; unchanged: boolean }
    | { ok: true; action: "detach" }
    | { ok: false; error: string; code: HelperCode };

export interface HelperEnv {
    /** The only directory the helper ever writes. Fixed host-side. */
    managedDir: string;
    /** Main Caddyfile, read to verify the required import. Never written. */
    mainConfig: string;
    /** Caddy executable. Fixed host-side, never from the request. */
    caddyBin: string;
    /** Per-command timeout for `caddy` subprocesses. */
    commandTimeoutMs: number;
    /** Output cap for `caddy` subprocesses (except adapt, see below). */
    maxOutputBytes: number;
}

export interface HelperDeps {
    /** Fixed-argument Caddy runner (default: real subprocess, no shell). */
    runCaddy: (args: string[], options?: { maxBytes?: number }) => Promise<CommandResult>;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    /** Lock timings, overridable in tests (defaults below). */
    lockOptions?: { staleMs?: number; waitMs?: number };
}

const MAX_MAIN_CONFIG_BYTES = 1024 * 1024;
const MAX_SITE_FILE_BYTES = 8 * 1024;
const MAX_SITES_LISTED = 1024;
/** `caddy adapt` output cap: the whole host config as JSON can be large. */
const ADAPT_MAX_BYTES = 4 * 1024 * 1024;
/** Exclusive lock directory inside the managed dir (external writers such as
 * a deployment script can take the same lock with an `mkdir` of this path,
 * and should write their PID into `<lock>/owner` the same way). */
const LOCK_NAME = ".lock";
const OWNER_NAME = "owner";
/** A lock whose holder is gone is reclaimed; a live holder is never stolen,
 * however long validation and reloads take. */
const LOCK_STALE_MS = 30_000;
/** How long to wait for a lock held by another writer. */
const LOCK_WAIT_MS = 30_000;
/** Worst-case `caddy` subprocesses of one attach: adapt (prevalidation),
 * validate, adapt (route check), reload, rollback reload. */
const MAX_CADDY_COMMANDS = 5;
/** Slack on top of the summed budget for file operations and startup. */
const DEADLINE_MARGIN_MS = 15_000;

/**
 * Overall deadline of one helper request. Derived from the configured
 * per-command timeout so the hard stop can never fire before a rollback
 * reload has had its full time: lock wait + every subprocess at its timeout
 * + a margin (135 s with the defaults). The panel's call timeout should be
 * at least this long; a shorter one is reported as an unknown outcome.
 */
export function helperDeadlineMs(env: HelperEnv): number {
    return LOCK_WAIT_MS + MAX_CADDY_COMMANDS * env.commandTimeoutMs + DEADLINE_MARGIN_MS;
}

export class HelperConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "HelperConfigError";
    }
}

class HelperBusyError extends Error {
    constructor() {
        super("Another Caddy change is in progress. Wait a moment, then try again.");
        this.name = "HelperBusyError";
    }
}

/**
 * Read helper configuration from its own environment (set by the systemd
 * unit, never by the panel request). Refused values fail the helper loudly
 * instead of running against the wrong directory.
 */
export function parseHelperEnv(env: Record<string, string | undefined>): HelperEnv {
    const managedDir = (env.CADDY_MANAGED_DIR ?? "").trim();
    const mainConfig = (env.CADDY_MAIN_CONFIG ?? "").trim();
    const caddyBin = (env.CADDY_BIN ?? "caddy").trim();
    if (!managedDir || !isAbsolute(managedDir)) {
        throw new HelperConfigError("CADDY_MANAGED_DIR must be an absolute path to the managed directory.");
    }
    if (!mainConfig || !isAbsolute(mainConfig)) {
        throw new HelperConfigError("CADDY_MAIN_CONFIG must be an absolute path to the main Caddyfile.");
    }
    if (!caddyBin || /[\x00-\x1f\x7f]/.test(caddyBin)) throw new HelperConfigError("CADDY_BIN must be a usable executable reference.");
    const commandTimeoutMs = env.CADDY_COMMAND_TIMEOUT_MS ? Number(env.CADDY_COMMAND_TIMEOUT_MS) : 15_000;
    if (!Number.isInteger(commandTimeoutMs) || commandTimeoutMs <= 0) {
        throw new HelperConfigError("CADDY_COMMAND_TIMEOUT_MS must be a positive integer.");
    }
    return { managedDir, mainConfig, caddyBin, commandTimeoutMs, maxOutputBytes: 256 * 1024 };
}

/** Production Caddy runner: fixed binary, explicit argument arrays, no shell. */
export function createCaddyRunner(env: HelperEnv): HelperDeps["runCaddy"] {
    return (args: string[], options?: { maxBytes?: number }) => runCommand(env.caddyBin, args, {
        timeoutMs: env.commandTimeoutMs,
        maxBytes: options?.maxBytes ?? env.maxOutputBytes,
    });
}

function refused(error: string, code: HelperCode): HelperResponse {
    return { ok: false, error, code };
}

function sitePath(managedDir: string, domain: string): string {
    return join(managedDir, `${domain}.caddy`);
}

async function assertManagedDirUsable(managedDir: string): Promise<void> {
    const info = await lstat(managedDir).catch(() => null);
    if (!info) {
        // Created once by the install step with the right owner; recreated
        // here only when absent so a fresh host keeps working.
        await mkdir(managedDir, { recursive: true, mode: 0o755 });
        const created = await lstat(managedDir).catch(() => null);
        if (!created || created.isSymbolicLink() || !created.isDirectory()) {
            throw new HelperConfigError("CADDY_MANAGED_DIR must be a directory, not a symlink or file.");
        }
        return;
    }
    // A symlinked managed directory would redirect every write (O_NOFOLLOW on
    // the final file does not protect parent components), so refuse it
    // instead of following it.
    if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new HelperConfigError("CADDY_MANAGED_DIR must be a directory, not a symlink or file.");
    }
}

/**
 * Exclusive, process-safe lock for the whole prepare → reload sequence, so
 * two concurrent writers (panel stacks, or the panel and an external
 * deployment) cannot interleave a publish and a reload. Implemented with an
 * atomic `mkdir`, which needs no extra dependency and works over the same
 * path for external writers.
 *
 * A lock is only ever reclaimed when its holder is provably gone: the holder
 * records `pid:token` in `<lock>/owner`, and a contender steals the lock
 * only when that PID no longer exists (or when an ownerless directory is
 * older than the stale timeout, covering a holder that crashed between the
 * `mkdir` and the owner write). Reclamation itself is exclusive behind a
 * short-lived `.lock.reclaim` directory: the winner re-reads the lock while
 * holding it, so two contenders that both observed the same dead owner cannot
 * both delete — the loser re-reads a live owner and waits. A live holder is
 * waited on, never stolen, so long validations and reloads cannot cause two
 * overlapping mutations — and the release only removes a lock still owned by
 * this holder, never another writer's.
 *
 * External writers using the documented `mkdir` + `owner` protocol get the
 * same guarantee only when they use the same reclaim discipline; otherwise
 * coordination with them stays best-effort. The managed directory is checked
 * before waiting and again once the lock is held, so a directory swapped for
 * a symlink is refused instead of followed (point-in-time checks against a
 * privileged local writer racing `rename` itself, like backups).
 */
async function withHelperLock<T>(managedDir: string, deps: HelperDeps, fn: () => Promise<T>): Promise<T> {
    await assertManagedDirUsable(managedDir);
    const lockPath = join(managedDir, LOCK_NAME);
    const reclaimPath = `${lockPath}.reclaim`;
    const ownerPath = join(lockPath, OWNER_NAME);
    const now = deps.now ?? Date.now;
    const sleep = deps.sleep ?? Bun.sleep;
    const staleMs = deps.lockOptions?.staleMs ?? LOCK_STALE_MS;
    const waitMs = deps.lockOptions?.waitMs ?? LOCK_WAIT_MS;
    const token = `${process.pid}:${crypto.randomUUID()}`;
    const deadline = now() + waitMs;
    for (;;) {
        let created = false;
        try {
            await mkdir(lockPath);
            created = true;
        } catch (error) {
            // Only an existing lock means "wait". Anything else (read-only
            // directory, no space) would otherwise spin until the deadline
            // and be misreported as a busy lock.
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
                throw new HelperConfigError("The lock cannot be created in the managed directory.");
            }
        }
        if (created) {
            try {
                await writeFile(ownerPath, token, { flag: "wx", mode: 0o644 });
                break;
            } catch (error) {
                await rmdir(lockPath).catch(() => {});
                throw error;
            }
        }
        const info = await lstat(lockPath).catch(() => null);
        if (!info) {
            // Released between our mkdir and lstat: retry, without spinning.
            if (now() >= deadline) throw new HelperBusyError();
            await sleep(10);
            continue;
        }
        if (!info.isDirectory()) throw new HelperBusyError();
        const owner = await readFile(ownerPath, "utf8").catch(() => null);
        if (owner !== null && isOwnerAlive(owner)) {
            if (now() >= deadline) throw new HelperBusyError();
            await sleep(100);
            continue;
        }
        if (owner === null && now() - info.mtimeMs <= staleMs) {
            if (now() >= deadline) throw new HelperBusyError();
            await sleep(100);
            continue;
        }
        // Stale candidate. Reclaim exclusively: only one contender may delete
        // the dead lock. The winner re-reads the owner while holding the
        // reclaim directory; the loser sees a fresh live owner and waits.
        let reclaimHeld = false;
        try {
            try {
                await mkdir(reclaimPath);
                reclaimHeld = true;
            } catch {
                const reclaimInfo = await lstat(reclaimPath).catch(() => null);
                if (reclaimInfo && !reclaimInfo.isDirectory()) {
                    await rm(reclaimPath, { recursive: true, force: true }).catch(() => {});
                } else if (reclaimInfo && now() - reclaimInfo.mtimeMs > staleMs) {
                    // A reclaimer that crashed mid-reclaim must not block
                    // forever; its section is milliseconds, so expiry by age
                    // only ever fires for a dead holder.
                    await rm(reclaimPath, { recursive: true, force: true }).catch(() => {});
                }
                if (now() >= deadline) throw new HelperBusyError();
                await sleep(100);
                continue;
            }
            const freshInfo = await lstat(lockPath).catch(() => null);
            if (!freshInfo) continue;
            if (!freshInfo.isDirectory()) throw new HelperBusyError();
            const freshOwner = await readFile(ownerPath, "utf8").catch(() => null);
            if (freshOwner !== null && isOwnerAlive(freshOwner)) continue;
            if (freshOwner === null && now() - freshInfo.mtimeMs <= staleMs) continue;
            await rm(lockPath, { recursive: true, force: true }).catch(() => {});
        } finally {
            if (reclaimHeld) await rm(reclaimPath, { recursive: true, force: true }).catch(() => {});
        }
    }
    // The directory could have been swapped while waiting for the lock.
    try {
        await assertManagedDirUsable(managedDir);
        return await fn();
    } finally {
        // Only remove our own lock: a contender that stole it meanwhile (our
        // holder could only have been stolen when dead, so this is purely
        // defensive) keeps its directory.
        const owner = await readFile(ownerPath, "utf8").catch(() => null);
        if (owner === token) await rm(lockPath, { recursive: true, force: true }).catch(() => {});
    }
}

/** Whether the `pid:token` owner recorded in a lock directory still runs. */
function isOwnerAlive(owner: string): boolean {
    const pid = Number(owner.split(":")[0]);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        // ESRCH: no such process. Anything else (EPERM and the like) means a
        // process exists that we may not signal: treat it as alive.
        return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
}

/** Read a site file only when it is a regular file, never via a symlink. */
async function readSiteFile(path: string): Promise<string | null> {
    const info = await lstat(path).catch(() => null);
    if (!info) return null;
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SITE_FILE_BYTES) {
        throw new Error("unreadable");
    }
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
        return await handle.readFile("utf8");
    } finally {
        await handle.close();
    }
}

/**
 * Remove a published candidate. Returns true when the path is absent
 * afterwards. A failed `unlink` that leaves the file behind must not be
 * reported as "nothing was applied": the next reload would load it.
 */
async function removePublishedFile(path: string): Promise<boolean> {
    try {
        await unlink(path);
        return true;
    } catch {
        return (await lstat(path).catch(() => null)) === null;
    }
}

/**
 * Restore a detached file without overwriting: `link` fails when a file
 * appeared at the path meanwhile (an external writer ignoring the lock).
 * Returns true only when the file is back at its path.
 */
async function restoreDetachedFile(backup: string, path: string): Promise<boolean> {
    try {
        await link(backup, path);
    } catch {
        return false;
    }
    await unlink(backup).catch(() => {});
    return true;
}

/** Sibling name for a temporary or backup file. Never ends with `.caddy`, so
 * the `*.caddy` import does not load it, and random so a stale file left by a
 * crashed helper with a reused PID never collides. */
function siblingPath(path: string, kind: "tmp" | "detached"): string {
    return `${path}.${kind}.${crypto.randomUUID()}`;
}

/**
 * Atomic, no-clobber publish: exclusive temp file in the same directory, then
 * `link` to the final name. Unlike `rename`, `link` refuses an existing path,
 * so a file created concurrently by another writer is never overwritten.
 * Returns false when the path already exists (nothing published).
 */
async function publishSiteFile(path: string, content: string): Promise<boolean> {
    const temp = siblingPath(path, "tmp");
    const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o644);
    try {
        await handle.writeFile(content, "utf8");
    } catch (error) {
        await handle.close();
        await unlink(temp).catch(() => {});
        throw error;
    }
    await handle.close();
    try {
        await link(temp, path);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw error;
    } finally {
        await unlink(temp).catch(() => {});
    }
}

/**
 * Whether the main Caddyfile imports the managed directory. `caddy validate`
 * alone cannot prove this (an import glob matching nothing is not an error),
 * so the text is checked explicitly before anything is published.
 */
export function importConfiguredIn(mainSource: string, managedDir: string): boolean {
    // Caddyfiles use forward slashes even on Windows; `join` does not.
    const slash = (value: string): string => value.replace(/\\/g, "/");
    // Only `*.caddy`: a broader glob such as `*` would also load the
    // temporary and detached backup files kept next to the managed files,
    // so a detach would reload with the site still served.
    const wanted = [slash(join(managedDir, "*.caddy"))];
    for (const rawLine of mainSource.split("\n")) {
        const line = rawLine.split("#")[0]!.trim().replace(/\s+/g, " ");
        const match = /^import\s+(.+)$/.exec(line);
        if (!match) continue;
        const target = slash(match[1]!.trim().replace(/^["']|["']$/g, ""));
        if (wanted.includes(target)) return true;
    }
    return false;
}

/**
 * Every host matcher value in an adapted JSON configuration, lowercased.
 * Returns null when the output is not JSON: an unreadable configuration is
 * never read as "no such host".
 */
function adaptedHosts(adaptedJson: string): Set<string> | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(adaptedJson);
    } catch {
        return null;
    }
    const hosts = new Set<string>();
    const stack: unknown[] = [parsed];
    while (stack.length > 0) {
        const value = stack.pop();
        if (Array.isArray(value)) {
            stack.push(...value);
        } else if (typeof value === "object" && value !== null) {
            for (const [key, child] of Object.entries(value)) {
                if (key === "host" && Array.isArray(child)) {
                    for (const host of child) if (typeof host === "string") hosts.add(host.toLowerCase());
                } else {
                    stack.push(child);
                }
            }
        }
    }
    return hosts;
}

/** Whether the adapted JSON configuration contains a route for the domain. */
export function adaptContainsDomain(adaptedJson: string, domain: string): boolean {
    return adaptedHosts(adaptedJson)?.has(domain.toLowerCase()) ?? false;
}

/**
 * Whether the adapted configuration already routes the domain, either
 * exactly or through a single-level wildcard (`*.example.com`), so that a
 * domain served by another configuration (the main `Caddyfile`, another
 * deployment tool's import) is refused instead of shadowed. Null when the
 * output cannot be read: uniqueness is then unproven.
 */
export function adaptDeclaresDomain(adaptedJson: string, domain: string): boolean | null {
    const hosts = adaptedHosts(adaptedJson);
    if (hosts === null) return null;
    const lower = domain.toLowerCase();
    const parent = lower.slice(lower.indexOf(".") + 1);
    return hosts.has(lower) || hosts.has(`*.${parent}`);
}

async function readMainConfig(mainConfig: string): Promise<string | null> {
    const info = await lstat(mainConfig).catch(() => null);
    if (!info || !info.isFile() || info.size > MAX_MAIN_CONFIG_BYTES) return null;
    return readFile(mainConfig, "utf8").catch(() => null);
}

interface CaddyRun {
    code: number;
    stdout: string;
    timedOut: boolean;
}

async function validateConfig(runCaddy: HelperDeps["runCaddy"], mainConfig: string): Promise<CaddyRun> {
    const result = await runCaddy(["validate", "--config", mainConfig, "--adapter", "caddyfile"]);
    return { code: result.code, stdout: result.stdout, timedOut: result.timedOut };
}

async function reloadConfig(runCaddy: HelperDeps["runCaddy"], mainConfig: string): Promise<CaddyRun> {
    const result = await runCaddy(["reload", "--config", mainConfig, "--adapter", "caddyfile"]);
    return { code: result.code, stdout: result.stdout, timedOut: result.timedOut };
}

async function handleStatus(env: HelperEnv): Promise<HelperResponse> {
    try {
        await assertManagedDirUsable(env.managedDir);
    } catch {
        return { ok: true, action: "status", sites: [], unparseable: [], importConfigured: false };
    }
    const sites: CaddySiteRequest[] = [];
    const unparseable: string[] = [];
    const entries = await readdir(env.managedDir).catch(() => [] as string[]);
    for (const entry of entries) {
        if (!entry.endsWith(".caddy") || entry.startsWith(".") || sites.length + unparseable.length >= MAX_SITES_LISTED) continue;
        let source: string | null = null;
        try {
            source = await readSiteFile(join(env.managedDir, entry));
        } catch {
            if (unparseable.length < MAX_SITES_LISTED) unparseable.push(entry);
            continue;
        }
        if (source === null) continue;
        const parsed = parseSiteFile(source);
        // A managed block whose domain differs from its file name was renamed
        // outside the panel: listing it would offer a detach that cannot work.
        if (parsed.ok && `${parsed.value.domain}.caddy` === entry) sites.push(parsed.value);
        else if (unparseable.length < MAX_SITES_LISTED) unparseable.push(entry);
    }
    const main = await readMainConfig(env.mainConfig);
    return {
        ok: true,
        action: "status",
        sites: sites.sort((a, b) => a.domain.localeCompare(b.domain)),
        unparseable: unparseable.sort(),
        importConfigured: main !== null && importConfiguredIn(main, env.managedDir),
    };
}

interface AttachInputs {
    domain: string;
    stack: string;
    service: string;
    port: number;
}

function validateAttachInputs(raw: Record<string, unknown>): AttachInputs | HelperResponse {
    const { domain, stack, service, port } = raw as Record<string, unknown>;
    const normalized = typeof domain === "string" ? normalizeDomain(domain) : null;
    if (!normalized || !isValidDomain(normalized)) {
        return refused("This domain is not valid. Use a public domain.", "invalid");
    }
    if (typeof stack !== "string" || !isValidStackName(stack)) return refused("This stack name is not valid.", "invalid");
    if (typeof service !== "string" || !isValidServiceName(service)) return refused("This service name is not valid.", "invalid");
    if (typeof port !== "number" || !isValidUpstreamPort(port)) return refused("This upstream port is not valid.", "invalid");
    return { domain: normalized, stack, service, port };
}

async function handleAttach(env: HelperEnv, deps: HelperDeps, raw: Record<string, unknown>): Promise<HelperResponse> {
    const inputs = validateAttachInputs(raw);
    if (!("domain" in inputs)) return inputs;
    const { runCaddy } = deps;
    const candidate = buildSiteFile(inputs);
    const path = sitePath(env.managedDir, inputs.domain);
    try {
        return await withHelperLock(env.managedDir, deps, async () => {
            const existing = await readSiteFile(path).catch(() => "unreadable" as const);
            if (existing === "unreadable") {
                return refused("The existing file cannot be managed safely. Inspect it on the host.", "conflict");
            }
            if (existing !== null) {
                const parsed = parseSiteFile(existing);
                if (!parsed.ok || parsed.value.domain !== inputs.domain) {
                    return refused("This domain already exists but is not managed by the panel. It will not be overwritten.", "conflict");
                }
                if (parsed.value.stack !== inputs.stack || parsed.value.service !== inputs.service || parsed.value.port !== inputs.port) {
                    return refused("This domain is already attached. Detach it first to change the mapping.", "conflict");
                }
                return { ok: true, action: "attach", unchanged: true };
            }
            const main = await readMainConfig(env.mainConfig);
            if (main === null || !importConfiguredIn(main, env.managedDir)) {
                return refused(
                    "Caddy integration is not configured. Add the required import directive to your Caddyfile and reload Caddy before attaching domains.",
                    "unavailable",
                );
            }
            // Prevalidation, before anything is published: the current
            // configuration must adapt, and must not already route this
            // domain from elsewhere (the main Caddyfile, another tool's
            // import). A candidate is only ever published into a
            // configuration it cannot shadow or break by duplication.
            const current = await runCaddy(["adapt", "--config", env.mainConfig, "--adapter", "caddyfile"], { maxBytes: ADAPT_MAX_BYTES });
            const declared = current.code !== 0 || current.timedOut || current.truncated ? null : adaptDeclaresDomain(current.stdout, inputs.domain);
            if (declared === null) {
                return refused("The current Caddy configuration could not be read, so the domain cannot be proven unused. Nothing was applied.", "failed");
            }
            if (declared) {
                return refused("This domain is already served by another part of the Caddy configuration. It will not be attached here.", "conflict");
            }
            if (!(await publishSiteFile(path, candidate))) {
                return refused("A file for this domain appeared meanwhile. It will not be overwritten.", "conflict");
            }
            const valid = await validateConfig(runCaddy, env.mainConfig);
            if (valid.code !== 0 || valid.timedOut) {
                if (!(await removePublishedFile(path))) {
                    return refused("Caddy rejected the configuration and the unpublished file could not be removed. Check Caddy on the host: the outcome is unknown.", "unknown");
                }
                return refused("Caddy rejected the configuration. Nothing was applied.", "failed");
            }
            const adapt = await runCaddy(["adapt", "--config", env.mainConfig, "--adapter", "caddyfile"], { maxBytes: ADAPT_MAX_BYTES });
            if (adapt.code !== 0 || adapt.timedOut || adapt.truncated || !adaptContainsDomain(adapt.stdout, inputs.domain)) {
                if (!(await removePublishedFile(path))) {
                    return refused("The domain is missing from the Caddy configuration and the unpublished file could not be removed. Check Caddy on the host: the outcome is unknown.", "unknown");
                }
                return refused("The domain is missing from the Caddy configuration. The import may not be effective. Nothing was applied.", "failed");
            }
            const reloaded = await reloadConfig(runCaddy, env.mainConfig);
            if (reloaded.code === 0 && !reloaded.timedOut) return { ok: true, action: "attach", unchanged: false };
            // Roll back to the previous state (no file) and reload that. The
            // restored state may only be claimed when the file is actually
            // gone; otherwise the next reload would still load the candidate.
            if (!(await removePublishedFile(path))) {
                return refused("Caddy did not reload and the unpublished file could not be removed. Check Caddy on the host: the outcome is unknown.", "unknown");
            }
            const restored = await reloadConfig(runCaddy, env.mainConfig);
            if (restored.code === 0 && !restored.timedOut) {
                return refused("Caddy did not reload. The previous configuration was restored.", "failed");
            }
            return refused("Caddy did not reload and the rollback could not be confirmed. Check Caddy on the host: the outcome is unknown.", "unknown");
        });
    } catch (error) {
        if (error instanceof HelperBusyError) return refused(error.message, "conflict");
        if (error instanceof HelperConfigError) return refused("The managed directory is not usable. Check the helper configuration on the host: nothing was changed.", "unavailable");
        throw error;
    }
}

async function handleDetach(env: HelperEnv, deps: HelperDeps, raw: Record<string, unknown>): Promise<HelperResponse> {
    const domain = typeof raw.domain === "string" ? normalizeDomain(raw.domain) : null;
    const stack = raw.stack;
    if (!domain || !isValidDomain(domain)) return refused("This domain is not valid.", "invalid");
    if (typeof stack !== "string" || !isValidStackName(stack)) return refused("This stack name is not valid.", "invalid");
    const { runCaddy } = deps;
    const path = sitePath(env.managedDir, domain);
    try {
        return await withHelperLock(env.managedDir, deps, async () => {
            const existing = await readSiteFile(path).catch(() => "unreadable" as const);
            if (existing === null) return refused("This domain is not attached.", "conflict");
            if (existing === "unreadable") {
                return refused("The existing file cannot be managed safely. Inspect it on the host.", "conflict");
            }
            const parsed = parseSiteFile(existing);
            if (!parsed.ok || parsed.value.domain !== domain) {
                return refused("This domain is not managed by the panel. It will not be removed.", "conflict");
            }
            if (parsed.value.stack !== stack) {
                return refused("This domain belongs to another stack. It will not be removed.", "conflict");
            }
            const backup = siblingPath(path, "detached");
            try {
                await rename(path, backup);
            } catch {
                return refused("The domain could not be detached. Nothing was changed.", "failed");
            }
            const reloaded = await reloadConfig(runCaddy, env.mainConfig);
            if (reloaded.code === 0 && !reloaded.timedOut) {
                await unlink(backup).catch(() => {});
                return { ok: true, action: "detach" };
            }
            // Restore the file and reload the restored configuration. The
            // restored state may only be claimed when the restore actually
            // succeeded: otherwise the file is still absent while the running
            // configuration still serves it.
            if (!(await restoreDetachedFile(backup, path))) {
                return refused("Caddy did not reload and the previous configuration could not be restored. Check Caddy on the host: the outcome is unknown.", "unknown");
            }
            const restored = await reloadConfig(runCaddy, env.mainConfig);
            if (restored.code === 0 && !restored.timedOut) {
                return refused("Caddy did not reload. The previous configuration was restored.", "failed");
            }
            return refused("Caddy did not reload and the rollback could not be confirmed. Check Caddy on the host: the outcome is unknown.", "unknown");
        });
    } catch (error) {
        if (error instanceof HelperBusyError) return refused(error.message, "conflict");
        if (error instanceof HelperConfigError) return refused("The managed directory is not usable. Check the helper configuration on the host: nothing was changed.", "unavailable");
        throw error;
    }
}

/** Dispatch one parsed request. Unknown shapes are refused, never executed. */
export async function runHelperRequest(raw: unknown, env: HelperEnv, deps: HelperDeps): Promise<HelperResponse> {
    const request = (typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : null);
    if (!request || typeof request.action !== "string") return refused("Unknown helper action.", "invalid");
    switch (request.action) {
        case "status": return handleStatus(env);
        case "attach": return handleAttach(env, deps, request);
        case "detach": return handleDetach(env, deps, request);
        default: return refused("Unknown helper action.", "invalid");
    }
}
