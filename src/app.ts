import {
    escapeHtml,
    documentHtml,
    editPage,
    healthSummaryBadge,
    htmlResponse,
    loginPage,
    logsPanel,
    messagePage,
    note,
    operationControls,
    operationPanel,
    servicesSection,
    stateBadge,
    auditPage,
    accessPage,
    aboutPage,
    otherContainersSection,
    containersPage,
    containerDetailPage,
    deploymentSection,
    createStackPage,
    newSitePage,
    newSitePreviewPage,
    managedByBadge,
    toolboxPage,
    databaseSection,
    domainsSection,
    rolloutPage,
    type RolloutReadinessView,
    type AttachedDomain,
    type PublishedUpstream,
    type NavSection,
    type NavigationOptions,
    type NoteKind,
    type ToolboxSourceView,
    type NewSiteDraft,
} from "./html.ts";
import { serverLiveView, serverPage } from "./features/server/views.ts";
import { SelfUpdateError, SelfUpdater, isImageId } from "./self-update.ts";
import { managedBy } from "./deployment.ts";
import { createStack, StackCreationPartialError, type CreateStackRequest } from "./create-stack.ts";
import { lstat, unlink } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { listStacks, locateComposeFile, readStackCompose, StackError, validateStackName } from "./stacks.ts";
import {
    loadProjects,
    loadStackDetail,
    loadStackStates,
    resolveProjectContext,
    type ProjectContext,
    type StackDetailStatus,
} from "./status.ts";
import { loadContainerDetail, loadContainers } from "./container-status.ts";
import { parseContainerFilter, type ContainerFilter } from "./container-state.ts";
import { createContainerInspector, isContainerId, sanitizeTailLines, type ContainerInspector } from "./containers.ts";
import { createContainerMutator, type ContainerMutator } from "./container-mutations.ts";
import { createActionRunner, type ActionRunner } from "./action-runner.ts";
import {
    checkRolloutEligibility,
    parseRolloutDeclaration,
    parseRolloutInspect,
    type RolloutDeclaration,
    type RolloutInspect,
} from "./rollout.ts";
import { runRollout, type RolloutDependencies, type RolloutPreparation } from "./rollout-run.ts";
import { parseImageInspect, parseComposePs, summarizeServices } from "./compose-state.ts";
import { actionArgv, buildCatalog, isActionName, parseToolboxSources, type ToolboxAction, type ToolboxSource } from "./toolbox.ts";
import { buildExplorerUrl, parseDatabaseExplorer } from "./database.ts";
import {
    buildSiteFile,
    isValidDomain,
    isValidServiceName,
    isValidStackName,
    isValidUpstreamPort,
    matchesGeneratedUpstream,
    normalizeDomain,
    splitHostBinding,
} from "./caddy.ts";
import { CaddyHelperError, callCaddyHelper } from "./caddy-client.ts";
import { parseContainerInspect, parseContainerLs, type ContainerPort } from "./container-state.ts";
import { createDiskUsageCache, loadInsights } from "./insights.ts";
import { StackConflictError, StackPartialError, StackValidationError, readEditableStack, saveEditableStack } from "./editor.ts";
import { OperationManager, OperationsDisabledError, isOperationAction, type AppActionOutcome, type OperationView } from "./operations.ts";
import {
    ImageCheckBusyError,
    ImageCheckDisabledError,
    ImageCheckManager,
    ImageCheckRefusedError,
    summarizeCheck,
    type ImageCheckView,
} from "./image-check.ts";
import { HostMaintenance, MaintenanceDisabledError } from "./host-maintenance.ts";
import { isMaintenanceScope } from "./maintenance.ts";
import { MaintenanceBusyError, StackBusyError, StackLocks } from "./locks.ts";
import { listBackups, pruneBackups } from "./backups.ts";
import { anchorDir, FileSafetyError, randomSuffix, readFileSafe, writeFileAtomic } from "./fs-safe.ts";
import { LogManager, stripAnsi } from "./logs.ts";
import { AuditLog, AuditError } from "./audit.ts";
import { formatSseEvent, formatSseHeartbeat, sseHeaders } from "./sse.ts";
import { createComposeProvider, COMPOSE_LOG_TAIL_OPTIONS, isComposeServiceName, type ComposeProvider } from "./compose-provider.ts";
import {
    isManagedSiteAttemptId,
    MANAGED_SITE_CHANNELS,
    MANAGED_SITE_MANIFEST_FILE,
    MANAGED_SITE_MANIFEST_MAX_BYTES,
    MANAGED_SITE_PATHS,
    parseManagedSiteManifest,
    type ManagedSiteDatabaseEngine,
    type ManagedSiteManifest,
    type ManagedSiteManifestResult,
} from "./managed-site.ts";
import {
    buildManagedSite,
    generatedGatewayPort,
    parseManagedSiteDraft,
    renderManagedSiteArtifacts,
    MANAGED_SITE_GATEWAY_CONFIG,
    MANAGED_SITE_OPCACHE_CONFIG,
    type ManagedSiteDraft,
} from "./managed-site-generate.ts";
import { createManagedSite, findManagedSitePortOwner, ManagedSiteCreationPartialError } from "./create-managed-site.ts";
import { publishManagedSiteBaseline } from "./managed-site-baseline.ts";
import { checkManagedSiteProfile } from "./managed-site-profile.ts";
import { checkManagedSiteDatabaseEnvFile } from "./managed-site-database.ts";
import {
    checkManagedSiteBackupCredentials,
    readManagedSiteBackupAttempt,
    removeManagedSiteBackupAttempt,
    type ManagedSiteBackupAttemptRead,
    type ManagedSiteBackupCheck,
} from "./managed-site-backup.ts";
import { runManagedSiteBackup } from "./managed-site-backup-run.ts";
import { isManagedSiteSnapshotId, runManagedSiteRestore } from "./managed-site-restore.ts";
import { composerPreparation, MANAGED_SITE_RELEASE_LIMITS } from "./managed-site-build.ts";
import { fetchAndPublishGitRelease } from "./git-release.ts";
import {
    managedSiteAttemptPath,
    pendingDeployAttempt,
    readBaseline,
    readPendingDeployAttempt,
    runManagedSiteDeploy,
    type ManagedSiteDeployResult,
    type PendingDeployAttemptRead,
} from "./managed-site-deploy.ts";
import { createManagedSiteProbe } from "./managed-site-probe.ts";
import { buildAccessReport, type Access } from "./access.ts";
import type { DockerRunner } from "./docker.ts";
import {
    CSRF_COOKIE,
    SESSION_COOKIE,
    LoginRateLimiter,
    SessionStore,
    type Session,
    clearedSessionCookie,
    csrfCookie,
    parseCookies,
    randomToken,
    safeEqual,
    sessionCookie,
    verifyPassword,
} from "./auth.ts";
import type { AppConfig } from "./config.ts";

const BASE_HEADERS: Record<string, string> = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "X-Frame-Options": "DENY",
};

/** Brand assets served unauthenticated (login page included). Fixed map, no user input. */
const BRAND_FILES: Record<string, { file: string; type: string }> = {
    "/favicon.svg": { file: "favicon.svg", type: "image/svg+xml; charset=utf-8" },
    // Not linked from pages; browsers still request it on their own.
    "/favicon.ico": { file: "favicon.ico", type: "image/x-icon" },
    "/brand-mark.svg": { file: "brand-mark.svg", type: "image/svg+xml; charset=utf-8" },
    "/apple-touch-icon.png": { file: "apple-touch-icon.png", type: "image/png" },
    "/icon-active-on-light.svg": { file: "icon-active-on-light.svg", type: "image/svg+xml; charset=utf-8" },
    "/icon-active-on-dark.svg": { file: "icon-active-on-dark.svg", type: "image/svg+xml; charset=utf-8" },
    "/icon-boot-on-light.svg": { file: "icon-boot-on-light.svg", type: "image/svg+xml; charset=utf-8" },
    "/icon-boot-on-dark.svg": { file: "icon-boot-on-dark.svg", type: "image/svg+xml; charset=utf-8" },
};

const unavailableRunner: DockerRunner = async () => ({ code: -1, stdout: "", stderr: "", timedOut: false, truncated: false });

export interface AppOptions {
    config: AppConfig;
    /** Absolute, canonical stacks directory resolved at startup. */
    stacksRoot: string;
    /** Docker runner. Defaults to an unavailable stub so callers opt in explicitly. */
    runner?: DockerRunner;
    /** Pre-built Compose provider. Built from `runner` when omitted. */
    provider?: ComposeProvider;
    /** Read-only Docker container inspector. Built from `runner` when omitted. */
    inspector?: ContainerInspector;
    /** Application toolbox Docker adapter (ADR 0026). Built from `runner` when omitted. */
    actionRunner?: ActionRunner;
    /** Narrow container mutation boundary for the opt-in rollout (ADR 0035). */
    containerMutator?: ContainerMutator;
    /** Test seam for the one-shot backup adapter (ADR 0049); production uses the fixed runner. */
    backupDocker?: DockerRunner;
    /** Test seam for the verify/restore adapter (ADR 0049). */
    restoreDocker?: DockerRunner;
    /** Test seam for the private backup credential metadata check. */
    backupCheckCredentials?: (stackDir: string, manifest: ManagedSiteManifest) => Promise<ManagedSiteBackupCheck>;
    /** Per-stack modifying-operation lock. */
    locks?: StackLocks;
    /** Activity log. Built from `config` and `stacksRoot` when omitted. */
    audit?: AuditLog;
    /** Panel self-update (ADR 0018). Built from `runner` when omitted. */
    selfUpdater?: SelfUpdater;
}

export interface App {
    fetch(request: Request): Promise<Response>;
    operations: OperationManager;
    images: ImageCheckManager;
    logs: LogManager;
    maintenance: HostMaintenance;
    sseSubscriptions(): number;
    beginShutdown(graceMs: number): Promise<void>;
}

interface SaveDraft {
    composeSource: string;
    envSource: string;
    baseComposeHash: string;
    baseEnvHash: string;
    baseEnvExists: boolean;
}

function plain(body: string, status: number): Response {
    return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...BASE_HEADERS } });
}

function methodNotAllowed(allow: string): Response {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: allow, ...BASE_HEADERS } });
}

/**
 * A HEAD answer carries the GET status and headers, without a body. Used for
 * the plain-text/JSON data endpoints so a HEAD probe never receives a payload.
 */
function withoutBody(response: Response): Response {
    return new Response(null, { status: response.status, headers: response.headers });
}

function redirect(location: string, status: number): Response {
    return new Response(null, { status, headers: { Location: location, ...BASE_HEADERS } });
}

/** Bounded body reader: returns null when the payload exceeds the configured limit. */
async function readTextLimited(request: Request, maxBytes: number): Promise<string | null> {
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > maxBytes) return null;
    const body = request.body;
    if (!body) return "";
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxBytes) {
            await reader.cancel();
            return null;
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
}

/** Floor for attach/detach helper calls: the helper deadline with its default
 * per-command timeout (135 s, see `helperDeadlineMs`) plus slack. */
const CADDY_MUTATION_MIN_TIMEOUT_MS = 150_000;

type PublishedPortsRead =
    | { kind: "no-answer" }
    | { kind: "bad-answer" }
    | { kind: "ok"; running: number; inspected: number; ports: { service: string; binding: ContainerPort }[] };

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]", "::1"] as const;

/**
 * The access point a request arrived on, resolved from its Host header. This
 * decides which origin, cookie attribute and X-Forwarded-* trust apply. It is
 * NOT proof that the request came through the reverse proxy: Caddy and an SSH
 * tunnel both reach the loopback listener, and a local client can present a
 * proxy-origin Host. See ADR 0012 for the trusted-local assumption behind it.
 */
function requestHost(request: Request): string | null {
    // In production Bun always supplies the Host header (HTTP/1.1, or the
    // :authority pseudo-header for HTTP/2, from which `request.url` is built),
    // so the URL fallback only matters for synthetic requests and resolves to
    // the server's own authority. On the hard-coded loopback listener that is
    // the loopback path: the correct classification for a direct connection.
    // A missing Host therefore cannot be smuggled into a proxy access point.
    const raw = request.headers.get("host") ?? new URL(request.url).host;
    return raw ? raw.toLowerCase() : null;
}

function resolveAccess(request: Request, config: AppConfig): Access | null {
    const host = requestHost(request);
    if (!host) return null;
    // The loopback path is implicit when no proxy origin is configured;
    // otherwise it must be opted in, so unexpected Hosts stay refused.
    // A bare loopback name without `:PORT` is tolerated (some clients send
    // `Host: localhost`): on the hard-coded loopback listener it can only be
    // a direct connection, never a proxy access point.
    if (config.proxyOrigins.length === 0 || config.allowLoopback) {
        for (const name of LOOPBACK_HOSTS) {
            if (host === name || host === `${name}:${config.port}`) return { kind: "loopback" };
        }
    }
    for (const origin of config.proxyOrigins) {
        if (new URL(origin).host.toLowerCase() === host) return { kind: "proxy", origin };
    }
    return null;
}

/** Per-request memo so Host/origin/cookie resolution runs once. */
const accessCache = new WeakMap<Request, Access | null>();
function accessOf(request: Request, config: AppConfig): Access | null {
    if (accessCache.has(request)) return accessCache.get(request) ?? null;
    const access = resolveAccess(request, config);
    accessCache.set(request, access);
    return access;
}

/** The origin of the request as the client used it, ignoring forwarded headers. */
function directRequestOrigin(request: Request): string | null {
    const host = request.headers.get("host") ?? new URL(request.url).host;
    if (!host) return null;
    return `${new URL(request.url).protocol.replace(":", "")}://${host}`;
}

/**
 * The origin a state-changing request must present for the access point it
 * arrived on: the configured proxy origin exactly, or the loopback origin the
 * client used. A request that mixes the two paths (proxy Host with loopback
 * Origin, or the reverse) is refused.
 */
function expectedOrigin(request: Request, access: Access): string | null {
    if (access.kind === "proxy") return access.origin;
    return directRequestOrigin(request);
}

/** Cookie `Secure` for this request: the proxy origin's scheme decides, otherwise the direct default. */
function cookieSecureFor(request: Request, config: AppConfig): boolean {
    const access = accessOf(request, config);
    if (access?.kind === "proxy") return access.origin.startsWith("https:");
    return config.cookieSecure;
}

const ENV_NOT_REGULAR = "This stack's .env is a symbolic link or not a regular file. For safety, the panel will not run Docker with it.";

const ERROR_TITLES: Record<number, string> = {
    400: "Request refused",
    404: "Not found",
    409: "Nothing was done",
    503: "Temporarily unavailable",
};

const ORIGIN_BLOCKED_MESSAGE =
    "Sign-in was blocked because the request did not come from this panel's own page. Open the panel address directly in a browser tab: embedding the panel in another page or app is not allowed.";

/** Strict same-origin check for state-changing requests. Fails closed. */
function isAllowedOrigin(request: Request, config: AppConfig): boolean {
    const access = accessOf(request, config);
    if (!access) return false;
    const expected = expectedOrigin(request, access);
    if (!expected) return false;
    let candidate: string | null = request.headers.get("origin");
    if (!candidate) {
        const referer = request.headers.get("referer");
        if (referer) {
            try {
                candidate = new URL(referer).origin;
            } catch {
                candidate = null;
            }
        }
    }
    if (candidate === expected) return true;
    // A sandboxed frame / opaque context sends the literal `Origin: null` (or no
    // Origin at all). Rejected by default: the panel must not be driven from an
    // embedded context. The opt-in COMPOSE_PANEL_ALLOW_OPAQUE_ORIGIN relaxes this
    // for local testing only, and only when Fetch Metadata confirms the request
    // is same-origin/none (a cross-site frame is still refused).
    if (config.allowOpaqueOrigin && (candidate === "null" || candidate === null)) {
        const site = request.headers.get("sec-fetch-site");
        return site === "same-origin" || site === "none" || site === null;
    }
    return false;
}

/** The session was revoked or expired while a mutation was being prepared. */
class SessionEndedError extends Error {}

/**
 * Accept only the loopback authorities (on the configured port, when the
 * loopback path is enabled) and the configured proxy origins. This rejects an
 * unexpected Host before routing, which protects against DNS rebinding and
 * proxy misrouting.
 */
function isAllowedHost(request: Request, config: AppConfig): boolean {
    return accessOf(request, config) !== null;
}

function clientKey(request: Request, config: AppConfig): string {
    // X-Forwarded-For is trusted only on a proxy access point. Elsewhere it is
    // client-controlled and ignored, so it cannot forge the throttle key or the
    // audit actor.
    if (accessOf(request, config)?.kind === "proxy") {
        // The last entry is the one our own proxy appended. Earlier entries
        // come from the client and can be forged, which would let an attacker
        // dodge the throttle or put someone else's address in the audit log.
        const forwarded = request.headers.get("x-forwarded-for");
        const last = forwarded
            ?.split(",")
            .map((part) => part.trim())
            .filter(Boolean)
            .pop();
        if (last) return last;
    }
    return "direct";
}

/**
 * The stack memory total echoed by the page only sizes a decorative bar: the
 * refresh deliberately avoids `docker info`, so the server cannot read it. A
 * strict bounded integer, never used for a decision.
 */
function parseMemoryTotalParam(value: string | null): number | null {
    if (!value || !/^[1-9][0-9]{0,14}$/.test(value)) return null;
    const total = Number(value);
    return Number.isSafeInteger(total) ? total : null;
}

export function createApp(options: AppOptions): App {
    const { config, stacksRoot, locks = new StackLocks() } = options;
    const provider =
        options.provider ?? createComposeProvider({ runner: options.runner ?? unavailableRunner, engine: config.composeEngine });
    const inspector =
        options.inspector ?? createContainerInspector({ runner: options.runner ?? unavailableRunner, engine: config.composeEngine });
    const actionRunner =
        options.actionRunner ?? createActionRunner({ runner: options.runner ?? unavailableRunner, engine: config.composeEngine });
    const containerMutator =
        options.containerMutator ?? createContainerMutator({ runner: options.runner ?? unavailableRunner, engine: config.composeEngine });
    const audit =
        options.audit ??
        new AuditLog({
            dir: config.audit.dir ?? join(stacksRoot, ".compose-panel", "audit"),
            // The default layout is checked from the stacks root down, so a
            // symlinked .compose-panel cannot redirect the log.
            root: config.audit.dir ? undefined : stacksRoot,
            enabled: config.audit.enabled,
            rotation: config.audit.rotation,
            retainFiles: config.audit.retainFiles,
            maxReadLines: config.audit.maxReadLines,
            maxFileBytes: config.audit.maxFileBytes,
        });
    const imageCheck = new ImageCheckManager(provider, {
        // The outcome is recorded when the check ends, even if nobody watches it.
        // Counts only: raw registry output and digests stay out of the log.
        onFinish: (view) => {
            const summary = summarizeCheck(view);
            const detail = view.discarded
                ? "the stack changed while the check ran"
                : [
                      `${summary.compared} compared`,
                      `${summary.updates} update available`,
                      `${summary.unknown} unknown`,
                      `${summary.untracked} not tracked`,
                  ].join(", ");
            void audit.record({ event: "image-check", result: view.discarded ? "discarded" : "success", stack: view.stack, detail });
        },
    });
    const operations = new OperationManager(locks, provider, {
        timeoutMs: config.operationTimeoutMs,
        maxBytes: config.dockerMaxBytes,
        // A mutation starts and ends with a possibly different engine-wide
        // image store: a verdict recorded before it cannot describe any stack
        // afterwards (a tag can be shared, ADR 0041).
        onBegin: () => imageCheck.imagesChanged(),
        // Authoritative pending-deploy, drift, baseline and domain check, under
        // the lock. The route-level check cannot see a marker or a domain that
        // appears while the request awaits Docker.
        admit: async (stack, action) => {
            if (!config.managedSitesEnabled) return null;
            try {
                const stackDir = await managedSiteStackDir(stack);
                // A pending deploy blocks everything, including a backup.
                if (await pendingDeployAttempt(stackDir)) return MANAGED_SITE_PENDING_MESSAGE;
                if (action === "backup") return await managedBackupAdmission(stackDir);
                if (action === "restore") return await managedRestoreAdmission(stackDir);
                const drift = await managedSiteDriftReason(stackDir);
                if (drift) return drift;
                if (action === "down") return await managedDownDomainAdmission(stack);
                if (action === "rollout") return await managedDatabaseAdmission(stack, action);
                if (["up", "pull-up", "start", "restart"].includes(action)) {
                    const baseline = await managedBaselineAdmission(stack);
                    if (baseline) return baseline;
                    return await managedDatabaseAdmission(stack, action);
                }
                return null;
            } catch {
                return "The pending deploy, generated-file and domain state of this stack could not be checked, so nothing was run.";
            }
        },
        // The outcome is recorded when the action ends, even if nobody watches it.
        onFinish: (operation) => {
            imageCheck.imagesChanged();
            void audit.record({
                event: operation.source
                    ? "toolbox"
                    : operation.action === "rollout"
                      ? "rollout"
                      : operation.action === "deploy" || operation.action === "baseline"
                        ? "deploy"
                        : operation.action === "backup" || operation.action === "restore"
                          ? "backup"
                          : "operation",
                result: operation.status,
                stack: operation.stack,
                action: operation.action,
                service: operation.service,
                // Identity of what actually ran, for an app action; never the output
                // (log lines may carry secrets). Exit code and timeout stay explicit.
                detail:
                    [
                        operation.source ? `source ${operation.source}` : "",
                        operation.containerId ? `container ${operation.containerId}` : "",
                        operation.imageId ? `image ${operation.imageId}` : "",
                        operation.revision ? `revision ${operation.revision}` : "",
                        operation.exitCode !== null ? `exit code ${operation.exitCode}` : "",
                        operation.timedOut ? "timed out" : "",
                    ]
                        .filter(Boolean)
                        .join(", ") || undefined,
            });
        },
    });
    const logs = new LogManager(provider, {
        tailLines: config.logTailLines,
        maxBytes: config.logMaxBytes,
        timeoutMs: config.logTimeoutMs,
    });
    // `docker system df` is expensive, so it is read on demand and cached (ADR 0015).
    const diskCache = createDiskUsageCache();
    // Docker storage maintenance (ADR 0040). One run at a time, holding the
    // engine against every stack mutation. The outcome is recorded when the
    // command ends, even if nobody watches it; the cached disk usage is dropped
    // so the next read shows the new numbers.
    const maintenance = new HostMaintenance(locks, options.runner ?? unavailableRunner, {
        timeoutMs: config.maintenanceTimeoutMs,
        maxBytes: config.dockerMaxBytes,
        onFinish: (view) => {
            diskCache.clear();
            void recordAudit({
                event: "maintenance",
                result: view.status,
                action: view.scope,
                detail:
                    [
                        view.reclaimedBytes !== null ? `reclaimed ${view.reclaimedBytes} bytes` : "",
                        view.exitCode !== null ? `exit code ${view.exitCode}` : "",
                        view.timedOut ? "timed out" : "",
                        view.truncated ? "output truncated" : "",
                    ]
                        .filter(Boolean)
                        .join(", ") || undefined,
            });
        },
    });
    const selfUpdater =
        options.selfUpdater ??
        new SelfUpdater({
            runner: options.runner ?? unavailableRunner,
            provider,
            pullTimeoutMs: config.operationTimeoutMs,
            maxBytes: config.dockerMaxBytes,
        });
    // Set from the moment an update is accepted until its updater ends (or
    // this process is replaced): no action, save or purge may start meanwhile.
    let selfUpdatePending = false;
    let selfUpdateChecking = false;
    const SELF_UPDATE_RUNNING = "Compose Panel is updating itself. Wait for it to restart, then try again.";
    let activeSse = 0;
    let shuttingDown = false;
    // SIGTERM/SIGINT must reach the long-running Git fetch and Composer build,
    // not only the operation drain: otherwise the panel can exit while a
    // container keeps installing. Aborting first lets each operation stop and
    // prove its cleanup inside the shutdown grace.
    const shutdownController = new AbortController();
    const saves = new Set<Promise<unknown>>();
    const sessions = new SessionStore(config.sessionTtlMs, config.sessionIdleMs);
    // Open streams are bound to their session id so logout or expiry can close
    // them; otherwise a revoked session would keep receiving streamed output.
    const sessionStreams = new Map<string, Set<() => void>>();
    function registerStream(id: string, close: () => void): void {
        let set = sessionStreams.get(id);
        if (!set) {
            set = new Set();
            sessionStreams.set(id, set);
        }
        set.add(close);
    }
    function unregisterStream(id: string, close: () => void): void {
        const set = sessionStreams.get(id);
        if (!set) return;
        set.delete(close);
        if (set.size === 0) sessionStreams.delete(id);
    }
    function closeSessionStreams(id: string): void {
        const set = sessionStreams.get(id);
        if (!set) return;
        sessionStreams.delete(id);
        for (const close of [...set]) {
            try {
                close();
            } catch {
                /* a broken stream must not block logout */
            }
        }
    }
    const limiter = new LoginRateLimiter(
        config.loginRateLimit.maxAttempts,
        config.loginRateLimit.windowMs,
        config.loginRateLimit.backoffMaxMs,
    );

    function sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    /** Best-effort activity record. `record` never throws, so awaiting is safe. */
    function recordAudit(event: Parameters<AuditLog["record"]>[0]): Promise<void> {
        return audit.record(event);
    }

    /** Sign-in refusals and failures: anyone can trigger them, so they are rate-capped in the log. */
    function recordLoginNoise(event: Parameters<AuditLog["record"]>[0]): Promise<void> {
        return audit.record(event, { noisy: true });
    }

    // Shared page options: sign-out form and how the panel is reached.
    const loopbackEnabled = config.proxyOrigins.length === 0 || config.allowLoopback;
    const access = [
        ...config.proxyOrigins.map((origin) => `${new URL(origin).host} (proxy)`),
        loopbackEnabled ? `127.0.0.1:${config.port} (loopback)` : "",
    ]
        .filter(Boolean)
        .join(", ");
    function pageChrome(csrf: string | undefined): { logoutCsrf?: string; access: string; timezone?: string } {
        return { logoutCsrf: csrf, access, timezone: config.timeZone || undefined };
    }

    /**
     * Navigation data for the current page: section links plus the stack
     * switcher. Names only, one filesystem read, no Docker call. If the stacks
     * folder cannot be listed, the sidebar still shows the sections.
     */
    async function sidebarNav(section: NavSection, stack?: string): Promise<NavigationOptions> {
        let stacks: string[] = [];
        try {
            stacks = (await listStacks(stacksRoot)).map((entry) => entry.name);
        } catch {
            /* navigation stays usable without the stack list */
        }
        return { stacks, section, stack };
    }

    function sessionEnded(): Response {
        return htmlResponse(
            messagePage(
                "Signed out",
                "Your session has ended (signed out, timed out, or the panel restarted), so nothing was done. Sign in again, then retry.",
                { href: "/login", label: "Sign in" },
                { bare: true },
            ),
            401,
        );
    }

    async function readForm(request: Request, maxBytes = config.maxBodyBytes): Promise<URLSearchParams | null> {
        const text = await readTextLimited(request, maxBytes);
        if (text === null) return null;
        return new URLSearchParams(text);
    }

    function routeError(error: unknown, csrf?: string, stack?: string): Response {
        const status = error instanceof StackError ? error.status : 500;
        if (!(error instanceof StackError)) console.error("Internal error", error);
        const message =
            error instanceof StackError ? error.message : "An unexpected error occurred. Details were written to the server log.";
        const back =
            stack !== undefined && status !== 404
                ? { href: `/stacks/${encodeURIComponent(stack)}`, label: `← Back to ${stack}` }
                : { href: "/", label: "← Back to all stacks" };
        return htmlResponse(messagePage(ERROR_TITLES[status] ?? "Something went wrong", message, back, { ...pageChrome(csrf) }), status);
    }

    /** A form post the panel refused before doing anything (stale page, foreign origin). */
    function staleForm(csrf: string, back = "/"): Response {
        return htmlResponse(
            messagePage(
                "Nothing was done",
                "This page is out of date, for example because you signed in again in another tab. Go back, reload the page and try again.",
                { href: back, label: "← Go back" },
                { ...pageChrome(csrf) },
            ),
            403,
        );
    }

    function tooLarge(csrf: string, back: string): Response {
        return htmlResponse(
            messagePage(
                "Nothing was saved",
                `The submitted content is larger than the ${Math.floor(config.maxEditBytes / 1024)} KiB limit.`,
                { href: back, label: "← Go back" },
                { ...pageChrome(csrf) },
            ),
            413,
        );
    }

    function loginFailure(request: Request, message: string | null, status: number, retryAfterSec?: number): Response {
        const nonce = randomToken();
        const response = htmlResponse(loginPage({ csrf: nonce, error: message }), status);
        response.headers.append("Set-Cookie", csrfCookie(nonce, cookieSecureFor(request, config)));
        if (retryAfterSec !== undefined) response.headers.set("Retry-After", String(retryAfterSec));
        return response;
    }

    async function handleLoginGet(request: Request): Promise<Response> {
        const cookies = parseCookies(request.headers.get("cookie"));
        const id = cookies[SESSION_COOKIE];
        if (id && sessions.get(id)) return redirect("/", 302);
        const nonce = randomToken();
        const blocked = new URL(request.url).searchParams.get("e") === "blocked";
        const response = htmlResponse(loginPage({ csrf: nonce, error: blocked ? ORIGIN_BLOCKED_MESSAGE : null }));
        response.headers.append("Set-Cookie", csrfCookie(nonce, cookieSecureFor(request, config)));
        return response;
    }

    async function handleLoginPost(request: Request): Promise<Response> {
        // A blocked Origin (mismatch, or the opaque `null` of an embedded/
        // sandboxed context) is refused, but as a soft POST→GET redirect to the
        // login page with an explanation instead of a bare 403.
        if (!isAllowedOrigin(request, config)) {
            // Name both sides so a misconfigured origin is diagnosable from the log.
            const received = request.headers.get("origin") ?? (request.headers.get("referer") ? "referer only" : "none");
            const access = accessOf(request, config);
            const expected = (access ? expectedOrigin(request, access) : null) ?? "unknown";
            await recordLoginNoise({
                event: "login",
                result: "refused",
                actor: clientKey(request, config),
                detail: `origin blocked: received ${received}, expected ${expected}`,
            });
            return redirect("/login?e=blocked", 303);
        }
        const form = await readForm(request);
        if (form === null) return plain("Payload too large", 413);

        const cookies = parseCookies(request.headers.get("cookie"));
        const cookieToken = cookies[CSRF_COOKIE] ?? "";
        const formToken = form.get("csrf") ?? "";
        if (!cookieToken || !formToken || !safeEqual(cookieToken, formToken)) {
            await recordLoginNoise({ event: "login", result: "refused", actor: clientKey(request, config), detail: "stale form" });
            return loginFailure(request, "The sign-in form expired. Please sign in again.", 403);
        }

        const key = clientKey(request, config);
        // Reserve the attempt synchronously, before any awaited password work,
        // so a burst of concurrent requests cannot all pass the limit before the
        // first failure is recorded. A per-key over-limit attempt is not refused
        // (that would let an attacker lock out the real admin); it is delayed.
        // Only a parallel attempt from the same key is refused, so a source
        // cannot bypass its own delay. The reservation is settled below.
        const verdict = limiter.tryReserve(key);
        if (!verdict.allowed && verdict.reason === "capacity") {
            await recordLoginNoise({ event: "login", result: "refused", actor: key, detail: "too many sources tracked" });
            return loginFailure(
                request,
                "The panel is busy with sign-in attempts from many addresses. Try again later.",
                429,
                verdict.retryAfterSec,
            );
        }
        if (!verdict.allowed) {
            await recordLoginNoise({ event: "login", result: "refused", actor: key, detail: "parallel attempt" });
            return loginFailure(
                request,
                "Another sign-in attempt from your address is still being checked. Try again in a moment.",
                429,
                verdict.retryAfterSec,
            );
        }

        const user = form.get("user") ?? "";
        const password = form.get("password") ?? "";
        let success = false;
        let slotHeld = false;
        try {
            // Wait before taking a global verification slot, so delayed attempts
            // never hold one of the scarce slots while sleeping.
            if (verdict.delayMs > 0) await sleep(verdict.delayMs);
            slotHeld = limiter.acquireSlot();
            if (!slotHeld) {
                await recordLoginNoise({ event: "login", result: "refused", actor: key, detail: "verification capacity reached" });
                return loginFailure(request, "The panel is busy with other sign-in attempts. Try again in a moment.", 429, 1);
            }
            // Verify unconditionally to keep the response time independent of the username.
            const passwordOk = await verifyPassword(config.adminPasswordHash, password);
            success = passwordOk && user === config.adminUser;
            if (!success) {
                // Never log the typed username itself: people regularly type
                // their password into that field by mistake.
                await recordLoginNoise({
                    event: "login",
                    result: "failure",
                    actor: key,
                    username: user === config.adminUser ? "admin account" : "unknown user",
                    detail: verdict.delayMs > 0 ? "over limit, delayed" : undefined,
                });
                return loginFailure(request, "Wrong username or password.", 401);
            }
            await recordAudit({ event: "login", result: "success", actor: key });

            const session = sessions.create(config.adminUser);
            const response = redirect("/", 303);
            response.headers.append(
                "Set-Cookie",
                sessionCookie(session.id, { secure: cookieSecureFor(request, config), maxAgeSec: Math.floor(config.sessionTtlMs / 1000) }),
            );
            return response;
        } finally {
            limiter.settle(key, success, slotHeld);
        }
    }

    async function renderStackList(csrf: string): Promise<Response> {
        // One `compose ls` shared by the stacks table and the container
        // classification, so the home page makes a single discovery call.
        const discovery = await loadProjects(provider);
        const { stacks, dockerNote } = await loadStackStates(stacksRoot, provider, discovery);
        const intro = `<p class="lead">Stacks in <code>${escapeHtml(stacksRoot)}</code></p>`;
        let content: string;
        if (stacks.length === 0) {
            content =
                `<section class="card empty"><h2>No stacks found</h2>` +
                `<p><a href="/new-stack">Create a stack</a>, or add a folder in <code>${escapeHtml(stacksRoot)}</code> with a <code>compose.yaml</code> and reload this page.</p>` +
                `<p class="muted">Folder names may use lowercase letters, digits, <code>-</code> and <code>_</code>.</p>` +
                `<p class="muted">The panel never takes ownership of your stacks: the Compose files stay where they are, and every stack can still be managed with the <code>docker compose</code> CLI.</p></section>`;
        } else {
            const counts = new Map<string, number>();
            for (const stack of stacks) counts.set(stack.state, (counts.get(stack.state) ?? 0) + 1);
            // One tile per state present, in a fixed order; colors match the badges.
            const tiles = (
                [
                    ["running", "Running"],
                    ["stopped", "Stopped"],
                    ["not-created", "Not deployed"],
                    ["unknown", "Unknown"],
                ] as const
            )
                .filter(([state]) => counts.has(state))
                .map(
                    ([state, label]) =>
                        `<div class="stat stat-${state}"><span class="stat-value">${counts.get(state)}</span><span class="stat-label">${label}</span></div>`,
                )
                .join("");
            const rows = stacks
                .map((stack) => {
                    const href = `/stacks/${encodeURIComponent(stack.name)}`;
                    // The Docker-wide note is shown once above the table, not on every row.
                    const rowNote = stack.note && stack.note !== dockerNote ? `<div class="hint">${escapeHtml(stack.note)}</div>` : "";
                    return (
                        `<tr><td><a href="${href}" class="stack-name">${escapeHtml(stack.name)}</a>${rowNote}</td>` +
                        `<td>${stateBadge(stack.state)}</td>` +
                        `<td class="col-optional">${stack.project ? escapeHtml(stack.project) : `<span class="muted">—</span>`}</td>` +
                        `<td class="col-optional"><code>${escapeHtml(stack.composeFile)}</code></td></tr>`
                    );
                })
                .join("");
            content =
                `<div class="stats" aria-label="Stacks by status">${tiles}</div>` +
                `<div class="table-wrap"><table class="table"><thead><tr><th>Stack</th><th>Status</th><th class="col-optional">Compose project</th><th class="col-optional">File</th></tr></thead><tbody>${rows}</tbody></table></div>`;
        }
        const warning = dockerNote ? note("warn", dockerNote) : "";
        const { containers, note: containerNote } = await loadContainers(
            stacksRoot,
            provider,
            inspector,
            config.hostStacksPathAliases,
            discovery,
        );
        return htmlResponse(
            documentHtml(
                "Stacks",
                `<div class="page-head"><h1>Stacks</h1><div class="actions">${config.managedSitesEnabled ? `<a href="/new-site" class="btn">New site</a>` : ""}<a href="/new-stack" class="btn btn-primary">New stack</a></div></div>${intro}${warning}${content}${otherContainersSection(containers, "running", containerNote)}`,
                { ...pageChrome(csrf), nav: { stacks: stacks.map((stack) => stack.name), section: "stacks" } },
            ),
        );
    }

    async function renderAudit(csrf: string, requested: string | null): Promise<Response> {
        const periods = await audit.listPeriods();
        const selected = requested !== null && periods.includes(requested) ? requested : (periods[0] ?? null);
        let entries: Awaited<ReturnType<typeof audit.readPeriod>> = [];
        if (selected) {
            try {
                entries = await audit.readPeriod(selected, config.audit.maxReadLines);
            } catch (error) {
                if (error instanceof AuditError) throw new StackError(error.message, 404);
                throw error;
            }
        }
        return htmlResponse(
            auditPage({ csrf, access, timezone: config.timeZone || undefined, periods, selected, entries, nav: await sidebarNav("audit") }),
        );
    }

    async function renderAccess(csrf: string, request: Request): Promise<Response> {
        const report = buildAccessReport({
            port: config.port,
            proxyOrigins: config.proxyOrigins,
            allowLoopback: config.allowLoopback,
            cookieSecure: config.cookieSecure,
            devMode: config.devMode,
            allowOpaqueOrigin: config.allowOpaqueOrigin,
            currentAccess: accessOf(request, config),
        });
        return htmlResponse(accessPage({ csrf, access, timezone: config.timeZone || undefined, report, nav: await sidebarNav("access") }));
    }

    async function renderServer(csrf: string, request: Request, notice?: string): Promise<Response> {
        // Reuse the same classification as the container views (ADR 0014) so a
        // container is attributed to a stack on the same strict basis.
        const { containers, note: containerNote } = await loadContainers(stacksRoot, provider, inspector, config.hostStacksPathAliases);
        const insights = await loadInsights(inspector, containerNote === null ? containers : null, {
            timeoutMs: config.insightsTimeoutMs,
            maxBytes: config.dockerMaxBytes,
        });
        if (containerNote) insights.notes.unshift(containerNote);
        // Disk usage is only read when explicitly requested, and served from the
        // cache within its TTL so a repeated click does not hit the daemon.
        const wantsDisk = new URL(request.url).searchParams.get("disk") === "1";
        const disk = wantsDisk
            ? await diskCache.read(inspector, Date.now(), config.diskUsageTtlMs, {
                  timeoutMs: config.insightsTimeoutMs,
                  maxBytes: config.dockerMaxBytes,
              })
            : null;
        return htmlResponse(
            serverPage({
                csrf,
                access,
                timezone: config.timeZone || undefined,
                insights,
                disk,
                notice,
                maintenance: { last: maintenance.last() },
                nav: await sidebarNav("server"),
            }),
        );
    }

    /**
     * Start one fixed Docker storage prune (ADR 0040). The command owns the
     * engine and keeps running after the redirect; its outcome is read from the
     * maintenance view on the next Server page load. Nothing is awaited here
     * beyond the synchronous reservation, so a slow prune cannot hold the HTTP
     * connection open.
     */
    async function handleMaintenanceStart(request: Request, session: Session): Promise<Response> {
        const csrf = session.csrf;
        if (!isAllowedOrigin(request, config)) return staleForm(csrf, "/server");
        const form = await readForm(request);
        if (form === null) return tooLarge(csrf, "/server");
        if (!safeEqual(form.get("csrf") ?? "", csrf)) return staleForm(csrf, "/server");
        if (!sessions.isActive(session.id)) return sessionEnded();
        const actor = clientKey(request, config);
        const refuse = async (message: string, status = 409): Promise<never> => {
            await recordAudit({ event: "maintenance", result: "refused", actor, detail: message });
            throw new StackError(`${message} Nothing was run.`, status);
        };
        const scope = form.get("scope") ?? "";
        if (!isMaintenanceScope(scope)) return await refuse("This maintenance action is not available.", 400);
        if (form.get("confirm") !== "1") return await refuse("This maintenance action was not confirmed.", 400);
        if (shuttingDown) return await refuse("The panel is shutting down.", 503);
        if (selfUpdatePending) return await refuse(SELF_UPDATE_RUNNING, 409);
        const busy = maintenance.isRunning()
            ? "Docker maintenance is already running. Wait for it to finish."
            : "An action or save is still running. Wait for it to finish, then start maintenance.";
        try {
            maintenance.start(scope);
        } catch (error) {
            if (error instanceof MaintenanceDisabledError) return await refuse("The panel is shutting down.", 503);
            if (error instanceof MaintenanceBusyError) return await refuse(busy, 409);
            throw error;
        }
        // The run is not cancelled by a disconnected browser and is never replayed.
        return redirect("/server?maintenance=1", 303);
    }

    /**
     * Live data for the Server page: the dynamic zones only, rendered by the
     * same view functions as the first render. It never reads `docker system df`
     * and never runs `docker info`; a browser polls it on demand while the page
     * is visible (ADR 0015, ADR 0044). Authenticated, `no-store`.
     */
    async function handleServerStats(memoryTotalBytes: number | null): Promise<Response> {
        const { containers, note: containerNote } = await loadContainers(stacksRoot, provider, inspector, config.hostStacksPathAliases);
        const insights = await loadInsights(inspector, containerNote === null ? containers : null, {
            includeInfo: false,
            timeoutMs: config.insightsTimeoutMs,
            maxBytes: config.dockerMaxBytes,
        });
        if (containerNote) insights.notes.unshift(containerNote);
        const payload = { ...serverLiveView(insights, memoryTotalBytes), notes: insights.notes };
        return new Response(JSON.stringify(payload), {
            headers: { "Content-Type": "application/json; charset=utf-8", ...BASE_HEADERS },
        });
    }

    async function renderContainers(csrf: string, filter: ContainerFilter): Promise<Response> {
        const { containers, note: containerNote } = await loadContainers(stacksRoot, provider, inspector, config.hostStacksPathAliases);
        return htmlResponse(
            containersPage({
                csrf,
                access,
                timezone: config.timeZone || undefined,
                filter,
                containers,
                note: containerNote,
                nav: await sidebarNav("containers"),
            }),
        );
    }

    async function renderContainerDetail(rawId: string, csrf: string): Promise<Response> {
        if (!isContainerId(rawId)) throw new StackError("This container reference is not valid.", 400);
        const outcome = await loadContainerDetail(stacksRoot, rawId, provider, inspector, config.hostStacksPathAliases);
        // An unreadable list is not a missing container: Docker may be down
        // while the container still exists, so answer 503, never 404.
        if (outcome.kind === "unavailable") throw new StackError(outcome.note, 503);
        if (outcome.kind === "not-found")
            throw new StackError("No container with this reference was found. It may have been removed.", 404);
        const detail = outcome.detail;
        return htmlResponse(
            containerDetailPage({
                csrf,
                access,
                timezone: config.timeZone || undefined,
                container: detail.container,
                details: detail.details,
                note: detail.note,
                logTailLines: config.logTailLines,
                nav: await sidebarNav("containers"),
            }),
        );
    }

    /**
     * Bounded one-shot log history for a single container. Read-only, `no-store`,
     * `tail` restricted to an allow-list; Docker stderr is never echoed (logs may
     * hold secrets), only a fixed failure message. Works without JavaScript.
     */
    async function handleContainerLogs(rawId: string, tail: string | null): Promise<Response> {
        if (!isContainerId(rawId)) return plain("This container reference is not valid.", 400);
        const requested = tail !== null && /^\d+$/.test(tail) ? Number(tail) : undefined;
        const tailLines = sanitizeTailLines(requested);
        let result: Awaited<ReturnType<ContainerInspector["logs"]>>;
        try {
            result = await inspector.logs({ id: rawId, tailLines, maxBytes: config.logMaxBytes, timeoutMs: config.dockerTimeoutMs });
        } catch {
            return plain("Docker could not read these logs. Reload the page to try again.", 502);
        }
        if (result.timedOut) return plain("Docker did not respond in time. Reload the page to try again.", 504);
        if (result.code !== 0) return plain("Docker could not read these logs. The container may have been removed; reload the page.", 502);
        const text = stripAnsi(result.stdout).replace(/\s+$/, "");
        if (!text) return plain("No recent logs for this container.", 200);
        return plain(result.truncated ? `${text}\n\n[Output shortened: only the most recent part is kept.]` : text, 200);
    }

    /**
     * Database explorer card (ADR 0027). Declarative only: the panel builds a
     * link to an external explorer and never contacts it. Nothing is shown
     * without a global explorer URL; an invalid stack declaration is reported
     * as a warning without affecting the rest of the page.
     */
    function databaseExplorerSection(composeSource: string): string {
        if (!config.databaseExplorerUrl) return "";
        const parsed = parseDatabaseExplorer(composeSource);
        if (!parsed.ok) return databaseSection(null, parsed.error);
        if (!parsed.value) return "";
        const url = buildExplorerUrl(config.databaseExplorerUrl, parsed.value.query);
        return databaseSection({ url, label: parsed.value.label, query: parsed.value.query });
    }

    /**
     * Domains card (ADR 0030). Reads the attached sites from the helper when
     * the integration is enabled; a helper that cannot be reached leaves a
     * warning inside the card and never fails the page. Query values are only
     * ever reflected through escaped form fields.
     */
    async function domainsCard(
        stackName: string,
        project: string | null,
        csrf: string,
        serviceNames: string[],
        owner: string | null,
        query: URLSearchParams | null,
        confirmDetach: string | null,
    ): Promise<string> {
        if (!config.caddyEnabled) return "";
        const domain = (query?.get("caddyDomain") ?? query?.get("domain") ?? "").slice(0, 253);
        const service = (query?.get("caddyService") ?? query?.get("service") ?? "").slice(0, 64);
        const portText = (query?.get("caddyPort") ?? query?.get("port") ?? "").slice(0, 5);
        const hasInput = ["caddyDomain", "caddyService", "caddyPort", "domain", "service", "port"].some((key) => query?.has(key));
        let preview: { file: string | null; error: string | null } = { file: null, error: null };
        if (hasInput && !owner) {
            preview = previewSiteFile(stackName, serviceNames, domain, service, portText);
        }
        let attached: AttachedDomain[] = [];
        let statusError: string | null = null;
        if (config.caddySocketPath) {
            try {
                const response = await callCaddyHelper(config.caddySocketPath, { action: "status" }, { timeoutMs: config.dockerTimeoutMs });
                if (!response.ok) {
                    statusError = "The domain list could not be read. Nothing was changed.";
                } else if (response.action !== "status") {
                    statusError = "The domain list could not be read. Nothing was changed.";
                } else {
                    attached = response.sites
                        .filter((site) => site.stack === stackName)
                        .map((site) => ({ domain: site.domain, service: site.service, port: site.port }));
                    if (response.unparseable.length > 0) {
                        statusError = "Some managed files could not be read. Inspect them on the host.";
                    }
                }
            } catch {
                statusError = "The Caddy helper did not answer. Check the helper socket on the host.";
            }
        }
        return domainsSection({
            stackName,
            csrf,
            services: serviceNames,
            published: owner ? null : await publishedUpstreams(project ?? stackName),
            owner,
            attached,
            statusError,
            socketReady: config.caddySocketPath !== null,
            preview: { domain, service, port: portText, file: preview.file, error: preview.error, hasInput },
            confirmDetach,
        });
    }

    /**
     * Host ports the running containers of a project publish, each marked
     * eligible when it is exactly what the managed file dials. Offered as
     * suggestions only: attach re-checks under the lock. Null when Docker
     * cannot tell, so the card simply shows no suggestion.
     */
    async function publishedUpstreams(project: string): Promise<PublishedUpstream[] | null> {
        const read = await readPublishedPorts(project, null);
        if (read.kind !== "ok" || (read.running > 0 && read.inspected === 0)) return null;
        const upstreams: PublishedUpstream[] = [];
        for (const { service, binding } of read.ports) {
            if (binding.host === null) continue;
            const split = splitHostBinding(binding.host);
            if (!split) continue;
            upstreams.push({
                service,
                container: binding.container,
                host: binding.host,
                port: split.port,
                eligible: matchesGeneratedUpstream(binding.container, binding.host, split.port),
            });
        }
        const seen = new Set<string>();
        return upstreams
            .filter((entry) => {
                const key = `${entry.service} ${entry.container} ${entry.host}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            })
            .sort((a, b) => a.service.localeCompare(b.service) || a.port - b.port);
    }

    /** Validate preview input and render the canonical file. No mutation. */
    function previewSiteFile(
        stackName: string,
        serviceNames: string[],
        domain: string,
        service: string,
        portText: string,
    ): { file: string | null; error: string | null } {
        if (!isValidDomain(domain)) {
            return { file: null, error: "This domain is not valid. Use a public domain such as app.example.com." };
        }
        if (!isValidServiceName(service)) return { file: null, error: "This service name is not valid." };
        if (!serviceNames.includes(service)) return { file: null, error: "This service is not part of this stack." };
        const port = Number(portText);
        if (!isValidUpstreamPort(port)) {
            return { file: null, error: "This port is not valid. Use a number between 1 and 65535." };
        }
        if (!isValidStackName(stackName)) return { file: null, error: "This stack name is not valid." };
        return { file: buildSiteFile({ domain: normalizeDomain(domain)!, stack: stackName, service, port }), error: null };
    }

    async function renderStackDetail(
        name: string,
        csrf: string,
        notice?: { kind: NoteKind; text: string },
        statusCode = 200,
        query: URLSearchParams | null = null,
        extras: { confirmDetach?: string | null } = {},
    ): Promise<Response> {
        const stack = await readStackCompose(stacksRoot, name);
        let status: StackDetailStatus;
        try {
            status = await loadStackDetail(stacksRoot, name, provider, { rollout: config.rolloutEnabled });
        } catch (error) {
            if (error instanceof StackError) throw error;
            status = { project: null, state: "unknown", note: "The status could not be read.", services: [] };
        }
        const href = `/stacks/${encodeURIComponent(stack.name)}`;
        const operation = operations.forStack(stack.name);
        const check = imageCheck.forStack(stack.name);
        const owner = managedBy(status.declared);
        const siteCard = config.managedSitesEnabled ? await managedSiteCard(stack.name) : null;
        const project = status.project ? `<span>Compose project <code>${escapeHtml(status.project)}</code></span>` : "";
        return htmlResponse(
            documentHtml(
                stack.name,
                `<p class="crumbs"><a href="/">← All stacks</a></p>` +
                    `<div class="page-head"><h1>${escapeHtml(stack.name)}</h1><span class="row-actions">${status.rolloutDeclared && status.rolloutDeclared.length > 0 ? `<a href="${href}/rollout" class="btn">Rollout</a>` : ""}<a href="${href}/actions" class="btn">App actions</a><a href="${href}/edit" class="btn">Edit files</a></span></div>` +
                    `<p class="meta">${stateBadge(status.state)}<span><code>${escapeHtml(stack.filename)}</code></span>${project}${healthSummaryBadge(status.services)}${managedByBadge(owner)}</p>` +
                    (notice ? note(notice.kind, notice.text) : "") +
                    (status.note ? note("warn", status.note) : "") +
                    operationControls(stack.name, csrf, {
                        busy: operation?.status === "running",
                        state: status.state,
                        updatesReady: Object.keys(status.updates ?? {}),
                        recreatePending: status.recreatePending,
                        managedBy: owner,
                    }) +
                    operationPanel(operation, stack.name) +
                    managedSiteSection(siteCard, stack.name, csrf, operation?.status === "running") +
                    servicesSection(
                        status.services,
                        status.state,
                        status.updates,
                        { name: stack.name, csrf, busy: operation?.status === "running" },
                        status.recreatePending,
                        status.rolloutDeclared,
                        {
                            view: check,
                            running: imageCheck.isRunning(),
                            // Only a supported stack page offers the check: the route
                            // refuses an unknown, ambiguous or undeployed project.
                            enabled: status.project !== null && (status.state === "running" || status.state === "stopped"),
                            mutationRunning: operation?.status === "running",
                        },
                    ) +
                    databaseExplorerSection(stack.source) +
                    (await domainsCard(
                        stack.name,
                        status.project,
                        csrf,
                        status.services.map((service) => service.name),
                        owner,
                        query,
                        extras.confirmDetach ?? null,
                    )) +
                    deploymentSection(status.deployed, status.declared, status.state !== "not-created") +
                    logsPanel(
                        stack.name,
                        config.logTailLines,
                        config.timeZone,
                        status.services.map((service) => service.name),
                    ) +
                    `<section class="card"><details><summary>${escapeHtml(stack.filename)}</summary><pre class="output">${escapeHtml(stack.source)}</pre></details></section>`,
                {
                    ...pageChrome(csrf),
                    scripts: ["/app.js"],
                    nav: await sidebarNav("stacks", stack.name),
                    refreshSeconds: check?.status === "running" ? 5 : undefined,
                },
            ),
            statusCode,
        );
    }

    function decodeName(raw: string): string {
        try {
            return decodeURIComponent(raw);
        } catch {
            throw new StackError("This stack name is not valid.");
        }
    }

    function safeName(raw: string): string | undefined {
        try {
            return decodeURIComponent(raw);
        } catch {
            return undefined;
        }
    }

    async function renderEdit(
        name: string,
        csrf: string,
        options: {
            error?: { title: string; message: string };
            notice?: { kind: NoteKind; text: string };
            draft?: SaveDraft;
            keepDraft?: boolean;
            status?: number;
        } = {},
    ): Promise<Response> {
        const stack = await readEditableStack(stacksRoot, name, config.maxEditBytes);
        const draft = options.keepDraft === true ? options.draft : undefined;
        // A broken backup folder must not lock the user out of the editor.
        const backups = await listBackups(stacksRoot, name).catch(() => null);
        return htmlResponse(
            editPage({
                name,
                csrf,
                access,
                timezone: config.timeZone || undefined,
                composeFilename: stack.composeFilename,
                // A kept draft keeps the versions it was based on, so a change made
                // on disk meanwhile is still detected as a conflict on the next save.
                composeSource: draft ? draft.composeSource : stack.composeSource,
                composeHash: draft ? draft.baseComposeHash : stack.composeHash,
                envSource: draft ? draft.envSource : stack.envSource,
                envHash: draft ? draft.baseEnvHash : stack.envHash,
                envExists: draft ? draft.baseEnvExists : stack.envExists,
                error: options.error ?? null,
                notice: options.notice,
                backups: backups && {
                    count: backups.length,
                    bytes: backups.reduce((total, entry) => total + entry.size, 0),
                    retain: config.backupRetain,
                },
                nav: await sidebarNav("stacks", name),
            }),
            options.status ?? 200,
        );
    }

    /** Best effort: a save that succeeded stays a success even if pruning fails. */
    async function pruneAfterSave(name: string): Promise<void> {
        try {
            await pruneBackups(stacksRoot, name, config.backupRetain);
        } catch (error) {
            console.error(`Could not prune old backups of ${name}:`, error instanceof Error ? error.message : error);
        }
    }

    async function handleBackupPurge(request: Request, name: string, session: Session): Promise<Response> {
        const csrf = session.csrf;
        const back = `/stacks/${encodeURIComponent(name)}/edit`;
        if (!isAllowedOrigin(request, config)) return staleForm(csrf, back);
        const form = await readForm(request);
        if (form === null) return tooLarge(csrf, back);
        if (!safeEqual(form.get("csrf") ?? "", csrf)) return staleForm(csrf, back);
        if (!sessions.isActive(session.id)) return sessionEnded();
        // The folder must still be a stack: validates the name before any path use.
        await locateComposeFile(stacksRoot, name);

        try {
            const task = locks.run(name, async () => {
                if (shuttingDown) throw new OperationsDisabledError();
                if (selfUpdatePending) throw new OperationsDisabledError(SELF_UPDATE_RUNNING);
                return pruneBackups(stacksRoot, name, 0);
            });
            saves.add(task);
            let removed: number;
            try {
                removed = await task;
            } finally {
                saves.delete(task);
            }
            await recordAudit({
                event: "backup-purge",
                result: "success",
                actor: clientKey(request, config),
                stack: name,
                detail: `${removed} removed`,
            });
            return redirect(`${back}?purged=1`, 303);
        } catch (error) {
            if (error instanceof StackBusyError || error instanceof OperationsDisabledError) {
                await recordAudit({
                    event: "backup-purge",
                    result: "refused",
                    actor: clientKey(request, config),
                    stack: name,
                    detail: error.message,
                });
                return renderEdit(name, csrf, { error: { title: "Backups not deleted.", message: error.message }, status: 409 });
            }
            if (error instanceof FileSafetyError) {
                await recordAudit({
                    event: "backup-purge",
                    result: "failure",
                    actor: clientKey(request, config),
                    stack: name,
                    detail: error.message,
                });
                return renderEdit(name, csrf, { error: { title: "Backups not deleted.", message: error.message }, status: 500 });
            }
            throw error;
        }
    }

    async function renderCreate(csrf: string, draft?: CreateStackRequest, error?: string, status = 200): Promise<Response> {
        return htmlResponse(
            createStackPage({
                ...pageChrome(csrf),
                csrf,
                root: stacksRoot,
                name: draft?.name,
                composeSource: draft?.composeSource,
                envSource: draft?.envSource,
                error,
                nav: await sidebarNav("stacks"),
            }),
            status,
        );
    }

    async function handleCreate(request: Request, session: Session): Promise<Response> {
        const csrf = session.csrf;
        if (!isAllowedOrigin(request, config)) return staleForm(csrf, "/new-stack");
        const form = await readForm(request, config.maxEditBytes);
        if (form === null) return tooLarge(csrf, "/new-stack");
        if (!safeEqual(form.get("csrf") ?? "", csrf)) return staleForm(csrf, "/new-stack");
        if (!sessions.isActive(session.id)) return sessionEnded();
        const draft = { name: form.get("name") ?? "", composeSource: form.get("compose") ?? "", envSource: form.get("env") ?? "" };
        let validName = false;
        try {
            validateStackName(draft.name);
            validName = true;
            const checkAuthorization = () => {
                if (!sessions.isActive(session.id)) throw new SessionEndedError();
                if (shuttingDown) throw new OperationsDisabledError();
                if (selfUpdatePending) throw new OperationsDisabledError(SELF_UPDATE_RUNNING);
            };
            const task = locks.run(draft.name, async () => {
                checkAuthorization();
                await createStack(stacksRoot, draft, provider, config.maxEditBytes, { beforeCommit: checkAuthorization });
            });
            saves.add(task);
            try {
                await task;
            } finally {
                saves.delete(task);
            }
            await recordAudit({ event: "create", result: "success", actor: clientKey(request, config), stack: draft.name });
            return redirect(`/stacks/${encodeURIComponent(draft.name)}?created=1`, 303);
        } catch (error) {
            if (error instanceof SessionEndedError) {
                await recordAudit({
                    event: "create",
                    result: "refused",
                    actor: clientKey(request, config),
                    stack: validName ? draft.name : undefined,
                });
                return sessionEnded();
            }
            const status =
                error instanceof StackError
                    ? error.status
                    : error instanceof StackBusyError || error instanceof OperationsDisabledError
                      ? 409
                      : 500;
            const message =
                error instanceof StackError || error instanceof StackBusyError || error instanceof OperationsDisabledError
                    ? error.message
                    : "The stack could not be created. Check directory permissions and Docker availability.";
            if (error instanceof StackCreationPartialError)
                console.error("Stack creation cleanup incomplete", { stack: draft.name, stage: error.stage });
            await recordAudit({
                event: "create",
                result: error instanceof StackCreationPartialError ? "partial" : "refused",
                actor: clientKey(request, config),
                stack: validName ? draft.name : undefined,
            });
            return renderCreate(csrf, draft, message, status);
        }
    }

    async function renderNewSite(csrf: string, draft?: Partial<NewSiteDraft>, error?: string, status = 200): Promise<Response> {
        return htmlResponse(
            newSitePage({
                ...pageChrome(csrf),
                csrf,
                root: stacksRoot,
                channels: MANAGED_SITE_CHANNELS,
                draft,
                error,
                nav: await sidebarNav("stacks"),
            }),
            status,
        );
    }

    function newSiteDraftFromForm(form: URLSearchParams): NewSiteDraft {
        return {
            name: form.get("name") ?? "",
            siteId: form.get("siteId") ?? "",
            project: form.get("project") ?? "",
            port: form.get("port") ?? "",
            channel: form.get("channel") ?? "",
            gitUrl: form.get("gitUrl") ?? "",
            gitRef: form.get("gitRef") ?? "",
            paths: form.get("paths") ?? "",
            databaseEngine: form.get("databaseEngine") ?? "",
            databaseNetwork: form.get("databaseNetwork") ?? "",
            composer: form.get("composer") === "on",
        };
    }

    function buildNewSite(stackDir: string, raw: NewSiteDraft) {
        const parsed = parseManagedSiteDraft(raw);
        if (!parsed.ok) return { ok: false as const, reason: parsed.reason };
        const built = buildManagedSite({
            stackDir,
            siteId: parsed.draft.siteId,
            project: parsed.draft.project,
            port: parsed.draft.port,
            gitUrl: parsed.draft.gitUrl,
            gitRef: parsed.draft.gitRef,
            channel: parsed.draft.channel,
            paths: parsed.draft.paths,
            ...(parsed.draft.databaseEngine
                ? {
                      database: {
                          engine: parsed.draft.databaseEngine as ManagedSiteDatabaseEngine,
                          network: parsed.draft.databaseNetwork,
                      },
                  }
                : {}),
            composer: parsed.draft.composer,
        });
        return built.ok ? { ok: true as const, built, draft: parsed.draft } : { ok: false as const, reason: built.reason };
    }

    async function handlePreviewSite(request: Request, session: Session): Promise<Response> {
        const csrf = session.csrf;
        if (!config.managedSitesEnabled) throw new StackError("Managed sites are not enabled on this panel.", 404);
        if (process.platform === "win32") throw new StackError("Managed site creation requires a Linux host.", 501);
        if (!isAllowedOrigin(request, config)) return staleForm(csrf, "/new-site");
        const form = await readForm(request);
        if (form === null) return tooLarge(csrf, "/new-site");
        if (!safeEqual(form.get("csrf") ?? "", csrf)) return staleForm(csrf, "/new-site");
        if (!sessions.isActive(session.id)) return sessionEnded();
        const raw = newSiteDraftFromForm(form);
        const built = buildNewSite(join(stacksRoot, raw.name), raw);
        if (!built.ok) return renderNewSite(csrf, raw, built.reason, 400);
        return htmlResponse(
            newSitePreviewPage({
                ...pageChrome(csrf),
                csrf,
                draft: {
                    ...raw,
                    siteId: built.draft.siteId,
                    project: built.draft.project,
                    port: String(built.draft.port),
                    paths: built.draft.paths.join("\n"),
                },
                manifestSource: built.built.manifestSource,
                compose: built.built.artifacts.compose,
                gateway: built.built.artifacts.gateway,
                opcache: built.built.artifacts.opcache,
                nav: await sidebarNav("stacks"),
            }),
        );
    }

    /** Refuse a port another managed site declares or a running container publishes. */
    async function requireSitePortFree(
        port: number,
        exceptStack: string | null = null,
        exceptProject: string | null = null,
    ): Promise<void> {
        const declared = await findManagedSitePortOwner(stacksRoot, port, exceptStack);
        if (declared.kind === "used") {
            throw new StackError(`Port ${port} is already reserved by the managed site "${declared.stack}".`, 409);
        }
        if (declared.kind === "unavailable") throw new StackError(`${declared.reason} Nothing was created.`, 503);
        let listed;
        try {
            listed = await inspector.list();
        } catch {
            throw new StackError("Docker did not respond, so the gateway port could not be checked. Nothing was created.", 503);
        }
        if (listed.code !== 0 || listed.timedOut) {
            throw new StackError("Docker did not respond, so the gateway port could not be checked. Nothing was created.", 503);
        }
        let containers;
        try {
            containers = parseContainerLs(listed.stdout);
        } catch {
            throw new StackError("Docker gave an unexpected answer, so the gateway port could not be checked. Nothing was created.", 503);
        }
        const conflict = containers.find((container) => {
            if (exceptProject !== null && container.project === exceptProject) return false;
            for (const match of container.ports.matchAll(/:(\d+)->/g)) {
                if (Number(match[1]) === port) return true;
            }
            return false;
        });
        if (conflict) {
            throw new StackError(
                `Port ${port} is already published by the container "${conflict.name}"${conflict.project ? ` of the project "${conflict.project}"` : ""}. Nothing was created.`,
                409,
            );
        }
    }

    async function handleCreateSite(request: Request, session: Session): Promise<Response> {
        const csrf = session.csrf;
        if (!config.managedSitesEnabled) throw new StackError("Managed sites are not enabled on this panel.", 404);
        if (process.platform === "win32") throw new StackError("Managed site creation requires a Linux host.", 501);
        if (!isAllowedOrigin(request, config)) return staleForm(csrf, "/new-site");
        const form = await readForm(request);
        if (form === null) return tooLarge(csrf, "/new-site");
        if (!safeEqual(form.get("csrf") ?? "", csrf)) return staleForm(csrf, "/new-site");
        if (!sessions.isActive(session.id)) return sessionEnded();
        const raw = newSiteDraftFromForm(form);
        const stackDir = join(stacksRoot, raw.name);
        const built = buildNewSite(stackDir, raw);
        if (!built.ok) return renderNewSite(csrf, raw, built.reason, 400);
        try {
            // The port is the only shared resource that is not covered by the
            // per-stack lock: serialize creations that would claim the same one.
            const task = locks.run(`managed-site-port-${built.draft.port}`, async () => {
                if (!sessions.isActive(session.id)) throw new SessionEndedError();
                if (shuttingDown) throw new OperationsDisabledError();
                if (selfUpdatePending) throw new OperationsDisabledError(SELF_UPDATE_RUNNING);
                await requireSitePortFree(built.draft.port);
                if (!sessions.isActive(session.id)) throw new SessionEndedError();
                await createManagedSite(
                    stacksRoot,
                    { stackName: built.draft.name, manifestSource: built.built.manifestSource, artifacts: built.built.artifacts },
                    provider,
                    config.maxEditBytes,
                    {
                        beforePublish: () => {
                            if (!sessions.isActive(session.id)) throw new SessionEndedError();
                        },
                    },
                );
            });
            saves.add(task);
            try {
                await task;
            } finally {
                saves.delete(task);
            }
            await recordAudit({
                event: "create",
                result: "success",
                actor: clientKey(request, config),
                stack: built.draft.name,
                detail: `managed site ${built.draft.siteId}, 127.0.0.1:${built.draft.port}`,
            });
            return redirect(`/stacks/${encodeURIComponent(built.draft.name)}?created=1`, 303);
        } catch (error) {
            if (error instanceof SessionEndedError) {
                await recordAudit({ event: "create", result: "refused", actor: clientKey(request, config) });
                return sessionEnded();
            }
            const status =
                error instanceof StackError
                    ? error.status
                    : error instanceof StackBusyError || error instanceof OperationsDisabledError
                      ? 409
                      : 500;
            const message =
                error instanceof StackError || error instanceof StackBusyError || error instanceof OperationsDisabledError
                    ? error.message
                    : "The site could not be created. Check directory permissions and Docker availability.";
            if (error instanceof ManagedSiteCreationPartialError)
                console.error("Managed site creation incomplete", { stack: built.draft.name });
            await recordAudit({
                event: "create",
                result: error instanceof ManagedSiteCreationPartialError ? "partial" : "refused",
                actor: clientKey(request, config),
                stack: built.draft.name,
            });
            return renderNewSite(csrf, raw, message, status);
        }
    }

    async function handleBaseline(request: Request, name: string, session: Session): Promise<Response> {
        const csrf = session.csrf;
        const back = `/stacks/${encodeURIComponent(name)}`;
        if (!config.managedSitesEnabled) throw new StackError("Managed sites are not enabled on this panel.", 404);
        if (!isAllowedOrigin(request, config)) return staleForm(csrf, back);
        const form = await readForm(request);
        if (form === null) return tooLarge(csrf, back);
        if (!safeEqual(form.get("csrf") ?? "", csrf)) return staleForm(csrf, back);
        if (!sessions.isActive(session.id)) return sessionEnded();

        const stackDir = await managedSiteStackDir(name);
        const manifestResult = await readManagedSiteManifest(stackDir);
        if (!manifestResult.ok) {
            await recordAudit({
                event: "deploy",
                result: "refused",
                actor: clientKey(request, config),
                stack: name,
                action: "baseline",
                detail: manifestResult.reason,
            });
            return renderStackDetail(name, csrf, { kind: "error", text: manifestResult.reason }, 409);
        }
        if (await pendingDeployAttempt(stackDir)) {
            const response = await refusePendingDeploy(request, name, csrf, "baseline");
            if (response) return response;
        }
        try {
            if (selfUpdatePending) throw new OperationsDisabledError(SELF_UPDATE_RUNNING);
            operations.startBaseline({
                stack: name,
                project: manifestResult.manifest.project,
                run: async ({ onOutput, record }) => {
                    if (selfUpdatePending) throw new OperationsDisabledError(SELF_UPDATE_RUNNING);
                    const currentDir = await managedSiteStackDir(name);
                    const current = await readManagedSiteManifest(currentDir);
                    if (!current.ok) return { refused: current.reason };
                    const refusal = await baselineRefusal(name, current.manifest);
                    if (refusal) return { refused: refusal };
                    const prepare = composerPreparation(current.manifest);
                    const result = await publishManagedSiteBaseline({
                        stackDir: currentDir,
                        manifest: current.manifest,
                        attemptId: randomSuffix(),
                        onOutput,
                        signal: shutdownController.signal,
                        ...(prepare ? { prepare, releaseLimits: MANAGED_SITE_RELEASE_LIMITS } : {}),
                    });
                    switch (result.kind) {
                        case "published":
                            record({ revision: result.releaseId });
                            onOutput(
                                `Baseline ${result.releaseId} is published${result.reused ? " (existing release reused)" : ""}. Start the site when ready.\n`,
                            );
                            return { code: 0, stdout: "", stderr: "", timedOut: false, truncated: false };
                        case "refused":
                            return { refused: result.reason };
                        case "failed":
                            onOutput(`${result.reason}\n`);
                            return { code: 1, stdout: "", stderr: "", timedOut: false, truncated: false };
                        case "unknown":
                            onOutput(`${result.reason}\n`);
                            return { code: -1, stdout: "", stderr: "", timedOut: false, truncated: false, terminationUnconfirmed: true };
                    }
                },
            });
            await recordAudit({
                event: "deploy",
                result: "started",
                actor: clientKey(request, config),
                stack: name,
                action: "baseline",
                detail: `site ${manifestResult.manifest.siteId}, ${manifestResult.manifest.deploy.git.ref}`,
            });
            return redirect(back, 303);
        } catch (error) {
            if (error instanceof StackBusyError || error instanceof OperationsDisabledError) {
                await recordAudit({
                    event: "deploy",
                    result: "refused",
                    actor: clientKey(request, config),
                    stack: name,
                    action: "baseline",
                    detail: error.message,
                });
                return renderStackDetail(name, csrf, { kind: "error", text: `${error.message} Nothing was run.` }, 409);
            }
            throw error;
        }
    }

    /**
     * Run one manual offsite backup (ADR 0049). The route only starts the
     * operation; the locked closure re-reads the manifest, the deploy marker and
     * the backup marker before one staging/upload run.
     */
    async function handleBackup(request: Request, name: string, session: Session): Promise<Response> {
        const csrf = session.csrf;
        const back = `/stacks/${encodeURIComponent(name)}`;
        if (!config.managedSitesEnabled) throw new StackError("Managed sites are not enabled on this panel.", 404);
        if (!isAllowedOrigin(request, config)) return staleForm(csrf, back);
        const form = await readForm(request);
        if (form === null) return tooLarge(csrf, back);
        if (!safeEqual(form.get("csrf") ?? "", csrf)) return staleForm(csrf, back);
        if (!sessions.isActive(session.id)) return sessionEnded();

        const stackDir = await managedSiteStackDir(name);
        const manifestResult = await readManagedSiteManifest(stackDir);
        if (!manifestResult.ok) return renderStackDetail(name, csrf, { kind: "error", text: manifestResult.reason }, 409);
        if (manifestResult.manifest.owner !== "managed" || !manifestResult.manifest.backup) {
            return renderStackDetail(
                name,
                csrf,
                { kind: "error", text: "This site declares no backup block, so there is nothing to back up." },
                409,
            );
        }
        if (await pendingDeployAttempt(stackDir)) {
            const response = await refusePendingDeploy(request, name, csrf, "backup");
            if (response) return response;
        }
        const marker = await readManagedSiteBackupAttempt(stackDir);
        if (marker.kind !== "none") {
            const text =
                "A previous backup attempt has an unconfirmed outcome. Inspect the repository and acknowledge it before starting another backup.";
            return renderStackDetail(name, csrf, { kind: "error", text }, 409);
        }
        try {
            if (selfUpdatePending) throw new OperationsDisabledError(SELF_UPDATE_RUNNING);
            operations.startBackup({
                stack: name,
                project: manifestResult.manifest.project,
                run: async ({ onOutput }) => {
                    if (selfUpdatePending) throw new OperationsDisabledError(SELF_UPDATE_RUNNING);
                    const currentDir = await managedSiteStackDir(name);
                    const current = await readManagedSiteManifest(currentDir);
                    if (!current.ok) return { refused: current.reason };
                    if (current.manifest.owner !== "managed" || !current.manifest.backup) {
                        return { refused: "This site no longer declares a backup block." };
                    }
                    if (await pendingDeployAttempt(currentDir)) return { refused: MANAGED_SITE_PENDING_MESSAGE };
                    const pendingBackup = await readManagedSiteBackupAttempt(currentDir);
                    if (pendingBackup.kind !== "none") {
                        return {
                            refused:
                                "A previous backup attempt has an unconfirmed outcome. Inspect the repository and acknowledge it first.",
                        };
                    }
                    const baseline = await readBaseline(currentDir, current.manifest.siteId);
                    const image = current.manifest.runtime.image
                        ? { reference: current.manifest.runtime.image, id: await resolveLocalImageId(current.manifest.runtime.image) }
                        : null;
                    const result = await runManagedSiteBackup(
                        {
                            stackDir: currentDir,
                            manifest: current.manifest,
                            attemptId: randomSuffix(),
                            releaseId: baseline.ok ? baseline.releaseId : null,
                            runtimeImage: image,
                            onOutput,
                            signal: shutdownController.signal,
                        },
                        {
                            ...(options.backupDocker ? { docker: options.backupDocker } : {}),
                            ...(options.backupCheckCredentials ? { checkCredentials: options.backupCheckCredentials } : {}),
                        },
                    );
                    if (!result.ok) {
                        onOutput(`Backup did not complete: ${result.reason}\n`);
                        return {
                            code: result.outcome === "unknown" ? -1 : 1,
                            stdout: "",
                            stderr: "",
                            timedOut: false,
                            truncated: false,
                        };
                    }
                    onOutput(
                        `Snapshot ${result.snapshotId} accepted: ${result.entries} entries, ${result.bytes} bytes${result.sqlBytes !== null ? `, ${result.sqlBytes} SQL bytes` : ""}.\n`,
                    );
                    return { code: 0, stdout: "", stderr: "", timedOut: false, truncated: false };
                },
            });
            await recordAudit({
                event: "backup",
                result: "started",
                actor: clientKey(request, config),
                stack: name,
                action: "backup",
                detail: `site ${manifestResult.manifest.siteId}, ${manifestResult.manifest.backup.sql ? "files+sql" : "files"}`,
            });
            return redirect(back, 303);
        } catch (error) {
            if (error instanceof StackBusyError || error instanceof OperationsDisabledError) {
                await recordAudit({
                    event: "backup",
                    result: "refused",
                    actor: clientKey(request, config),
                    stack: name,
                    action: "backup",
                    detail: error.message,
                });
                return renderStackDetail(name, csrf, { kind: "error", text: `${error.message} Nothing was run.` }, 409);
            }
            throw error;
        }
    }

    /**
     * Verify one exact snapshot and restore it into a private directory, with a
     * disposable database for a SQL snapshot. The live site is never written.
     */
    async function handleRestore(request: Request, name: string, session: Session): Promise<Response> {
        const csrf = session.csrf;
        const back = `/stacks/${encodeURIComponent(name)}`;
        if (!config.managedSitesEnabled) throw new StackError("Managed sites are not enabled on this panel.", 404);
        if (!isAllowedOrigin(request, config)) return staleForm(csrf, back);
        const form = await readForm(request);
        if (form === null) return tooLarge(csrf, back);
        if (!safeEqual(form.get("csrf") ?? "", csrf)) return staleForm(csrf, back);
        if (!sessions.isActive(session.id)) return sessionEnded();
        const snapshotId = (form.get("snapshot") ?? "").trim().toLowerCase();
        if (!isManagedSiteSnapshotId(snapshotId)) {
            return renderStackDetail(
                name,
                csrf,
                { kind: "error", text: "Select one exact 64-character hexadecimal snapshot id. latest is refused." },
                409,
            );
        }

        const stackDir = await managedSiteStackDir(name);
        const manifestResult = await readManagedSiteManifest(stackDir);
        if (!manifestResult.ok) return renderStackDetail(name, csrf, { kind: "error", text: manifestResult.reason }, 409);
        if (manifestResult.manifest.owner !== "managed" || !manifestResult.manifest.backup) {
            return renderStackDetail(
                name,
                csrf,
                { kind: "error", text: "This site declares no backup block, so there is no repository to restore from." },
                409,
            );
        }
        if (await pendingDeployAttempt(stackDir)) {
            const response = await refusePendingDeploy(request, name, csrf, "restore");
            if (response) return response;
        }
        const marker = await readManagedSiteBackupAttempt(stackDir);
        if (marker.kind !== "none") {
            const text =
                "A previous backup attempt has an unconfirmed outcome. Inspect the repository and acknowledge it before restoring.";
            return renderStackDetail(name, csrf, { kind: "error", text }, 409);
        }
        try {
            if (selfUpdatePending) throw new OperationsDisabledError(SELF_UPDATE_RUNNING);
            operations.startRestore({
                stack: name,
                project: manifestResult.manifest.project,
                run: async ({ onOutput }) => {
                    if (selfUpdatePending) throw new OperationsDisabledError(SELF_UPDATE_RUNNING);
                    const currentDir = await managedSiteStackDir(name);
                    const current = await readManagedSiteManifest(currentDir);
                    if (!current.ok) return { refused: current.reason };
                    if (current.manifest.owner !== "managed" || !current.manifest.backup) {
                        return { refused: "This site no longer declares a backup block." };
                    }
                    if (await pendingDeployAttempt(currentDir)) return { refused: MANAGED_SITE_PENDING_MESSAGE };
                    const pendingBackup = await readManagedSiteBackupAttempt(currentDir);
                    if (pendingBackup.kind !== "none") {
                        return {
                            refused:
                                "A previous backup attempt has an unconfirmed outcome. Inspect the repository and acknowledge it first.",
                        };
                    }
                    const result = await runManagedSiteRestore(
                        {
                            stackDir: currentDir,
                            manifest: current.manifest,
                            attemptId: randomSuffix(),
                            snapshotId,
                            onOutput,
                            signal: shutdownController.signal,
                        },
                        {
                            ...(options.restoreDocker ? { docker: options.restoreDocker } : {}),
                            ...(options.backupCheckCredentials ? { checkCredentials: options.backupCheckCredentials } : {}),
                        },
                    );
                    if (!result.ok) {
                        onOutput(`Restore did not complete in phase ${result.phase}: ${result.reason}\n`);
                        return { code: 1, stdout: "", stderr: "", timedOut: false, truncated: false };
                    }
                    onOutput(
                        `Restore verified: ${result.files} files (${result.bytes} bytes) from ${result.snapshotId} in ${result.restoreDir}${result.sql ? `, ${result.sql.tables} table(s) in a disposable ${result.sql.database} database` : ""}. The live site was not modified.\n`,
                    );
                    return { code: 0, stdout: "", stderr: "", timedOut: false, truncated: false };
                },
            });
            await recordAudit({
                event: "backup",
                result: "started",
                actor: clientKey(request, config),
                stack: name,
                action: "restore",
                detail: `snapshot ${snapshotId}`,
            });
            return redirect(back, 303);
        } catch (error) {
            if (error instanceof StackBusyError || error instanceof OperationsDisabledError) {
                await recordAudit({
                    event: "backup",
                    result: "refused",
                    actor: clientKey(request, config),
                    stack: name,
                    action: "restore",
                    detail: error.message,
                });
                return renderStackDetail(name, csrf, { kind: "error", text: `${error.message} Nothing was run.` }, 409);
            }
            throw error;
        }
    }

    /** Clear one backup marker after the operator inspected the repository. */
    async function handleBackupAcknowledge(request: Request, name: string, session: Session): Promise<Response> {
        const csrf = session.csrf;
        const back = `/stacks/${encodeURIComponent(name)}`;
        if (!config.managedSitesEnabled) throw new StackError("Managed sites are not enabled on this panel.", 404);
        if (!isAllowedOrigin(request, config)) return staleForm(csrf, back);
        const form = await readForm(request);
        if (form === null) return tooLarge(csrf, back);
        if (!safeEqual(form.get("csrf") ?? "", csrf)) return staleForm(csrf, back);
        if (!sessions.isActive(session.id)) return sessionEnded();
        const attempted = (form.get("attempt") ?? "").trim();

        const stackDir = await managedSiteStackDir(name);
        const manifestResult = await readManagedSiteManifest(stackDir);
        if (!manifestResult.ok) return renderStackDetail(name, csrf, { kind: "error", text: manifestResult.reason }, 409);
        const release = locks.tryAcquire(name);
        if (!release) {
            throw new StackBusyError("Another action is running for this stack. Wait for it to finish, then acknowledge the backup.");
        }
        try {
            const before = await readManagedSiteBackupAttempt(stackDir);
            if (before.kind === "none") return redirect(back, 303);
            if (before.kind === "pending" && attempted.length > 0 && attempted !== before.attempt.attemptId) {
                throw new StackError("The backup marker changed since this page was rendered. Reload it before acknowledging.", 409);
            }
            await removeManagedSiteBackupAttempt(stackDir);
        } finally {
            release();
        }
        await recordAudit({
            event: "backup",
            result: "acknowledged",
            actor: clientKey(request, config),
            stack: name,
            action: "backup",
            detail: attempted ? `operator cleared attempt ${attempted} after inspection` : "operator cleared an unreadable backup marker",
        });
        return redirect(back, 303);
    }

    /**
     * Explicitly rewrite the generated files from the manifest. Drift is never
     * repaired silently: the operator asks for this action, which replaces
     * every generated artifact with the deterministic rendering.
     */
    async function handleRegenerate(request: Request, name: string, session: Session): Promise<Response> {
        const csrf = session.csrf;
        const back = `/stacks/${encodeURIComponent(name)}`;
        if (!config.managedSitesEnabled) throw new StackError("Managed sites are not enabled on this panel.", 404);
        if (!isAllowedOrigin(request, config)) return staleForm(csrf, back);
        const form = await readForm(request);
        if (form === null) return tooLarge(csrf, back);
        if (!safeEqual(form.get("csrf") ?? "", csrf)) return staleForm(csrf, back);
        if (!sessions.isActive(session.id)) return sessionEnded();

        const stackDir = await managedSiteStackDir(name);
        const manifest = await readManagedSiteManifest(stackDir);
        if (!manifest.ok) {
            return renderStackDetail(name, csrf, { kind: "error", text: manifest.reason }, 409);
        }
        if (manifest.manifest.owner !== "managed") {
            return renderStackDetail(
                name,
                csrf,
                { kind: "error", text: "This stack keeps its own Compose file; there is nothing to regenerate." },
                409,
            );
        }
        if (await pendingDeployAttempt(stackDir)) {
            const response = await refusePendingDeploy(request, name, csrf, "regenerate");
            if (response) return response;
        }
        try {
            const task = locks.run(name, async () => {
                if (shuttingDown) throw new OperationsDisabledError();
                if (selfUpdatePending) throw new OperationsDisabledError(SELF_UPDATE_RUNNING);
                if (!sessions.isActive(session.id)) throw new SessionEndedError();
                if (await pendingDeployAttempt(stackDir)) throw new StackError(MANAGED_SITE_PENDING_MESSAGE, 409);
                const currentManifest = await readManagedSiteManifest(stackDir);
                if (!currentManifest.ok || currentManifest.manifest.owner !== "managed") {
                    throw new StackError(currentManifest.ok ? "This stack is not a managed site." : currentManifest.reason, 409);
                }
                const rendered = renderManagedSiteArtifacts(stackDir, currentManifest.manifest);
                if (!rendered.ok) throw new StackError(rendered.reason, 409);
                const nextPort = currentManifest.manifest.gateway?.port;
                if (nextPort === undefined) throw new StackError("The managed site has no gateway port.", 409);

                let stackAnchor;
                let generatedAnchor;
                try {
                    stackAnchor = await anchorDir(stackDir, "The stack folder is not a real directory. Nothing was rewritten.");
                    generatedAnchor = await anchorDir(
                        join(stackDir, MANAGED_SITE_PATHS.generated),
                        "The generated folder is a symbolic link or not a folder. Nothing was rewritten.",
                    );
                    const currentCompose = await readFileSafe(join(stackAnchor.path, "compose.yaml"), config.maxEditBytes);
                    if (!currentCompose) throw new StackError("The Compose file is missing. Nothing was rewritten.", 409);
                    const currentPort = generatedGatewayPort(currentCompose.source);
                    const portChanged = currentPort !== nextPort;
                    if (portChanged) {
                        // A port is a shared resource even while this site is
                        // stopped: another manifest may already reserve it.
                        await requireSitePortFree(nextPort, name, manifest.manifest.project);
                        const domains = await readManagedSiteDomains(name);
                        if (domains.kind === "unavailable") {
                            throw new StackError(
                                `${domains.reason} The gateway port cannot be proven detached from a domain, so nothing was rewritten.`,
                                503,
                            );
                        }
                        if (domains.kind === "attached") {
                            const list = domains.sites.map((site) => `${site.domain} (127.0.0.1:${site.port})`).join(", ");
                            throw new StackError(
                                `Detach the domains routed to this site before changing its gateway port: ${list}. Nothing was rewritten.`,
                                409,
                            );
                        }
                    }

                    const directory = await lstat(stackDir);
                    const files: [string, string][] = [
                        ["compose.yaml", rendered.artifacts.compose],
                        [MANAGED_SITE_GATEWAY_CONFIG, rendered.artifacts.gateway],
                        [MANAGED_SITE_OPCACHE_CONFIG, rendered.artifacts.opcache],
                    ];
                    const generatedPrefix = `${MANAGED_SITE_PATHS.generated}/`;
                    for (const [path, content] of files) {
                        const base = path.startsWith(generatedPrefix) ? generatedAnchor.path : stackAnchor.path;
                        const relative = path.startsWith(generatedPrefix) ? path.slice(generatedPrefix.length) : path;
                        const anchored = join(base, relative);
                        let attributes = { mode: 0o644, uid: directory.uid, gid: directory.gid };
                        try {
                            const current = await readFileSafe(anchored, Math.max(config.maxEditBytes, 64 * 1024));
                            if (current) attributes = { mode: current.mode, uid: current.uid, gid: current.gid };
                        } catch (error) {
                            if (error instanceof FileSafetyError) throw new StackError(`${path} cannot be replaced: ${error.message}`, 409);
                            throw error;
                        }
                        await writeFileAtomic(anchored, content, attributes);
                    }
                } catch (error) {
                    if (error instanceof FileSafetyError) throw new StackError(error.message, 409);
                    throw error;
                } finally {
                    await generatedAnchor?.close();
                    await stackAnchor?.close();
                }
            });
            saves.add(task);
            try {
                await task;
            } finally {
                saves.delete(task);
            }
            await recordAudit({
                event: "save",
                result: "success",
                actor: clientKey(request, config),
                stack: name,
                detail: "regenerated the managed site files from compose-panel-site.json",
            });
            return redirect(back, 303);
        } catch (error) {
            if (error instanceof SessionEndedError) return sessionEnded();
            if (error instanceof StackBusyError || error instanceof OperationsDisabledError || error instanceof StackError) {
                await recordAudit({
                    event: "save",
                    result: "refused",
                    actor: clientKey(request, config),
                    stack: name,
                    detail: error.message,
                });
                return renderStackDetail(name, csrf, { kind: "error", text: `${error.message} Nothing was changed.` }, 409);
            }
            throw error;
        }
    }

    async function handleSave(request: Request, name: string, session: Session): Promise<Response> {
        const csrf = session.csrf;
        const back = `/stacks/${encodeURIComponent(name)}/edit`;
        if (!isAllowedOrigin(request, config)) return staleForm(csrf, back);
        const form = await readForm(request, config.maxEditBytes);
        if (form === null) return tooLarge(csrf, back);
        if (!safeEqual(form.get("csrf") ?? "", csrf)) return staleForm(csrf, back);
        // The body may have arrived long after the session was checked.
        if (!sessions.isActive(session.id)) return sessionEnded();

        const pendingDeploy = await refusePendingDeploy(request, name, csrf, "save");
        if (pendingDeploy) return pendingDeploy;

        // A generated Compose file is not editable: the manifest is the source
        // of truth and a raw save would be silently reverified as drift later.
        let siteManifest;
        try {
            siteManifest = await readFileSafe(
                join(await managedSiteStackDir(name), MANAGED_SITE_MANIFEST_FILE),
                MANAGED_SITE_MANIFEST_MAX_BYTES,
            );
        } catch {
            await recordAudit({
                event: "save",
                result: "refused",
                actor: clientKey(request, config),
                stack: name,
                detail: "the site manifest cannot be read as a regular file",
            });
            return renderEdit(name, csrf, {
                error: {
                    title: "The site manifest cannot be read.",
                    message:
                        "Inspect compose-panel-site.json on the host. Raw save is refused while a site manifest exists but cannot be used.",
                },
                status: 409,
            });
        }
        if (siteManifest) {
            const parsedSite = parseManagedSiteManifest(siteManifest.source);
            if (!parsedSite.ok || parsedSite.manifest.owner === "managed") {
                await recordAudit({
                    event: "save",
                    result: "refused",
                    actor: clientKey(request, config),
                    stack: name,
                    detail: "the stack carries a site manifest",
                });
                return renderEdit(name, csrf, {
                    error: {
                        title: "This stack has a site manifest.",
                        message: parsedSite.ok
                            ? "Its Compose file and gateway configuration come from compose-panel-site.json. Raw save is refused: edit the manifest on the host, then regenerate or recreate the files."
                            : `The site manifest cannot be used: ${parsedSite.reason} Raw save is refused while it exists; inspect it on the host.`,
                    },
                    status: 409,
                });
            }
        }

        const saveRequest = {
            composeSource: form.get("compose") ?? "",
            envSource: form.get("env") ?? "",
            baseComposeHash: form.get("composeHash") ?? "",
            baseEnvHash: form.get("envHash") ?? "",
            baseEnvExists: form.get("envExists") === "1",
        };

        try {
            const task = locks.run(name, async () => {
                if (shuttingDown) throw new OperationsDisabledError();
                if (selfUpdatePending) throw new OperationsDisabledError(SELF_UPDATE_RUNNING);
                const saved = await saveEditableStack(stacksRoot, name, saveRequest, provider, config.maxEditBytes, {
                    // Validation awaits a subprocess: re-check right before writing.
                    beforeCommit: () => {
                        if (!sessions.isActive(session.id)) throw new SessionEndedError();
                    },
                });
                // Still under the stack lock, so no other save adds a backup meanwhile.
                if (saved.changed) await pruneAfterSave(name);
                return saved;
            });
            saves.add(task);
            let result: Awaited<typeof task>;
            try {
                result = await task;
            } finally {
                saves.delete(task);
            }
            await recordAudit({
                event: "save",
                result: result.changed ? "success" : "no-change",
                actor: clientKey(request, config),
                stack: name,
            });
            // The effective configuration may now reference other images: a
            // remote verdict recorded before the save can no longer describe it.
            if (result.changed) imageCheck.changed(name);
            return redirect(`/stacks/${encodeURIComponent(name)}?saved=${result.changed ? "1" : "0"}`, 303);
        } catch (error) {
            if (error instanceof StackValidationError) {
                await recordAudit({
                    event: "save",
                    result: "failure",
                    actor: clientKey(request, config),
                    stack: name,
                    detail: "validation failed",
                });
                return renderEdit(name, csrf, {
                    error: { title: "Not saved: the Compose check failed.", message: error.message },
                    draft: saveRequest,
                    keepDraft: true,
                    status: 400,
                });
            }
            if (error instanceof StackConflictError) {
                await recordAudit({ event: "save", result: "conflict", actor: clientKey(request, config), stack: name });
                return renderEdit(name, csrf, {
                    error: {
                        title: "Not saved.",
                        message: `${error.message} The editor now shows the current files: apply your changes again, then save.`,
                    },
                    keepDraft: false,
                    status: 409,
                });
            }
            if (error instanceof StackBusyError || error instanceof OperationsDisabledError) {
                // Keep the draft: nothing was written, the user can retry.
                await recordAudit({
                    event: "save",
                    result: "refused",
                    actor: clientKey(request, config),
                    stack: name,
                    detail: error.message,
                });
                return renderEdit(name, csrf, {
                    error: { title: "Not saved.", message: error.message },
                    draft: saveRequest,
                    keepDraft: true,
                    status: 409,
                });
            }
            if (error instanceof SessionEndedError) {
                await recordAudit({
                    event: "save",
                    result: "refused",
                    actor: clientKey(request, config),
                    stack: name,
                    detail: "session ended",
                });
                return sessionEnded();
            }
            if (error instanceof StackPartialError) {
                await recordAudit({ event: "save", result: "partial", actor: clientKey(request, config), stack: name });
                return renderEdit(name, csrf, {
                    error: { title: "Save incomplete.", message: error.message },
                    draft: saveRequest,
                    keepDraft: true,
                    status: 500,
                });
            }
            if (error instanceof FileSafetyError) {
                await recordAudit({ event: "save", result: "failure", actor: clientKey(request, config), stack: name });
                return renderEdit(name, csrf, {
                    error: { title: "Not saved.", message: error.message },
                    draft: saveRequest,
                    keepDraft: true,
                    status: 500,
                });
            }
            throw error;
        }
    }

    async function handleOperation(request: Request, name: string, session: Session): Promise<Response> {
        const csrf = session.csrf;
        const back = `/stacks/${encodeURIComponent(name)}`;
        if (!isAllowedOrigin(request, config)) return staleForm(csrf, back);
        const form = await readForm(request);
        if (form === null) return tooLarge(csrf, back);
        if (!safeEqual(form.get("csrf") ?? "", csrf)) return staleForm(csrf, back);
        // The body may have arrived long after the session was checked.
        if (!sessions.isActive(session.id)) return sessionEnded();

        const action = form.get("action") ?? "";
        if (!isOperationAction(action))
            return renderStackDetail(name, csrf, { kind: "error", text: "Unknown action. Nothing was run." }, 400);

        const pendingDeploy = await refusePendingDeploy(request, name, csrf, action);
        if (pendingDeploy) return pendingDeploy;

        // Scoped operations (ADR 0021, extended by ADR 0041): only `up`,
        // `restart` and `pull` accept a service. Anywhere else the field is
        // refused, never ignored.
        const serviceParam = (form.get("service") ?? "").trim();
        const scopedActions = new Set(["up", "restart", "pull"]);
        if (serviceParam !== "" && !scopedActions.has(action)) {
            return renderStackDetail(
                name,
                csrf,
                { kind: "error", text: "This action does not apply to a single service. Nothing was run." },
                400,
            );
        }
        if (serviceParam !== "" && !isComposeServiceName(serviceParam)) {
            return renderStackDetail(name, csrf, { kind: "error", text: "This service selection is not valid. Nothing was run." }, 400);
        }
        const service = serviceParam === "" ? null : serviceParam;

        // Fail closed: ambiguous or unreachable project identity never runs
        // blind. An undeployed stack can only be created (up / pull-up) or have
        // its images downloaded (pull, which touches no container); destructive
        // actions require a resolved project passed as explicit -p. Resolve a
        // new project's effective name through Compose, check for collisions,
        // then pin that identity explicitly.
        const creates = action === "up" || action === "pull-up" || action === "pull";
        const context = await resolveProjectContext(stacksRoot, name, provider, creates);
        if (context.kind === "invalid") {
            throw new StackError(ENV_NOT_REGULAR, 409);
        }
        if (context.kind === "ambiguous") {
            throw new StackError(
                "The panel cannot tell which Docker Compose project belongs to this stack: several projects match, or the project name is already used by another stack. It will not guess, so nothing was run.",
                409,
            );
        }
        if (context.kind === "unavailable") {
            throw new StackError(
                "Docker did not respond, so the panel could not check which project this stack belongs to. Nothing was run.",
                503,
            );
        }
        if (context.kind === "absent" && !creates) {
            throw new StackError(
                "This stack is not deployed yet, so there is nothing to stop, restart or remove. Use Up or Pull + up to create it.",
                409,
            );
        }
        // Scoped `up` never creates: it applies the Compose file to one
        // service of a deployed stack.
        if (service !== null && action === "up" && context.kind === "absent") {
            throw new StackError(
                "This stack is not deployed yet, so there is no service to update. Use Up without a service to create it.",
                409,
            );
        }
        let resolvedService: string | null = null;
        if (service !== null) {
            const names = await provider.listServices({
                project: context.project ?? undefined,
                composeFile: context.composeFile,
                cwd: context.cwd,
                envFile: context.envFile ?? undefined,
            });
            if (names === null) {
                throw new StackError(
                    "Docker did not respond, so the panel could not check which services this stack defines. Nothing was run.",
                    503,
                );
            }
            if (!names.includes(service)) {
                throw new StackError("This stack defines no such service. Nothing was run.", 409);
            }
            resolvedService = service;
        }
        // Project and service discovery await Docker: re-check before starting anything.
        if (!sessions.isActive(session.id)) {
            await recordAudit({
                event: "operation",
                result: "refused",
                actor: clientKey(request, config),
                stack: name,
                action,
                detail: "session ended",
            });
            return sessionEnded();
        }
        try {
            if (selfUpdatePending) throw new OperationsDisabledError(SELF_UPDATE_RUNNING);
            operations.start({
                stack: name,
                action,
                target: {
                    project: context.project ?? undefined,
                    composeFile: context.composeFile,
                    cwd: context.cwd,
                    envFile: context.envFile ?? undefined,
                    service: resolvedService ?? undefined,
                },
            });
            await recordAudit({
                event: "operation",
                result: "started",
                actor: clientKey(request, config),
                stack: name,
                action,
                service: resolvedService ?? undefined,
            });
            return redirect(`/stacks/${encodeURIComponent(name)}`, 303);
        } catch (error) {
            if (error instanceof StackBusyError || error instanceof OperationsDisabledError) {
                await recordAudit({
                    event: "operation",
                    result: "refused",
                    actor: clientKey(request, config),
                    stack: name,
                    action,
                    detail: error.message,
                });
                return renderStackDetail(name, csrf, { kind: "error", text: `${error.message} Nothing was run.` }, 409);
            }
            throw error;
        }
    }

    /**
     * Start an explicit remote image check (ADR 0041): does each tracked tag
     * still resolve, in its registry, to the digest Docker recorded for it?
     * Read-only and outbound; it never downloads, never touches a container and
     * never takes the stack lock. The page reads the result on its next render.
     */
    async function handleImageCheck(request: Request, name: string, session: Session): Promise<Response> {
        const csrf = session.csrf;
        const back = `/stacks/${encodeURIComponent(name)}`;
        if (!isAllowedOrigin(request, config)) return staleForm(csrf, back);
        const form = await readForm(request);
        if (form === null) return tooLarge(csrf, back);
        if (!safeEqual(form.get("csrf") ?? "", csrf)) return staleForm(csrf, back);
        if (!sessions.isActive(session.id)) return sessionEnded();
        // Validates the name and rejects unknown stacks before any Docker call.
        await locateComposeFile(stacksRoot, name);
        const actor = clientKey(request, config);
        const refuse = async (message: string, status = 409): Promise<Response> => {
            await recordAudit({ event: "image-check", result: "refused", actor, stack: name, detail: message });
            return renderStackDetail(name, csrf, { kind: "error", text: `${message} Nothing was checked.` }, status);
        };
        if (shuttingDown) return await refuse("The panel is shutting down.", 503);
        if (selfUpdatePending) return await refuse(SELF_UPDATE_RUNNING);
        // Only a deployed stack has a verified project to read the effective
        // configuration and the local digests from.
        const context = await resolveProjectContext(stacksRoot, name, provider);
        if (context.kind === "invalid") throw new StackError(ENV_NOT_REGULAR, 409);
        if (context.kind === "ambiguous") {
            return await refuse("The panel cannot tell which Docker Compose project belongs to this stack.");
        }
        if (context.kind === "unavailable") {
            return await refuse("Docker did not respond, so the panel could not check this stack's images.", 503);
        }
        if (context.kind === "absent") {
            return await refuse("This stack is not deployed yet, so there is no project to check. Use Up or Pull + up first.");
        }
        // Discovery awaited Docker: re-check the session before starting anything.
        if (!sessions.isActive(session.id)) {
            await recordAudit({ event: "image-check", result: "refused", actor, stack: name, detail: "session ended" });
            return sessionEnded();
        }
        try {
            await imageCheck.start({
                stack: name,
                target: {
                    project: context.project ?? undefined,
                    composeFile: context.composeFile,
                    cwd: context.cwd,
                    envFile: context.envFile ?? undefined,
                },
            });
        } catch (error) {
            if (error instanceof ImageCheckBusyError || error instanceof ImageCheckRefusedError) {
                return await refuse(error.message);
            }
            if (error instanceof ImageCheckDisabledError) return await refuse("The panel is shutting down.", 503);
            throw error;
        }
        await recordAudit({ event: "image-check", result: "started", actor, stack: name });
        return redirect(back, 303);
    }

    /**
     * Whether the requested port is published by a running container of the
     * service exactly as the managed file will dial it (`reverse_proxy
     * 127.0.0.1:<port>` over TCP). Read-only, through the existing
     * `ContainerInspector` boundary: no new Docker capability. Throws a
     * `StackError` (409/503) when the port cannot be proven eligible.
     */
    async function requireLoopbackPort(project: string, service: string, port: number): Promise<void> {
        const read = await readPublishedPorts(project, service);
        if (read.kind === "no-answer") {
            throw new StackError("Docker did not respond, so the upstream port could not be checked. Nothing was changed.", 503);
        }
        if (read.kind === "bad-answer") {
            throw new StackError("Docker gave an unexpected answer, so the upstream port could not be checked. Nothing was changed.", 503);
        }
        if (read.running === 0) {
            throw new StackError(
                "This service has no running container, so there is no upstream port to check. Start the stack first.",
                409,
            );
        }
        if (read.ports.some(({ binding }) => matchesGeneratedUpstream(binding.container, binding.host, port))) return;
        if (read.inspected === 0) {
            throw new StackError("Docker did not respond, so the upstream port could not be checked. Nothing was changed.", 503);
        }
        throw new StackError("This port is not published on 127.0.0.1 (TCP) by this service. Only such ports can be attached.", 409);
    }

    /**
     * Published port bindings of the running containers of a project,
     * optionally narrowed to one service. Read-only, through the existing
     * `ContainerInspector` boundary; at most 16 containers are inspected.
     */
    async function readPublishedPorts(project: string, service: string | null): Promise<PublishedPortsRead> {
        let summaries;
        try {
            const listed = await inspector.list();
            if (listed.code !== 0 || listed.timedOut) return { kind: "no-answer" };
            summaries = parseContainerLs(listed.stdout);
        } catch {
            return { kind: "bad-answer" };
        }
        const candidates = summaries
            .filter(
                (entry) =>
                    entry.project === project &&
                    entry.service !== null &&
                    (service === null || entry.service === service) &&
                    entry.state.toLowerCase() === "running",
            )
            .slice(0, 16);
        let inspected = 0;
        const ports: { service: string; binding: ContainerPort }[] = [];
        for (const candidate of candidates) {
            let details;
            try {
                const result = await inspector.inspect(candidate.id);
                if (result.code !== 0 || result.timedOut) continue;
                details = parseContainerInspect(result.stdout);
            } catch {
                continue;
            }
            inspected += 1;
            for (const binding of details.ports) ports.push({ service: candidate.service ?? "", binding });
        }
        return { kind: "ok", running: candidates.length, inspected, ports };
    }

    /**
     * Call timeout for attach/detach. Never below the helper's own deadline
     * with its default per-command timeout (135 s, `helperDeadlineMs`) plus
     * slack, so the panel does not give up while the helper is still inside
     * a rollback. A longer helper budget configured on the host only makes
     * the outcome reported as unknown, never as success.
     */
    function caddyMutationTimeoutMs(): number {
        return Math.max(config.operationTimeoutMs, CADDY_MUTATION_MIN_TIMEOUT_MS);
    }

    /** Map a helper refusal code to an honest HTTP status. */
    function helperRefusalStatus(code: string): number {
        switch (code) {
            case "invalid":
                return 400;
            case "conflict":
                return 409;
            case "unavailable":
                return 503;
            default:
                return 500;
        }
    }

    /**
     * Notice text for a helper refusal. Only `invalid` and `conflict` are
     * refusals before any change; every other code already states its own
     * outcome (applied nothing, restored, or unknown), which a blanket
     * "nothing was changed" suffix would contradict.
     */
    function helperRefusalText(outcome: { error: string; code: string }, suffix: string): string {
        return outcome.code === "invalid" || outcome.code === "conflict" ? `${outcome.error} ${suffix}` : outcome.error;
    }

    /**
     * Declared deployment owner (`stack.managed-by`), if Docker can tell.
     * Informational by design (ADR 0025): an unreadable declaration means no
     * owner, never a block. Callers re-check under the per-stack lock where
     * the decision must not move between the check and the mutation.
     */
    async function readStackOwner(name: string): Promise<string | null> {
        try {
            const detail = await loadStackDetail(stacksRoot, name, provider);
            return managedBy(detail.declared);
        } catch {
            return null;
        }
    }

    /**
     * Attach a domain (ADR 0030). Same guards as every mutation (session,
     * Origin, CSRF, per-stack lock, shutdown/self-update refusal, audit), then
     * fail-closed Docker checks resolved under the per-stack lock: the stack
     * must be deployed, the service must belong to its effective config, and
     * the port must be loopback-published by a running container. The helper
     * re-validates the request fields under its own global lock before
     * publishing and reloading.
     */
    async function handleCaddyAttach(request: Request, name: string, session: Session): Promise<Response> {
        const csrf = session.csrf;
        const back = `/stacks/${encodeURIComponent(name)}`;
        if (!config.caddyEnabled || !config.caddySocketPath) throw new StackError("Domain management is not enabled.", 404);
        if (!isAllowedOrigin(request, config)) return staleForm(csrf, back);
        const form = await readForm(request);
        if (form === null) return tooLarge(csrf, back);
        if (!safeEqual(form.get("csrf") ?? "", csrf)) return staleForm(csrf, back);
        // The body may have arrived long after the session was checked.
        if (!sessions.isActive(session.id)) return sessionEnded();

        const domain = (form.get("domain") ?? "").trim().slice(0, 253);
        const serviceParam = (form.get("service") ?? "").trim().slice(0, 64);
        const portText = (form.get("port") ?? "").trim().slice(0, 5);
        const prefill = new URLSearchParams({ caddyDomain: domain, caddyService: serviceParam, caddyPort: portText });
        const fail = (text: string, status: number): Promise<Response> =>
            renderStackDetail(name, csrf, { kind: "error", text }, status, prefill);
        const actor = clientKey(request, config);
        if (!isValidDomain(domain)) {
            await recordAudit({ event: "caddy", result: "refused", actor, stack: name, action: "attach", detail: "invalid domain" });
            return fail("This domain is not valid. Nothing was attached.", 400);
        }
        if (!isValidServiceName(serviceParam)) {
            await recordAudit({ event: "caddy", result: "refused", actor, stack: name, action: "attach", detail: "invalid service" });
            return fail("This service name is not valid. Nothing was attached.", 400);
        }
        const port = Number(portText);
        if (!isValidUpstreamPort(port)) {
            await recordAudit({ event: "caddy", result: "refused", actor, stack: name, action: "attach", detail: "invalid port" });
            return fail("This port is not valid. Nothing was attached.", 400);
        }
        try {
            // Joins the shared shutdown drain like saves: a SIGTERM waits for
            // the helper call instead of cutting it mid-reload. Every Docker
            // check below runs inside the per-stack lock: owner, project
            // identity, service membership and the loopback port are
            // re-resolved at mutation time, so a concurrent save or operation
            // cannot render them stale between inspection and the helper call.
            const task = locks.run(name, async () => {
                if (shuttingDown) throw new OperationsDisabledError();
                if (selfUpdatePending) throw new OperationsDisabledError(SELF_UPDATE_RUNNING);
                if (!sessions.isActive(session.id)) throw new SessionEndedError();
                const innerOwner: string | null = await readStackOwner(name);
                if (innerOwner) {
                    throw new StackError("Routing for this stack is managed externally. Nothing was attached.", 409);
                }
                const innerContext = await resolveProjectContext(stacksRoot, name, provider, false);
                if (innerContext.kind === "invalid") throw new StackError(ENV_NOT_REGULAR, 409);
                if (innerContext.kind === "ambiguous") {
                    throw new StackError(
                        "The panel cannot tell which Docker Compose project belongs to this stack. It will not guess, so nothing was attached.",
                        409,
                    );
                }
                if (innerContext.kind === "unavailable") {
                    throw new StackError("Docker did not respond, so the panel could not check this stack. Nothing was attached.", 503);
                }
                if (innerContext.kind === "absent") {
                    throw new StackError("This stack is not deployed yet. Use Up first, then attach the domain.", 409);
                }
                const innerNames = await provider.listServices({
                    project: innerContext.project ?? undefined,
                    composeFile: innerContext.composeFile,
                    cwd: innerContext.cwd,
                    envFile: innerContext.envFile ?? undefined,
                });
                if (innerNames === null)
                    throw new StackError("Docker did not respond, so the service could not be checked. Nothing was attached.", 503);
                if (!innerNames.includes(serviceParam)) {
                    throw new StackError("This service is not part of this stack. Nothing was attached.", 409);
                }
                await requireLoopbackPort(innerContext.project ?? name, serviceParam, port);
                return callCaddyHelper(
                    config.caddySocketPath!,
                    { action: "attach", domain, stack: name, service: serviceParam, port },
                    { timeoutMs: caddyMutationTimeoutMs() },
                );
            });
            saves.add(task);
            let outcome: Awaited<typeof task>;
            try {
                outcome = await task;
            } finally {
                saves.delete(task);
            }
            if (!outcome.ok) {
                const result =
                    outcome.code === "invalid" || outcome.code === "conflict"
                        ? "refused"
                        : outcome.code === "unknown"
                          ? "unknown"
                          : "failure";
                await recordAudit({
                    event: "caddy",
                    result,
                    actor,
                    stack: name,
                    action: "attach",
                    service: serviceParam,
                    detail: `${normalizeDomain(domain)}: ${outcome.code}`,
                });
                return fail(helperRefusalText(outcome, "Nothing was attached."), helperRefusalStatus(outcome.code));
            }
            await recordAudit({
                event: "caddy",
                result: "success",
                actor,
                stack: name,
                action: "attach",
                service: serviceParam,
                detail: normalizeDomain(domain) ?? domain,
            });
            return redirect(`${back}?attached=1`, 303);
        } catch (error) {
            if (error instanceof CaddyHelperError) {
                await recordAudit({
                    event: "caddy",
                    result: "unknown",
                    actor,
                    stack: name,
                    action: "attach",
                    service: serviceParam,
                    detail: "helper unreachable",
                });
                return fail("The Caddy helper did not answer. Check the helper socket on the host: the outcome is unknown.", 503);
            }
            if (error instanceof StackError) {
                await recordAudit({
                    event: "caddy",
                    result: "refused",
                    actor,
                    stack: name,
                    action: "attach",
                    service: serviceParam,
                    detail: error.message,
                });
                return fail(`${error.message}`, error.status);
            }
            if (error instanceof StackBusyError || error instanceof OperationsDisabledError) {
                await recordAudit({
                    event: "caddy",
                    result: "refused",
                    actor,
                    stack: name,
                    action: "attach",
                    service: serviceParam,
                    detail: error.message,
                });
                return fail(`${error.message} Nothing was attached.`, 409);
            }
            if (error instanceof SessionEndedError) {
                await recordAudit({
                    event: "caddy",
                    result: "refused",
                    actor,
                    stack: name,
                    action: "attach",
                    service: serviceParam,
                    detail: "session ended",
                });
                return sessionEnded();
            }
            throw error;
        }
    }

    /**
     * Detach a domain (ADR 0030). The first POST renders an explicit
     * confirmation (works without JavaScript); the confirmed POST removes the
     * managed file and reloads Caddy through the helper, with rollback on
     * reload failure. The domain must be attached to this stack right now.
     */
    async function handleCaddyDetach(request: Request, name: string, session: Session): Promise<Response> {
        const csrf = session.csrf;
        const back = `/stacks/${encodeURIComponent(name)}`;
        if (!config.caddyEnabled || !config.caddySocketPath) throw new StackError("Domain management is not enabled.", 404);
        if (!isAllowedOrigin(request, config)) return staleForm(csrf, back);
        const form = await readForm(request);
        if (form === null) return tooLarge(csrf, back);
        if (!safeEqual(form.get("csrf") ?? "", csrf)) return staleForm(csrf, back);
        if (!sessions.isActive(session.id)) return sessionEnded();

        const rawDomain = (form.get("domain") ?? "").trim().slice(0, 253);
        const domain = normalizeDomain(rawDomain);
        const actor = clientKey(request, config);
        if (!domain || !isValidDomain(domain)) {
            await recordAudit({ event: "caddy", result: "refused", actor, stack: name, action: "detach", detail: "invalid domain" });
            return renderStackDetail(name, csrf, { kind: "error", text: "This domain is not valid. Nothing was detached." }, 400);
        }
        if (form.get("confirm") !== "1") {
            // The confirmation is only offered for a domain attached to this
            // stack right now. The confirmed POST skips this read: the helper
            // re-checks attachment and ownership under its own lock anyway.
            let attached: { domain: string; service: string; port: number }[] = [];
            try {
                const response = await callCaddyHelper(config.caddySocketPath, { action: "status" }, { timeoutMs: config.dockerTimeoutMs });
                if (response.ok && response.action === "status") {
                    attached = response.sites.filter((site) => site.stack === name);
                }
            } catch {
                await recordAudit({
                    event: "caddy",
                    result: "failure",
                    actor,
                    stack: name,
                    action: "detach",
                    detail: `${domain}: helper unreachable`,
                });
                return renderStackDetail(
                    name,
                    csrf,
                    { kind: "error", text: "The Caddy helper did not answer. Check the helper socket on the host. Nothing was detached." },
                    503,
                );
            }
            if (!attached.some((entry) => entry.domain === domain)) {
                await recordAudit({
                    event: "caddy",
                    result: "refused",
                    actor,
                    stack: name,
                    action: "detach",
                    detail: `${domain}: not attached`,
                });
                return renderStackDetail(
                    name,
                    csrf,
                    { kind: "error", text: "This domain is not attached to this stack. Nothing was detached." },
                    409,
                );
            }
            if (await readStackOwner(name)) {
                await recordAudit({
                    event: "caddy",
                    result: "refused",
                    actor,
                    stack: name,
                    action: "detach",
                    detail: `${domain}: managed externally`,
                });
                return renderStackDetail(
                    name,
                    csrf,
                    { kind: "error", text: "Routing for this stack is managed externally. Nothing was detached." },
                    409,
                );
            }
            return renderStackDetail(name, csrf, { kind: "warn", text: `Detach ${domain}? Caddy will reload without it.` }, 200, null, {
                confirmDetach: domain,
            });
        }
        try {
            // Joins the shared shutdown drain like saves and attaches.
            const task = locks.run(name, async () => {
                if (shuttingDown) throw new OperationsDisabledError();
                if (selfUpdatePending) throw new OperationsDisabledError(SELF_UPDATE_RUNNING);
                if (!sessions.isActive(session.id)) throw new SessionEndedError();
                // Re-checked under the lock: the read-only rule for externally
                // managed stacks must hold at mutation time, not just when the
                // confirmation was rendered.
                if (await readStackOwner(name)) {
                    throw new StackError("Routing for this stack is managed externally. Nothing was detached.", 409);
                }
                return callCaddyHelper(
                    config.caddySocketPath!,
                    { action: "detach", domain, stack: name },
                    { timeoutMs: caddyMutationTimeoutMs() },
                );
            });
            saves.add(task);
            let outcome: Awaited<typeof task>;
            try {
                outcome = await task;
            } finally {
                saves.delete(task);
            }
            if (!outcome.ok) {
                const result =
                    outcome.code === "invalid" || outcome.code === "conflict"
                        ? "refused"
                        : outcome.code === "unknown"
                          ? "unknown"
                          : "failure";
                await recordAudit({ event: "caddy", result, actor, stack: name, action: "detach", detail: `${domain}: ${outcome.code}` });
                return renderStackDetail(
                    name,
                    csrf,
                    { kind: "error", text: helperRefusalText(outcome, "Nothing was detached.") },
                    helperRefusalStatus(outcome.code),
                );
            }
            await recordAudit({ event: "caddy", result: "success", actor, stack: name, action: "detach", detail: domain });
            return redirect(`${back}?detached=1`, 303);
        } catch (error) {
            if (error instanceof StackError) {
                await recordAudit({ event: "caddy", result: "refused", actor, stack: name, action: "detach", detail: error.message });
                return renderStackDetail(name, csrf, { kind: "error", text: error.message }, error.status);
            }
            if (error instanceof CaddyHelperError) {
                await recordAudit({
                    event: "caddy",
                    result: "unknown",
                    actor,
                    stack: name,
                    action: "detach",
                    detail: `${domain}: helper unreachable`,
                });
                return renderStackDetail(
                    name,
                    csrf,
                    {
                        kind: "error",
                        text: "The Caddy helper did not answer. Check the helper socket on the host: the outcome is unknown.",
                    },
                    503,
                );
            }
            if (error instanceof StackBusyError || error instanceof OperationsDisabledError) {
                await recordAudit({ event: "caddy", result: "refused", actor, stack: name, action: "detach", detail: error.message });
                return renderStackDetail(name, csrf, { kind: "error", text: `${error.message} Nothing was detached.` }, 409);
            }
            if (error instanceof SessionEndedError) {
                await recordAudit({ event: "caddy", result: "refused", actor, stack: name, action: "detach", detail: "session ended" });
                return sessionEnded();
            }
            throw error;
        }
    }

    async function renderAbout(
        csrf: string,
        options: { notice?: { kind: NoteKind; text: string }; error?: { title: string; message: string }; status?: number } = {},
    ): Promise<Response> {
        const status = await selfUpdater.status();
        const output = status.lastRun.kind === "run" ? await selfUpdater.output() : null;
        return htmlResponse(
            aboutPage({
                csrf,
                access,
                timezone: config.timeZone || undefined,
                status,
                output: output === null ? null : stripAnsi(output),
                pending: selfUpdatePending,
                notice: options.notice,
                error: options.error,
                nav: await sidebarNav("about"),
            }),
            options.status ?? 200,
        );
    }

    /** Refusal shared by both self-update forms, or null when the panel is idle. */
    function selfUpdateBusy(): string | null {
        if (shuttingDown) return "The panel is shutting down.";
        if (selfUpdatePending) return "An update is already running.";
        if (selfUpdateChecking) return "A check for updates is already running.";
        return null;
    }

    /** Pull the panel's own tag (ADR 0018). Touches no container. */
    async function handleSelfUpdateCheck(request: Request, session: Session): Promise<Response> {
        const csrf = session.csrf;
        if (!isAllowedOrigin(request, config)) return staleForm(csrf, "/about");
        const form = await readForm(request);
        if (form === null) return tooLarge(csrf, "/about");
        if (!safeEqual(form.get("csrf") ?? "", csrf)) return staleForm(csrf, "/about");
        if (!sessions.isActive(session.id)) return sessionEnded();
        const actor = clientKey(request, config);
        const busy = selfUpdateBusy();
        if (busy) {
            await recordAudit({ event: "self-update-check", result: "refused", actor, detail: busy });
            return renderAbout(csrf, { error: { title: "Nothing was checked.", message: busy }, status: 409 });
        }
        selfUpdateChecking = true;
        try {
            const support = await selfUpdater.identify();
            if (support.kind !== "ready") {
                await recordAudit({ event: "self-update-check", result: "refused", actor, detail: "self-update unavailable" });
                return renderAbout(csrf, { status: 409 });
            }
            // Identification awaited Docker: re-check right before the pull.
            if (!sessions.isActive(session.id)) {
                await recordAudit({ event: "self-update-check", result: "refused", actor, detail: "session ended" });
                return sessionEnded();
            }
            if (shuttingDown) {
                await recordAudit({ event: "self-update-check", result: "refused", actor, detail: "shutting down" });
                return renderAbout(csrf, { error: { title: "Nothing was checked.", message: "The panel is shutting down." }, status: 503 });
            }
            const pulled = await selfUpdater.pull(support.identity);
            if (pulled.code !== 0 || pulled.timedOut) {
                const reason = pulled.timedOut
                    ? "the download did not finish in time"
                    : (
                          pulled.stderr
                              .split("\n")
                              .map((line) => line.trim())
                              .find(Boolean) ?? ""
                      ).slice(0, 300);
                await recordAudit({
                    event: "self-update-check",
                    result: "failure",
                    actor,
                    detail: pulled.timedOut ? "timed out" : `exit code ${pulled.code}`,
                });
                return renderAbout(csrf, {
                    error: {
                        title: "Check failed.",
                        message: `Docker could not download ${support.identity.imageRef}${reason ? `: ${reason}` : "."}`,
                    },
                    status: 502,
                });
            }
            // A newer image is downloaded: ask its release whether it may be
            // installed (ADR 0018). The verdict is shown on the About page.
            const status = await selfUpdater.status();
            const verdict = status.available ? await selfUpdater.verifyRelease(status.available) : null;
            await recordAudit({
                event: "self-update-check",
                result: "success",
                actor,
                detail: verdict ? `release ${verdict.kind}` : "nothing newer",
            });
            return redirect("/about?checked=1", 303);
        } finally {
            selfUpdateChecking = false;
        }
    }

    /** Start the one-shot updater (ADR 0018) once nothing else is running. */
    async function handleSelfUpdateStart(request: Request, session: Session): Promise<Response> {
        const csrf = session.csrf;
        if (!isAllowedOrigin(request, config)) return staleForm(csrf, "/about");
        const form = await readForm(request);
        if (form === null) return tooLarge(csrf, "/about");
        if (!safeEqual(form.get("csrf") ?? "", csrf)) return staleForm(csrf, "/about");
        if (!sessions.isActive(session.id)) return sessionEnded();
        const actor = clientKey(request, config);
        const target = form.get("target") ?? "";
        const refuse = async (message: string, status = 409): Promise<Response> => {
            await recordAudit({ event: "self-update", result: "refused", actor, detail: message });
            return renderAbout(csrf, { error: { title: "Not updated.", message: `${message} Nothing was changed.` }, status });
        };
        if (!isImageId(target)) return refuse("The update form is not valid. Reload the page and try again.", 400);
        const busy = selfUpdateBusy();
        if (busy) return refuse(busy);
        if (operations.activeCount() > 0 || saves.size > 0) {
            return refuse("An action or a save is still running. Wait for it to finish, then update.");
        }
        // A stack lock can outlive its operation when the process exit was not
        // confirmed: restarting the panel would drop that guard, so refuse.
        if (locks.hasActive()) {
            return refuse(
                "A stack is still locked by an action whose end Docker did not confirm. Check the stack on the host, then restart the panel from the host if needed.",
            );
        }
        // Synchronously, before any await: from here on no action, save or
        // purge can start until the updater ends or the panel is replaced.
        selfUpdatePending = true;
        let started = false;
        try {
            const status = await selfUpdater.status();
            if (status.support.kind !== "ready") return await refuse(status.support.reason);
            if (!status.available) return await refuse("No newer image is ready. Check for updates first.");
            if (status.available.imageId !== target)
                return await refuse("The image changed since this page was loaded. Review the update again.");
            // Fresh release check, never the cached one: the 72-hour period and
            // the digest are enforced here, with no bypass (ADR 0018).
            const verdict = await selfUpdater.verifyRelease(status.available);
            if (verdict.kind === "refused") return await refuse(verdict.reason);
            if (verdict.kind === "waiting")
                return await refuse(
                    `Release ${verdict.version} becomes installable on ${new Date(verdict.installableAt).toISOString().slice(0, 16).replace("T", " ")} UTC.`,
                );
            // Status awaited Docker and GitHub: re-check right before the
            // mutation. Once the updater runs it is not cancelled, like an
            // accepted stack action.
            if (!sessions.isActive(session.id)) {
                await recordAudit({ event: "self-update", result: "refused", actor, detail: "session ended" });
                return sessionEnded();
            }
            // A shutdown may have begun while Docker and GitHub were awaited.
            if (shuttingDown) return await refuse("The panel is shutting down.", 503);
            const launched = await selfUpdater.launch(status.support.identity, {
                targetImageId: target,
                expectedDigest: verdict.expectedDigest,
                targetVersion: verdict.version,
                previousVersion: status.current?.version ?? null,
            });
            // From here the updater may be running: mutations stay paused until
            // Docker confirms it ended or never started, even if the start
            // command itself failed or timed out.
            started = true;
            void selfUpdater.settle().finally(() => {
                selfUpdatePending = false;
            });
            const detail = `${status.support.identity.imageRef} ${verdict.version}`;
            if (launched === "unconfirmed") {
                await recordAudit({ event: "self-update", result: "unknown", actor, detail: `${detail}, start not confirmed` });
                return renderAbout(csrf, {
                    error: {
                        title: "Update outcome unknown.",
                        message:
                            "Docker did not confirm whether the updater started. Actions stay paused until Docker shows it ended or never started. Check docker ps on the host if this lasts.",
                    },
                    status: 503,
                });
            }
            await recordAudit({ event: "self-update", result: "started", actor, detail });
            return redirect("/about", 303);
        } catch (error) {
            if (error instanceof SelfUpdateError) return await refuse(error.message.replace(/ Nothing was changed\.$/, ""), error.status);
            throw error;
        } finally {
            if (!started) selfUpdatePending = false;
        }
    }

    function operationSnapshot(operation: OperationView): string {
        return JSON.stringify({
            status: operation.status,
            exitCode: operation.exitCode,
            timedOut: operation.timedOut,
            truncated: operation.truncated,
            startedAt: operation.startedAt,
            endedAt: operation.endedAt,
            source: operation.source ?? null,
            output: operation.output,
        });
    }

    function operationDone(operation: OperationView): string {
        return JSON.stringify({
            status: operation.status,
            exitCode: operation.exitCode,
            timedOut: operation.timedOut,
            truncated: operation.truncated,
            startedAt: operation.startedAt,
            endedAt: operation.endedAt,
            source: operation.source ?? null,
        });
    }

    /**
     * Build an SSE response around a subscription. The subscriber limit bounds
     * concurrent streams; heartbeat keeps idle streams alive through proxies;
     * the timeout bounds stream lifetime; a full buffer drops slow readers so
     * one stuck client cannot grow server memory without bound.
     */
    function sseResponse(
        request: Request,
        wire: (send: (frame: string) => void, close: () => void) => () => void,
        guard?: { id: string; isAlive: () => boolean },
    ): Response {
        if (activeSse >= config.sseMaxSubscribers) return plain("Too many subscriptions", 503);
        activeSse += 1;
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            activeSse -= 1;
        };
        let cleanup = () => {};
        let doClose = () => {};
        let startError: unknown = null;
        let startFailed = false;
        const stream = new ReadableStream<Uint8Array>(
            {
                start(controller) {
                    const encoder = new TextEncoder();
                    let closed = false;
                    const close = () => {
                        if (closed) return;
                        closed = true;
                        if (guard) unregisterStream(guard.id, close);
                        try {
                            cleanup();
                        } catch {
                            /* ignore */
                        }
                        clearInterval(heartbeat);
                        clearTimeout(timeout);
                        release();
                        try {
                            controller.close();
                        } catch {
                            /* already closed */
                        }
                    };
                    doClose = close;
                    const send = (frame: string) => {
                        if (closed) return;
                        // Backpressure: drop a reader that stopped consuming instead of
                        // buffering large log volumes for it indefinitely.
                        if (controller.desiredSize !== null && controller.desiredSize <= 0) {
                            close();
                            return;
                        }
                        try {
                            controller.enqueue(encoder.encode(frame));
                        } catch {
                            close();
                        }
                    };
                    const heartbeat = setInterval(() => {
                        // Expiry check must not itself refresh idle activity, so a
                        // stream cannot keep a session alive past its limits.
                        if (guard && !guard.isAlive()) {
                            close();
                            return;
                        }
                        send(formatSseHeartbeat());
                    }, config.sseHeartbeatMs);
                    const timeout = setTimeout(close, config.sseTimeoutMs);
                    const onAbort = () => close();
                    if (request.signal.aborted) {
                        close();
                        return;
                    }
                    request.signal.addEventListener("abort", onAbort, { once: true });
                    try {
                        if (guard) registerStream(guard.id, close);
                        cleanup = wire(send, close);
                    } catch (error) {
                        // A synchronous subscription refusal (e.g. server shutting
                        // down) must surface as an error status, not an empty 200
                        // stream. start() runs synchronously, so rethrow below.
                        startFailed = true;
                        startError = error;
                        close();
                    }
                },
                cancel() {
                    doClose();
                },
            },
            { highWaterMark: 64 },
        );
        if (startFailed) throw startError;
        return new Response(stream, { headers: sseHeaders() });
    }

    async function handleOperationEvents(name: string, request: Request, sessionId: string): Promise<Response> {
        // Validates the name and rejects unknown stacks before a slot is taken.
        await locateComposeFile(stacksRoot, name);
        // The session may have been revoked while we awaited: re-check
        // synchronously before subscribing so a logout during discovery cannot
        // let the stream register and keep receiving data.
        if (!sessions.isActive(sessionId)) return plain("Unauthorized", 401);
        const guard = { id: sessionId, isAlive: () => sessions.isActive(sessionId) };
        return sseResponse(
            request,
            (send, close) => {
                let sentOutput = "";
                let sentTerminal = false;
                const sub = operations.subscribe(name, (operation) => {
                    const full = operation.output;
                    if (full.length >= sentOutput.length && full.startsWith(sentOutput)) {
                        const delta = full.slice(sentOutput.length);
                        sentOutput = full;
                        if (delta) send(formatSseEvent("output", JSON.stringify({ text: delta })));
                    } else {
                        sentOutput = full;
                        send(formatSseEvent("snapshot", operationSnapshot(operation)));
                        return;
                    }
                    if (operation.status !== "running" && !sentTerminal) {
                        sentTerminal = true;
                        send(formatSseEvent("done", operationDone(operation)));
                        close();
                    }
                });
                sentOutput = sub.snapshot?.output ?? "";
                if (sub.snapshot) send(formatSseEvent("snapshot", operationSnapshot(sub.snapshot)));
                else send(formatSseEvent("snapshot", JSON.stringify({ status: "none" })));
                return sub.unsubscribe;
            },
            guard,
        );
    }

    async function handleLogsEvents(name: string, request: Request, sessionId: string): Promise<Response> {
        // Same fail-closed context as mutations: a follow without a verified
        // project could attach to the wrong one. An undeployed stack simply
        // yields an empty/ended stream.
        const context = await resolveProjectContext(stacksRoot, name, provider);
        if (context.kind === "invalid") {
            throw new StackError(ENV_NOT_REGULAR, 409);
        }
        if (context.kind === "ambiguous") {
            throw new StackError("Several Docker Compose projects match this stack. The panel will not guess which logs to follow.", 409);
        }
        if (context.kind === "unavailable") {
            throw new StackError("Docker did not respond, so the panel could not check which project's logs to follow.", 503);
        }
        if (shuttingDown) throw new StackError("The panel is shutting down and no longer starts log streams.", 503);
        const query = new URL(request.url).searchParams;
        // Re-check the session after the awaited discovery, before subscribing.
        if (!sessions.isActive(sessionId)) return plain("Unauthorized", 401);
        const guard = { id: sessionId, isAlive: () => sessions.isActive(sessionId) };
        if (context.kind === "absent") {
            return sseResponse(
                request,
                (send, close) => {
                    send(formatSseEvent("replay", JSON.stringify({ text: "", truncated: false })));
                    send(formatSseEvent("end", "This stack is not deployed yet, so there are no logs."));
                    close();
                    return () => {};
                },
                guard,
            );
        }
        const selection = await resolveLogSelection(
            {
                project: context.project ?? undefined,
                composeFile: context.composeFile,
                cwd: context.cwd,
                envFile: context.envFile ?? undefined,
            },
            query.get("service"),
            query.get("tail"),
        );
        // The selection awaits Docker too: re-check before subscribing.
        if (!sessions.isActive(sessionId)) return plain("Unauthorized", 401);
        const target = {
            project: context.project ?? undefined,
            composeFile: context.composeFile,
            cwd: context.cwd,
            envFile: context.envFile ?? undefined,
            service: selection.service ?? undefined,
            tailLines: selection.tailLines,
        };
        return sseResponse(
            request,
            (send, close) => {
                const sub = logs.subscribe(
                    name,
                    target,
                    (chunk) => send(formatSseEvent("chunk", JSON.stringify({ text: chunk }))),
                    (reason) => {
                        send(
                            formatSseEvent(
                                "end",
                                reason === "timeout"
                                    ? `Stopped following after ${Math.round(config.logTimeoutMs / 60000)} minutes (time limit). Click Follow logs to continue.`
                                    : "The log stream ended, usually because the containers stopped.",
                            ),
                        );
                        close();
                    },
                );
                send(formatSseEvent("replay", JSON.stringify({ text: sub.replay.text, truncated: sub.replay.truncated })));
                return sub.unsubscribe;
            },
            guard,
        );
    }

    /**
     * Validate `?service=` against the effective config and `?tail=` against
     * the allow-list (ADR 0020). A refused selection throws before any `logs`
     * subprocess is spawned; the discovery call itself is expected.
     */
    async function resolveLogSelection(
        base: { project?: string; composeFile: string; cwd: string; envFile?: string },
        serviceParam: string | null,
        tailParam: string | null,
    ): Promise<{ service: string | null; tailLines: number }> {
        let service: string | null = null;
        const raw = (serviceParam ?? "").trim();
        if (raw !== "") {
            if (!isComposeServiceName(raw)) {
                throw new StackError("This service selection is not valid. Nothing was started.", 400);
            }
            const names = await provider.listServices(base);
            if (names === null) {
                throw new StackError("Docker did not respond, so the panel could not check which services this stack defines.", 503);
            }
            if (!names.includes(raw)) {
                throw new StackError("This stack defines no such service. Nothing was started.", 409);
            }
            service = raw;
        }
        const tail = tailParam !== null && /^\d+$/.test(tailParam) ? Number(tailParam) : NaN;
        return { service, tailLines: (COMPOSE_LOG_TAIL_OPTIONS as readonly number[]).includes(tail) ? tail : config.logTailLines };
    }

    /**
     * Bounded one-shot log history for the stack page. Same fail-closed project
     * context as the follow, but no subprocess is left running. Returns plain
     * text so the page can show it inline and a browser without JavaScript can
     * open the same URL. Docker stderr is never echoed (logs may hold secrets):
     * failures get a fixed message.
     */
    async function handleLogsSnapshot(name: string, sessionId: string, query: URLSearchParams): Promise<Response> {
        // An unknown or invalid stack name is a plain-text refusal, not an
        // HTML error page: this endpoint always answers `text/plain`.
        let context: Awaited<ReturnType<typeof resolveProjectContext>>;
        try {
            context = await resolveProjectContext(stacksRoot, name, provider);
        } catch (error) {
            if (error instanceof StackError) return plain(error.message, error.status);
            throw error;
        }
        if (context.kind === "invalid") return plain(ENV_NOT_REGULAR, 409);
        if (context.kind === "ambiguous") {
            return plain("Several Docker Compose projects match this stack. The panel will not guess which logs to read.", 409);
        }
        if (context.kind === "unavailable") {
            return plain("Docker did not respond, so the panel could not read this stack's logs.", 503);
        }
        if (context.kind === "absent") return plain("This stack is not deployed yet, so there are no logs.", 200);
        // Re-check the session after the awaited discovery.
        if (!sessions.isActive(sessionId)) return plain("Unauthorized", 401);
        let selection: Awaited<ReturnType<typeof resolveLogSelection>>;
        try {
            selection = await resolveLogSelection(
                {
                    project: context.project ?? undefined,
                    composeFile: context.composeFile,
                    cwd: context.cwd,
                    envFile: context.envFile ?? undefined,
                },
                query.get("service"),
                query.get("tail"),
            );
        } catch (error) {
            if (error instanceof StackError) return plain(error.message, error.status);
            throw error;
        }
        // The selection awaits Docker too: re-check before reading.
        if (!sessions.isActive(sessionId)) return plain("Unauthorized", 401);
        const target = {
            project: context.project ?? undefined,
            composeFile: context.composeFile,
            cwd: context.cwd,
            envFile: context.envFile ?? undefined,
            service: selection.service ?? undefined,
            tailLines: selection.tailLines,
            timeoutMs: config.dockerTimeoutMs,
            maxBytes: config.logMaxBytes,
        };
        let result: Awaited<ReturnType<ComposeProvider["readLogs"]>>;
        try {
            result = await provider.readLogs(target);
        } catch {
            return plain("Docker could not read these logs. Reload the page to try again.", 502);
        }
        if (result.timedOut) return plain("Docker did not respond in time. Reload the page to try again.", 504);
        if (result.code !== 0)
            return plain("Docker could not read these logs. The stack or its containers may have changed; reload the page.", 502);
        const text = stripAnsi(result.stdout).replace(/\s+$/, "");
        if (!text) return plain("No recent logs for this stack.", 200);
        return plain(result.truncated ? `${text}\n\n[Output shortened: only the most recent part is kept.]` : text, 200);
    }

    const TOOLBOX_OFFLINE = "Docker did not respond, so the panel could not check this source.";

    interface ToolboxRuntime {
        imageId: string;
        workdir: string | null;
    }

    /** Minimal, fixed projection of one container: image ID and working dir. */
    async function containerRuntime(id: string): Promise<ToolboxRuntime | null> {
        let result: Awaited<ReturnType<ContainerInspector["inspect"]>>;
        try {
            result = await inspector.inspect(id);
        } catch {
            return null;
        }
        if (result.code !== 0 || result.timedOut || result.truncated) return null;
        try {
            const rows = JSON.parse(result.stdout) as unknown;
            const row = Array.isArray(rows) ? (rows[0] as Record<string, unknown>) : null;
            const imageId = row && typeof row["Image"] === "string" ? row["Image"] : null;
            if (!imageId) return null;
            const config =
                row && typeof row["Config"] === "object" && row["Config"] !== null ? (row["Config"] as Record<string, unknown>) : null;
            const configured = config ? config["WorkingDir"] : undefined;
            const workdir = typeof configured === "string" && configured !== "" ? configured : null;
            return { imageId, workdir };
        } catch {
            return null;
        }
    }

    function toolboxLimits(): { maxActions: number; maxTimeoutMs: number } {
        return { maxActions: config.toolboxMaxActions, maxTimeoutMs: config.toolboxMaxTimeoutMs };
    }

    function toolboxManifestPath(source: ToolboxSource, runtime: ToolboxRuntime): string {
        return posix.join(source.workdir ?? runtime.workdir ?? "/", source.manifestFile);
    }

    function toolboxFileFailure(kind: "too-large" | "not-file" | "error", filename: string): string {
        if (kind === "too-large") return `The ${filename} is larger than the panel reads.`;
        if (kind === "not-file") return `The ${filename} is not a regular file (a directory or symbolic link is refused).`;
        return `The panel could not read the ${filename} from the container.`;
    }

    /** One source's catalog, or the reason it cannot be used right now. */
    async function discoverToolboxSource(source: ToolboxSource, context: ProjectContext): Promise<ToolboxSourceView> {
        const base = { id: source.id, service: source.service, runner: source.runner, workdir: source.workdir, user: source.user };
        const off = (unavailable: string): ToolboxSourceView => ({ ...base, revision: null, actions: [], unavailable });
        if (context.kind === "invalid") return off(ENV_NOT_REGULAR);
        if (context.kind === "ambiguous") return off("Several Docker Compose projects match this stack, so the panel will not choose one.");
        if (context.kind === "unavailable") return off(TOOLBOX_OFFLINE);
        if (context.kind === "absent") return off("This stack is not deployed yet, so there is no container to run actions in.");
        const ids = await provider.runningContainerIds({
            project: context.project!,
            composeFile: context.composeFile,
            cwd: context.cwd,
            service: source.service,
            envFile: context.envFile ?? undefined,
        });
        if (ids === null) return off(TOOLBOX_OFFLINE);
        if (ids.length === 0) return off(`Service "${source.service}" is not running, so its actions are unavailable.`);
        if (ids.length > 1) return off(`Service "${source.service}" has several running containers; the toolbox needs exactly one.`);
        const id = ids[0]!;
        const runtime = await containerRuntime(id);
        if (!runtime) return off("The panel could not read this container's details from Docker.");
        const file = await actionRunner.readFile(id, toolboxManifestPath(source, runtime), {
            timeoutMs: config.dockerTimeoutMs,
            maxBytes: config.toolboxMaxManifestBytes,
        });
        if (file.kind !== "ok") return off(toolboxFileFailure(file.kind, source.manifestFile));
        const catalog = buildCatalog(source, file.content, { containerId: id, imageId: runtime.imageId }, toolboxLimits());
        if (!catalog.ok) return off(catalog.error);
        return { ...base, revision: catalog.value.revision, actions: catalog.value.actions, unavailable: null };
    }

    async function renderToolbox(
        name: string,
        csrf: string,
        options: { notice?: { kind: NoteKind; text: string }; error?: { title: string; message: string }; status?: number } = {},
    ): Promise<Response> {
        const stack = await readStackCompose(stacksRoot, name);
        const parsed = parseToolboxSources(stack.source);
        if (!parsed.ok) throw new StackError(`${parsed.error} Fix the x-compose-panel section of ${stack.filename}.`, 400);
        const context = await resolveProjectContext(stacksRoot, name, provider);
        const sources: ToolboxSourceView[] = await Promise.all(parsed.value.map((source) => discoverToolboxSource(source, context)));
        return htmlResponse(
            toolboxPage({
                csrf,
                access,
                timezone: config.timeZone || undefined,
                stack: name,
                sources,
                operation: operations.forStack(name),
                notice: options.notice,
                error: options.error,
                nav: await sidebarNav("stacks", name),
            }),
            options.status ?? 200,
        );
    }

    type ToolboxPrepare =
        | { kind: "ok"; containerId: string; imageId: string; manifestWorkdir: string; action: ToolboxAction; revision: string }
        | { kind: "refused"; message: string };

    /**
     * Resolve the pinned container, re-read the manifest and revalidate the
     * revision. Called once for a friendly pre-check and again inside the
     * operation, under the per-stack lock (ADR 0026).
     */
    async function prepareToolboxAction(
        source: ToolboxSource,
        context: ProjectContext,
        actionName: string,
        expectedRevision: string,
    ): Promise<ToolboxPrepare> {
        if (context.kind !== "resolved")
            return { kind: "refused", message: "This stack is not deployed with a single Compose project, so no action can run." };
        const ids = await provider.runningContainerIds({
            project: context.project!,
            composeFile: context.composeFile,
            cwd: context.cwd,
            service: source.service,
            envFile: context.envFile ?? undefined,
        });
        if (ids === null) return { kind: "refused", message: TOOLBOX_OFFLINE };
        if (ids.length === 0) return { kind: "refused", message: `Service "${source.service}" is not running.` };
        if (ids.length > 1)
            return {
                kind: "refused",
                message: `Service "${source.service}" has several running containers; the toolbox needs exactly one.`,
            };
        const id = ids[0]!;
        const runtime = await containerRuntime(id);
        if (!runtime) return { kind: "refused", message: "The panel could not read this container's details from Docker." };
        const manifestWorkdir = source.workdir ?? runtime.workdir ?? "/";
        const file = await actionRunner.readFile(id, posix.join(manifestWorkdir, source.manifestFile), {
            timeoutMs: config.dockerTimeoutMs,
            maxBytes: config.toolboxMaxManifestBytes,
        });
        if (file.kind !== "ok") return { kind: "refused", message: toolboxFileFailure(file.kind, source.manifestFile) };
        const catalog = buildCatalog(source, file.content, { containerId: id, imageId: runtime.imageId }, toolboxLimits());
        if (!catalog.ok) return { kind: "refused", message: catalog.error };
        const found = catalog.value.actions.find((action) => action.name === actionName);
        if (!found) return { kind: "refused", message: `This source does not declare the action "${actionName}".` };
        if (catalog.value.revision !== expectedRevision) {
            return { kind: "refused", message: "The action definition changed since this page was loaded. Reload the page and try again." };
        }
        return { kind: "ok", containerId: id, imageId: runtime.imageId, manifestWorkdir, action: found, revision: catalog.value.revision };
    }

    /**
     * Full revalidation under the lock: the Compose declaration, the project
     * context and the catalog are all re-read, so a save or a redeploy during
     * the awaited Docker calls cannot make the action run with a stale source
     * (ADR 0026). The project reserved by the caller is rechecked too.
     */
    async function revalidateToolboxAction(
        name: string,
        sourceId: string,
        actionName: string,
        expectedRevision: string,
        expectedProject: string | undefined,
    ): Promise<ToolboxPrepare> {
        let stack: Awaited<ReturnType<typeof readStackCompose>>;
        try {
            stack = await readStackCompose(stacksRoot, name);
        } catch {
            return { kind: "refused", message: "This stack could no longer be read." };
        }
        const parsed = parseToolboxSources(stack.source);
        if (!parsed.ok) return { kind: "refused", message: parsed.error };
        const source = parsed.value.find((entry) => entry.id === sourceId);
        if (!source) return { kind: "refused", message: "This action's source is no longer declared by this stack." };
        const context = await resolveProjectContext(stacksRoot, name, provider);
        if (context.kind !== "resolved") return { kind: "refused", message: "This stack's Compose project can no longer be resolved." };
        if (expectedProject !== undefined && context.project !== expectedProject) {
            return { kind: "refused", message: "This stack now belongs to another Compose project." };
        }
        return prepareToolboxAction(source, context, actionName, expectedRevision);
    }

    async function handleToolboxAction(request: Request, name: string, session: Session): Promise<Response> {
        const csrf = session.csrf;
        const back = `/stacks/${encodeURIComponent(name)}/actions`;
        if (!isAllowedOrigin(request, config)) return staleForm(csrf, back);
        const form = await readForm(request);
        if (form === null) return tooLarge(csrf, back);
        if (!safeEqual(form.get("csrf") ?? "", csrf)) return staleForm(csrf, back);
        if (!sessions.isActive(session.id)) return sessionEnded();

        const pendingDeploy = await refusePendingDeploy(request, name, csrf, "action");
        if (pendingDeploy) return pendingDeploy;

        const sourceId = (form.get("source") ?? "").trim();
        const actionName = (form.get("action") ?? "").trim();
        const revision = (form.get("revision") ?? "").trim();

        const stack = await readStackCompose(stacksRoot, name);
        const parsed = parseToolboxSources(stack.source);
        if (!parsed.ok) throw new StackError(parsed.error, 400);
        const source = parsed.value.find((entry) => entry.id === sourceId) ?? null;
        if (!source) throw new StackError("This action's source is not declared by this stack. Nothing was run.", 404);
        if (!isActionName(actionName)) throw new StackError("This action name is not valid. Nothing was run.", 400);
        // The revision is always sent by the rendered page; a request without a
        // valid one cannot have come from a current page, so it is refused.
        if (!/^[0-9a-f]{64}$/.test(revision)) {
            return renderToolbox(name, csrf, {
                error: { title: "Nothing was run.", message: "This page is out of date. Reload the page and try again. Nothing was run." },
                status: 409,
            });
        }

        const context = await resolveProjectContext(stacksRoot, name, provider);
        if (context.kind === "invalid") throw new StackError(ENV_NOT_REGULAR, 409);
        if (context.kind === "ambiguous")
            throw new StackError("The panel cannot tell which Docker Compose project belongs to this stack. Nothing was run.", 409);
        if (context.kind === "unavailable")
            throw new StackError("Docker did not respond, so the panel could not check this stack. Nothing was run.", 503);
        if (context.kind === "absent") throw new StackError("This stack is not deployed yet, so there is nothing to run actions in.", 409);

        // A friendly pre-check without the lock; the authoritative revalidation
        // runs again inside the operation, under the per-stack lock.
        const prepared = await prepareToolboxAction(source, context, actionName, revision);
        if (prepared.kind === "refused") {
            await recordAudit({
                event: "toolbox",
                result: "refused",
                actor: clientKey(request, config),
                stack: name,
                action: actionName,
                detail: prepared.message,
            });
            return renderToolbox(name, csrf, { error: { title: "Nothing was run.", message: prepared.message }, status: 409 });
        }

        if (!sessions.isActive(session.id)) {
            await recordAudit({
                event: "toolbox",
                result: "refused",
                actor: clientKey(request, config),
                stack: name,
                action: actionName,
                detail: "session ended",
            });
            return sessionEnded();
        }
        try {
            if (selfUpdatePending) throw new OperationsDisabledError(SELF_UPDATE_RUNNING);
            operations.startApp({
                stack: name,
                source: source.id,
                script: actionName,
                label: prepared.action.label,
                project: context.project ?? undefined,
                run: async ({ onOutput, record }) => {
                    // Same critical section as the lock: re-read the Compose
                    // declaration, re-resolve the context, re-read the manifest,
                    // revalidate the revision, then exec.
                    const check = await revalidateToolboxAction(name, source.id, actionName, revision, context.project ?? undefined);
                    if (check.kind === "refused") return { refused: `${check.message} Nothing was run.` };
                    record({ containerId: check.containerId, imageId: check.imageId, revision: check.revision });
                    return actionRunner.exec({
                        id: check.containerId,
                        argv: actionArgv(source.runner, check.action),
                        user: source.user,
                        workdir: source.workdir,
                        timeoutMs: check.action.timeoutMs ?? config.operationTimeoutMs,
                        maxBytes: config.dockerMaxBytes,
                        onOutput,
                    });
                },
            });
            await recordAudit({
                event: "toolbox",
                result: "started",
                actor: clientKey(request, config),
                stack: name,
                action: actionName,
                detail: `source ${source.id}`,
            });
            return redirect(back, 303);
        } catch (error) {
            if (error instanceof StackBusyError || error instanceof OperationsDisabledError) {
                await recordAudit({
                    event: "toolbox",
                    result: "refused",
                    actor: clientKey(request, config),
                    stack: name,
                    action: actionName,
                    detail: error.message,
                });
                return renderToolbox(name, csrf, {
                    error: { title: "Nothing was run.", message: `${error.message} Nothing was run.` },
                    status: 409,
                });
            }
            throw error;
        }
    }

    const managedSiteProbe = createManagedSiteProbe();
    const MANAGED_SITE_PENDING_MESSAGE =
        "A previous deploy of this site has an unconfirmed outcome. Inspect the current pointer, the Docker service state and the revision probe, then acknowledge that attempt before running another modifying action.";

    async function readManagedSiteManifest(stackDir: string): Promise<ManagedSiteManifestResult> {
        try {
            const file = await readFileSafe(join(stackDir, MANAGED_SITE_MANIFEST_FILE), MANAGED_SITE_MANIFEST_MAX_BYTES);
            if (!file) return { ok: false, reason: "This stack has no compose-panel-site.json site manifest." };
            return parseManagedSiteManifest(file.source);
        } catch (error) {
            if (error instanceof FileSafetyError) return { ok: false, reason: error.message };
            return { ok: false, reason: "The site manifest could not be read." };
        }
    }

    async function managedSiteStackDir(name: string): Promise<string> {
        return dirname((await locateComposeFile(stacksRoot, name)).path);
    }

    /**
     * Re-render the generated files from the manifest and compare them with
     * what is on disk. Any difference is drift: a managed mutation is refused
     * and the affected file is named. `null` means "not a managed site" or
     * "generated files still match".
     */
    async function managedSiteDriftReason(stackDir: string): Promise<string | null> {
        let stackAnchor;
        let generatedAnchor;
        try {
            stackAnchor = await anchorDir(stackDir, "The stack folder is not a real directory. Nothing was changed.");
            let source: string;
            try {
                const file = await readFileSafe(join(stackAnchor.path, MANAGED_SITE_MANIFEST_FILE), MANAGED_SITE_MANIFEST_MAX_BYTES);
                if (!file) return null;
                source = file.source;
            } catch {
                return "The site manifest cannot be read as a regular file. The managed site was left unchanged.";
            }
            const parsed = parseManagedSiteManifest(source);
            if (!parsed.ok) return `The site manifest cannot be used: ${parsed.reason}`;
            if (parsed.manifest.owner !== "managed") return null;
            const rendered = renderManagedSiteArtifacts(stackDir, parsed.manifest);
            if (!rendered.ok) return rendered.reason;
            try {
                generatedAnchor = await anchorDir(
                    join(stackDir, MANAGED_SITE_PATHS.generated),
                    "The generated folder is a symbolic link or not a folder. The managed site was left unchanged.",
                );
            } catch {
                return "The generated folder is a symbolic link or not a folder. The managed site was left unchanged.";
            }
            const expected: [string, string][] = [
                ["compose.yaml", rendered.artifacts.compose],
                [MANAGED_SITE_GATEWAY_CONFIG, rendered.artifacts.gateway],
                [MANAGED_SITE_OPCACHE_CONFIG, rendered.artifacts.opcache],
            ];
            const generatedPrefix = `${MANAGED_SITE_PATHS.generated}/`;
            for (const [path, content] of expected) {
                const anchored = path.startsWith(generatedPrefix)
                    ? join(generatedAnchor.path, path.slice(generatedPrefix.length))
                    : join(stackAnchor.path, path);
                let actual;
                try {
                    actual = await readFileSafe(anchored, Math.max(config.maxEditBytes, 64 * 1024));
                } catch {
                    return `The generated file "${path}" cannot be read as a regular file. The managed site was left unchanged.`;
                }
                if (!actual) return `The generated file "${path}" is missing. The managed site was left unchanged.`;
                if (actual.source !== content) {
                    return `The generated file "${path}" does not match compose-panel-site.json. Drift refuses this action; inspect it on the host and regenerate the site files explicitly.`;
                }
            }
            return null;
        } finally {
            await generatedAnchor?.close();
            await stackAnchor?.close();
        }
    }

    /**
     * Baseline eligibility checked under the stack lock. Publishing changes
     * what `runtime/current` resolves to, and the runtime directory is already
     * mounted by any container the operator started early. The site must be
     * stopped, its identity/profile must still match and Docker must confirm
     * the state instead of guessing.
     */
    async function baselineRefusal(name: string, manifest: ManagedSiteManifest): Promise<string | null> {
        const context = await resolveProjectContext(stacksRoot, name, provider);
        if (context.kind === "invalid") return "The stack environment file cannot be read safely.";
        if (context.kind === "ambiguous") return "The Compose project identity is ambiguous, so nothing was published.";
        if (context.kind === "unavailable")
            return "Docker did not respond, so the project identity could not be checked. Nothing was published.";
        if (context.project !== null && context.project !== manifest.project) {
            return `The deployed project is "${context.project}", not the declared project "${manifest.project}". Nothing was published.`;
        }
        const facts = await provider.managedSiteFacts({
            composeFile: context.composeFile,
            cwd: context.cwd,
            envFile: context.envFile ?? undefined,
        });
        if (!facts) return "Docker did not return the effective Compose configuration. Nothing was published.";
        if (facts.name !== manifest.project) {
            return `The effective Compose project is "${facts.name}", not "${manifest.project}". Nothing was published.`;
        }
        const profile = checkManagedSiteProfile({ manifest, stackDir: context.cwd, facts });
        if (!profile.ok) return `${profile.reason} Nothing was published.`;

        const servicesResult = await provider.projectServices({
            project: context.project ?? manifest.project,
            composeFile: context.composeFile,
            cwd: context.cwd,
            envFile: context.envFile ?? undefined,
        });
        if (servicesResult.code !== 0 || servicesResult.timedOut || servicesResult.truncated) {
            return "Docker did not give a complete service state, so the site may be running. Nothing was published.";
        }
        let services;
        try {
            services = parseComposePs(servicesResult.stdout);
        } catch {
            return "Docker gave an unexpected service state, so nothing was published.";
        }
        const state = summarizeServices(services);
        if (state === "running" || (state === "unknown" && services.length > 0)) {
            return "Stop the site before publishing a baseline: running containers would start serving the new release without verification.";
        }
        return null;
    }

    /** Admission checked under the stack lock: pending deploy, then drift. */
    /** A declared backup needs credentials and no unconfirmed attempt. */
    async function managedBackupAdmission(stackDir: string): Promise<string | null> {
        const site = await readManagedSiteManifest(stackDir);
        if (!site.ok) return site.reason;
        if (site.manifest.owner !== "managed" || !site.manifest.backup) {
            return "This site declares no backup block, so there is nothing to back up.";
        }
        if (!site.manifest.paths || site.manifest.paths.length === 0) {
            return "This site declares no persistent roots, so there is nothing to back up.";
        }
        const marker = await readManagedSiteBackupAttempt(stackDir);
        if (marker.kind !== "none") {
            return "A previous backup attempt has an unconfirmed outcome. Inspect the repository and acknowledge it before starting another backup.";
        }
        const credentials = await (options.backupCheckCredentials ?? checkManagedSiteBackupCredentials)(stackDir, site.manifest);
        return credentials.ok ? null : `${credentials.reason} Nothing was run.`;
    }

    /** A restore needs the backup contract and no unconfirmed attempt. */
    async function managedRestoreAdmission(stackDir: string): Promise<string | null> {
        const site = await readManagedSiteManifest(stackDir);
        if (!site.ok) return site.reason;
        if (site.manifest.owner !== "managed" || !site.manifest.backup) {
            return "This site declares no backup block, so there is no repository to restore from.";
        }
        const marker = await readManagedSiteBackupAttempt(stackDir);
        if (marker.kind !== "none") {
            return "A previous backup attempt has an unconfirmed outcome. Inspect the repository and acknowledge it before restoring.";
        }
        const credentials = await (options.backupCheckCredentials ?? checkManagedSiteBackupCredentials)(stackDir, site.manifest);
        return credentials.ok ? null : `${credentials.reason} Nothing was run.`;
    }

    /** Down must not leave a live Caddy route pointing at a removed port. */
    async function managedDownDomainAdmission(stack: string): Promise<string | null> {
        const site = await readManagedSiteManifest(await managedSiteStackDir(stack));
        if (!site.ok) return null;
        const domains = await readManagedSiteDomains(stack);
        if (domains.kind === "unavailable") {
            return `${domains.reason} The panel cannot prove that no domain still routes to this site, so nothing was run.`;
        }
        if (domains.kind === "attached") {
            const list = domains.sites.map((site) => `${site.domain} (127.0.0.1:${site.port})`).join(", ");
            return `Detach the domains routed to this site before Down: ${list}. Nothing was run.`;
        }
        return null;
    }

    /** A generated site needs a provable release before anything starts. */
    async function managedBaselineAdmission(stack: string): Promise<string | null> {
        const stackDir = await managedSiteStackDir(stack);
        const site = await readManagedSiteManifest(stackDir);
        if (!site.ok || site.manifest.owner !== "managed") return null;
        const baseline = await readBaseline(stackDir, site.manifest.siteId);
        return baseline.ok ? null : `${baseline.reason} Publish a baseline release before starting this site. Nothing was run.`;
    }

    /**
     * A declared database needs its private env file and the effective network
     * membership before anything starts. Managed sites are also drift-checked;
     * this closes the same check for an opt-in stack's ordinary Up/Start.
     */
    async function managedDatabaseAdmission(stack: string, action: string): Promise<string | null> {
        const stackDir = await managedSiteStackDir(stack);
        const site = await readManagedSiteManifest(stackDir);
        if (!site.ok || !site.manifest.database) return null;
        const checked = await checkManagedSiteDatabaseEnvFile(stackDir, site.manifest);
        if (!checked.ok) return `${checked.reason} Nothing was run.`;
        const context = await resolveProjectContext(stacksRoot, stack, provider, action === "up" || action === "pull-up");
        if (context.kind !== "resolved" && context.kind !== "absent") {
            return "The effective Compose project could not be resolved, so the database network could not be checked. Nothing was run.";
        }
        const facts = await provider.managedSiteFacts({
            composeFile: context.composeFile,
            cwd: context.cwd,
            envFile: context.envFile ?? undefined,
        });
        if (!facts) {
            return "Docker did not return the effective Compose configuration, so the database network could not be checked. Nothing was run.";
        }
        const profile = checkManagedSiteProfile({ manifest: site.manifest, stackDir, facts });
        return profile.ok ? null : `${profile.reason} Nothing was run.`;
    }

    type ManagedSiteDomains =
        | { kind: "none"; sites: [] }
        | { kind: "attached"; sites: { domain: string; port: number }[] }
        | { kind: "unavailable"; reason: string };

    /** Domains the Caddy helper currently routes to this stack. Read-only. */
    async function readManagedSiteDomains(name: string): Promise<ManagedSiteDomains> {
        if (!config.caddyEnabled || !config.caddySocketPath) return { kind: "none", sites: [] };
        try {
            const response = await callCaddyHelper(config.caddySocketPath, { action: "status" }, { timeoutMs: config.dockerTimeoutMs });
            if (!response.ok || response.action !== "status") {
                return { kind: "unavailable", reason: "The Caddy helper did not return its domain list." };
            }
            if (response.unparseable.length > 0) {
                return { kind: "unavailable", reason: "Some Caddy managed files cannot be read." };
            }
            const sites = response.sites.filter((site) => site.stack === name).map((site) => ({ domain: site.domain, port: site.port }));
            return sites.length > 0 ? { kind: "attached", sites } : { kind: "none", sites: [] };
        } catch {
            return { kind: "unavailable", reason: "The Caddy helper did not answer." };
        }
    }

    /**
     * The pending marker is evidence that a crash left an ambiguous serving
     * state. It refuses every modifying operation until the operator inspects
     * and acknowledges it; reads, logs and the probe stay available.
     */
    async function refusePendingDeploy(request: Request, name: string, csrf: string, action: string): Promise<Response | null> {
        if (!config.managedSitesEnabled) return null;
        const stackDir = await managedSiteStackDir(name);
        if (!(await pendingDeployAttempt(stackDir))) return null;
        await recordAudit({
            event: "deploy",
            result: "refused",
            actor: clientKey(request, config),
            stack: name,
            action,
            detail: "an unacknowledged deploy attempt needs inspection",
        });
        return routeError(new StackError(MANAGED_SITE_PENDING_MESSAGE, 409), csrf, name);
    }

    function deployResultOutcome(
        result: ManagedSiteDeployResult,
        record: (detail: { containerId?: string; imageId?: string; revision?: string }) => void,
        onOutput: (chunk: string) => void,
    ): AppActionOutcome {
        // The operation view treats any live chunk as the complete output for a
        // call, so the synthesized summary goes through the same stream instead
        // of relying on the post-call append.
        const emit = (text: string, code = 0): AppActionOutcome => {
            onOutput(`${text}\n`);
            return { code, stdout: "", stderr: "", timedOut: false, truncated: false };
        };
        switch (result.kind) {
            case "refused":
                return { refused: result.reason };
            case "failed":
                return emit(result.reason, 1);
            case "noop":
                record({ revision: result.releaseId });
                return emit(`Already serving ${result.releaseId}; nothing changed.`);
            case "deployed":
                record({ revision: result.releaseId });
                return emit(`Served revision verified: ${result.releaseId} (previous ${result.priorReleaseId}).`);
            case "rolled-back":
                record({ revision: result.servedReleaseId });
                return emit(
                    `Verification failed for ${result.releaseId}; the site was rolled back to ${result.servedReleaseId}, which the probe confirmed.`,
                    1,
                );
            case "intervention":
                if (result.releaseId) record({ revision: result.releaseId });
                onOutput(`\n${result.reason}\n`);
                return { intervention: result.reason };
            case "unknown":
                if (result.releaseId) record({ revision: result.releaseId });
                onOutput(`${result.reason}\n`);
                return {
                    code: -1,
                    stdout: "",
                    stderr: "",
                    timedOut: false,
                    truncated: false,
                    terminationUnconfirmed: true,
                };
        }
    }

    /** The locked body of a deploy: revalidation, fetch/publish, activation. */
    async function executeManagedSiteDeploy(input: {
        name: string;
        manifest: ManagedSiteManifest;
        onOutput: (chunk: string) => void;
        record: (detail: { containerId?: string; imageId?: string; revision?: string }) => void;
    }): Promise<AppActionOutcome> {
        const context = await resolveProjectContext(stacksRoot, input.name, provider);
        if (context.kind !== "resolved") {
            return { refused: "The panel could not resolve exactly one deployed Compose project for this stack." };
        }
        if (context.project !== input.manifest.project) {
            return { refused: `The deployed project is "${context.project}", not the declared project "${input.manifest.project}".` };
        }
        const stackDir = context.cwd;
        if (await pendingDeployAttempt(stackDir)) return { refused: MANAGED_SITE_PENDING_MESSAGE };
        const database = await checkManagedSiteDatabaseEnvFile(stackDir, input.manifest);
        if (!database.ok) return { refused: database.reason };
        const result = await runManagedSiteDeploy({
            stackDir,
            attemptId: randomSuffix(),
            signal: shutdownController.signal,
            loadManifest: async () => {
                const located = await locateComposeFile(stacksRoot, input.name);
                return readManagedSiteManifest(dirname(located.path));
            },
            inspectProfile: async (manifest) => {
                // No `-p` here: the effective project the files declare is what
                // the manifest must match before any command injects one.
                const facts = await provider.managedSiteFacts({
                    composeFile: context.composeFile,
                    cwd: context.cwd,
                    envFile: context.envFile ?? undefined,
                });
                if (!facts) return { ok: false, reason: "Docker did not return the effective Compose configuration." };
                if (facts.name !== manifest.project) {
                    return { ok: false, reason: `The effective Compose project is "${facts.name}", not "${manifest.project}".` };
                }
                const checked = checkManagedSiteProfile({ manifest, stackDir: context.cwd, facts });
                return checked.ok ? { ok: true, facts } : checked;
            },
            provider,
            inspector,
            files: (manifest) => ({
                project: manifest.project,
                cwd: context.cwd,
                composeFiles: [context.composeFile],
                envFiles: context.envFile ? [context.envFile] : [],
            }),
            fetchRelease: ({ manifest, attemptId, onOutput, signal }) => {
                const prepare = composerPreparation(manifest);
                return fetchAndPublishGitRelease({
                    stackDir: context.cwd,
                    attemptId,
                    siteId: manifest.siteId,
                    url: manifest.deploy.git.url,
                    ref: manifest.deploy.git.ref,
                    onOutput,
                    ...(signal ? { signal } : {}),
                    ...(prepare ? { prepare, releaseLimits: MANAGED_SITE_RELEASE_LIMITS } : {}),
                });
            },
            probe: managedSiteProbe,
            now: () => Date.now(),
            sleep,
            isShuttingDown: () => shuttingDown,
            onOutput: input.onOutput,
            commandTimeoutMs: config.operationTimeoutMs,
        });
        return deployResultOutcome(result, input.record, input.onOutput);
    }

    async function handleDeploy(request: Request, name: string, session: Session): Promise<Response> {
        const csrf = session.csrf;
        const back = `/stacks/${encodeURIComponent(name)}`;
        if (!config.managedSitesEnabled) throw new StackError("Managed sites are not enabled on this panel.", 404);
        if (!isAllowedOrigin(request, config)) return staleForm(csrf, back);
        const form = await readForm(request);
        if (form === null) return tooLarge(csrf, back);
        if (!safeEqual(form.get("csrf") ?? "", csrf)) return staleForm(csrf, back);
        if (!sessions.isActive(session.id)) return sessionEnded();

        const stackDir = await managedSiteStackDir(name);
        const manifestResult = await readManagedSiteManifest(stackDir);
        if (!manifestResult.ok) {
            await recordAudit({
                event: "deploy",
                result: "refused",
                actor: clientKey(request, config),
                stack: name,
                action: "deploy",
                detail: manifestResult.reason,
            });
            return renderStackDetail(name, csrf, { kind: "error", text: manifestResult.reason }, 409);
        }
        if (await pendingDeployAttempt(stackDir)) {
            const response = await refusePendingDeploy(request, name, csrf, "deploy");
            if (response) return response;
        }
        const manifest = manifestResult.manifest;
        if (!sessions.isActive(session.id)) return sessionEnded();

        try {
            if (selfUpdatePending) throw new OperationsDisabledError(SELF_UPDATE_RUNNING);
            operations.startDeploy({
                stack: name,
                project: manifest.project,
                run: async ({ onOutput, record }) => {
                    if (selfUpdatePending) throw new OperationsDisabledError(SELF_UPDATE_RUNNING);
                    return executeManagedSiteDeploy({ name, manifest, onOutput, record });
                },
            });
            await recordAudit({
                event: "deploy",
                result: "started",
                actor: clientKey(request, config),
                stack: name,
                action: "deploy",
                detail: `site ${manifest.siteId}, ${manifest.deploy.git.ref}`,
            });
            return redirect(back, 303);
        } catch (error) {
            if (error instanceof StackBusyError || error instanceof OperationsDisabledError) {
                await recordAudit({
                    event: "deploy",
                    result: "refused",
                    actor: clientKey(request, config),
                    stack: name,
                    action: "deploy",
                    detail: error.message,
                });
                return renderStackDetail(name, csrf, { kind: "error", text: `${error.message} Nothing was run.` }, 409);
            }
            throw error;
        }
    }

    async function handleDeployAcknowledge(request: Request, name: string, session: Session): Promise<Response> {
        const csrf = session.csrf;
        const back = `/stacks/${encodeURIComponent(name)}`;
        if (!config.managedSitesEnabled) throw new StackError("Managed sites are not enabled on this panel.", 404);
        if (!isAllowedOrigin(request, config)) return staleForm(csrf, back);
        const form = await readForm(request);
        if (form === null) return tooLarge(csrf, back);
        if (!safeEqual(form.get("csrf") ?? "", csrf)) return staleForm(csrf, back);
        if (!sessions.isActive(session.id)) return sessionEnded();
        const attempt = (form.get("attempt") ?? "").trim();
        if (!isManagedSiteAttemptId(attempt)) {
            return renderStackDetail(
                name,
                csrf,
                {
                    kind: "error",
                    text: "This page is out of date. Reload it, inspect the pending deploy and acknowledge the attempt it shows.",
                },
                409,
            );
        }
        const stackDir = await managedSiteStackDir(name);
        const marker = managedSiteAttemptPath(stackDir);
        try {
            // The acknowledgement takes the same lock as every mutation and is
            // bound to the attempt id the operator saw.
            const task = locks.run(name, async () => {
                if (shuttingDown) throw new OperationsDisabledError();
                if (selfUpdatePending) throw new OperationsDisabledError(SELF_UPDATE_RUNNING);
                const before = await lstat(marker).catch((error: unknown) => {
                    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
                    throw error;
                });
                if (!before) return "none" as const;
                if (before.isDirectory()) throw new StackError("The deploy marker is not a file. Inspect it on the host instead.", 409);
                const read = await readPendingDeployAttempt(stackDir);
                if (read.kind === "none") return "none" as const;
                if (read.kind === "unreadable") {
                    throw new StackError("The deploy marker cannot be read as a regular file. Inspect it on the host.", 409);
                }
                if (read.attempt.attemptId !== attempt) {
                    throw new StackError(
                        "The pending deploy attempt changed since this page was rendered. Reload it and inspect the attempt before acknowledging it.",
                        409,
                    );
                }
                const after = await lstat(marker).catch(() => null);
                if (!after || after.dev !== before.dev || after.ino !== before.ino) {
                    throw new StackError("The deploy marker changed while it was being read. Inspect it on the host.", 409);
                }
                await unlink(marker);
                return "cleared" as const;
            });
            saves.add(task);
            let state: "none" | "cleared";
            try {
                state = await task;
            } finally {
                saves.delete(task);
            }
            if (state === "cleared") {
                await recordAudit({
                    event: "deploy",
                    result: "acknowledged",
                    actor: clientKey(request, config),
                    stack: name,
                    action: "deploy",
                    detail: `operator cleared attempt ${attempt} after inspection`,
                });
            }
            return redirect(back, 303);
        } catch (error) {
            if (error instanceof StackBusyError || error instanceof OperationsDisabledError) {
                await recordAudit({
                    event: "deploy",
                    result: "refused",
                    actor: clientKey(request, config),
                    stack: name,
                    action: "deploy",
                    detail: error.message,
                });
                return renderStackDetail(name, csrf, { kind: "error", text: `${error.message} Nothing was changed.` }, 409);
            }
            throw error;
        }
    }

    type ManagedSiteCard = {
        manifest?: ManagedSiteManifest;
        reason?: string;
        pending: PendingDeployAttemptRead;
        baseline: boolean;
        drift?: string;
        database?: { ok: true } | { ok: false; reason: string };
        backup?: { check: { ok: true } | { ok: false; reason: string }; attempt: ManagedSiteBackupAttemptRead };
    };

    async function managedSiteCard(name: string): Promise<ManagedSiteCard | null> {
        try {
            const stackDir = await managedSiteStackDir(name);
            const pending = await readPendingDeployAttempt(stackDir);
            // An ordinary stack has no manifest and no marker: no card at all.
            const file = await readFileSafe(join(stackDir, MANAGED_SITE_MANIFEST_FILE), MANAGED_SITE_MANIFEST_MAX_BYTES);
            if (!file) return pending.kind === "none" ? null : { reason: "This stack has no site manifest.", pending, baseline: false };
            const manifest = parseManagedSiteManifest(file.source);
            if (!manifest.ok) return { reason: manifest.reason, pending, baseline: false };
            const baseline = await readBaseline(stackDir, manifest.manifest.siteId);
            const drift = await managedSiteDriftReason(stackDir);
            const database = manifest.manifest.database ? await checkManagedSiteDatabaseEnvFile(stackDir, manifest.manifest) : undefined;
            const backup = manifest.manifest.backup
                ? {
                      check: await (options.backupCheckCredentials ?? checkManagedSiteBackupCredentials)(stackDir, manifest.manifest),
                      attempt: await readManagedSiteBackupAttempt(stackDir),
                  }
                : undefined;
            return {
                manifest: manifest.manifest,
                pending,
                baseline: baseline.ok,
                ...(drift ? { drift } : {}),
                ...(database ? { database } : {}),
                ...(backup ? { backup } : {}),
            };
        } catch {
            return null;
        }
    }

    function managedSiteBackupSection(
        card: ManagedSiteCard,
        manifest: ManagedSiteManifest,
        href: string,
        csrf: string,
        busy: boolean,
    ): string {
        const backup = manifest.backup;
        if (!backup) return "";
        const repository = `<p class="meta"><span>Repository <code>${escapeHtml(backup.repository)}</code></span><span>Scope <code>${backup.sql ? `files + ${escapeHtml(backup.sql.database)} (${escapeHtml(backup.sql.engine)})` : "files"}</code></span></p>`;
        const attempt = card.backup?.attempt;
        if (attempt?.kind === "unreadable") {
            return (
                `<h3>Offsite backup</h3>` +
                repository +
                note(
                    "warn",
                    "A backup marker exists but cannot be read. Inspect the repository and the private backup folder, then acknowledge it.",
                ) +
                `<form method="post" action="${href}/backup/acknowledge"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button class="btn" type="submit"${busy ? " disabled" : ""}>Acknowledge unreadable attempt</button></form>`
            );
        }
        if (attempt?.kind === "pending") {
            return (
                `<h3>Offsite backup</h3>` +
                repository +
                note(
                    "warn",
                    `Backup attempt ${attempt.attempt.attemptId} is ${attempt.attempt.outcome} (${attempt.attempt.phase})${attempt.attempt.reason ? `: ${attempt.attempt.reason}` : ""}. The repository may already hold it; inspect it before acknowledging.`,
                ) +
                `<form method="post" action="${href}/backup/acknowledge"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="attempt" value="${escapeHtml(attempt.attempt.attemptId)}"><button class="btn" type="submit"${busy ? " disabled" : ""}>Acknowledge attempt ${escapeHtml(attempt.attempt.attemptId)}</button></form>`
            );
        }
        const check = card.backup && !card.backup.check.ok ? note("warn", card.backup.check.reason) : "";
        return (
            `<h3>Offsite backup</h3>` +
            repository +
            check +
            `<form method="post" action="${href}/backup"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button class="btn" type="submit"${busy ? " disabled" : ""}>Back up now</button></form>` +
            note(
                "info",
                "Copies the declared persistent roots to a private staging tree, dumps only the declared database when one is configured, uploads with a pinned Restic container and verifies the exact snapshot. The panel never reads the credential files.",
            ) +
            `<form method="post" action="${href}/restore"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><label>Snapshot id <input type="text" name="snapshot" required minlength="64" maxlength="64" pattern="[0-9a-f]{64}" spellcheck="false" autocapitalize="none" placeholder="64 hexadecimal characters"></label><button class="btn" type="submit"${busy ? " disabled" : ""}>Verify and restore</button></form>` +
            note(
                "info",
                "Restores one exact snapshot into a new private directory and, for a SQL snapshot, imports it into a disposable database with no production credentials, no production network and no published port. The live site is not modified.",
            )
        );
    }

    function managedSiteSection(card: ManagedSiteCard | null, name: string, csrf: string, busy: boolean): string {
        if (!card) return "";
        const href = `/stacks/${encodeURIComponent(name)}`;
        if (card.pending.kind === "unreadable") {
            return `<section class="card"><h2>Managed site</h2>${note(
                "warn",
                `${MANAGED_SITE_PENDING_MESSAGE} The marker itself could not be read; inspect it on the host before changing anything.`,
            )}</section>`;
        }
        if (card.pending.kind === "pending") {
            return (
                `<section class="card"><h2>Managed site</h2>` +
                note("warn", MANAGED_SITE_PENDING_MESSAGE) +
                `<form method="post" action="${href}/deploy/acknowledge"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="attempt" value="${escapeHtml(card.pending.attempt.attemptId)}"><button class="btn" type="submit">Acknowledge attempt ${escapeHtml(card.pending.attempt.attemptId)}</button></form>` +
                `</section>`
            );
        }
        if (!card.manifest) {
            return `<section class="card"><h2>Managed site</h2>${note("warn", `The site manifest cannot be used: ${card.reason ?? "unknown reason"}`)}</section>`;
        }
        const manifest = card.manifest;
        const drift = card.drift ? note("warn", card.drift) : "";
        const databaseNote = card.database && !card.database.ok ? note("warn", card.database.reason) : "";
        const regenerate =
            card.drift && manifest.owner === "managed"
                ? `<form method="post" action="${href}/regenerate"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button class="btn" type="submit"${busy ? " disabled" : ""}>Regenerate generated files</button></form>`
                : "";
        const meta = `<p class="meta"><span>Site <code>${escapeHtml(manifest.siteId)}</code></span><span>Project <code>${escapeHtml(manifest.project)}</code></span><span>Branch <code>${escapeHtml(manifest.deploy.git.ref)}</code></span>${manifest.gateway ? `<span>Gateway <code>127.0.0.1:${manifest.gateway.port}</code></span>` : ""}${manifest.database ? `<span>Database <code>${escapeHtml(manifest.database.engine)}</code> on <code>${escapeHtml(manifest.database.network)}</code></span>` : ""}${manifest.build ? "<span>Composer <code>installed per release</code></span>" : ""}</p>`;
        if (!card.baseline) {
            return (
                `<section class="card"><h2>Managed site</h2>` +
                meta +
                drift +
                databaseNote +
                managedSiteBackupSection(card, manifest, href, csrf, busy) +
                regenerate +
                note(
                    "info",
                    "No release has been published yet. Publish one baseline from the configured branch before starting the site; a deployment always needs a release to return to.",
                ) +
                `<form method="post" action="${href}/baseline"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button class="btn" type="submit"${busy || card.drift ? " disabled" : ""}>Publish baseline ${escapeHtml(manifest.deploy.git.ref)}</button></form>` +
                `</section>`
            );
        }
        return (
            `<section class="card"><h2>Managed site</h2>` +
            meta +
            drift +
            databaseNote +
            managedSiteBackupSection(card, manifest, href, csrf, busy) +
            regenerate +
            `<form method="post" action="${href}/deploy"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button class="btn" type="submit"${busy || card.drift ? " disabled" : ""}>Deploy ${escapeHtml(manifest.deploy.git.ref)}</button></form>` +
            note(
                "info",
                "Fetches the configured branch into an immutable release, briefly stops the gateway, switches the pointer atomically and recreates the runtime. A failed revision probe rolls back to the verified baseline.",
            ) +
            `</section>`
        );
    }

    type RolloutReadinessResult = { ok: true; entries: RolloutReadinessView[] } | { ok: false; reason: string };
    type PreparedRollout = { kind: "ok"; context: ProjectContext; preparation: RolloutPreparation } | { kind: "refused"; reason: string };

    function rolloutTarget(context: ProjectContext) {
        return {
            project: context.project!,
            composeFile: context.composeFile,
            cwd: context.cwd,
            envFile: context.envFile ?? undefined,
        };
    }

    async function inspectRolloutContainer(id: string): Promise<RolloutInspect | null> {
        try {
            const result = await inspector.inspect(id);
            if (result.code !== 0 || result.timedOut || result.truncated) return null;
            return parseRolloutInspect(result.stdout);
        } catch {
            return null;
        }
    }

    async function resolveLocalImageId(reference: string): Promise<string | null> {
        try {
            const result = await provider.inspectImages([reference]);
            if (result.code !== 0 || result.timedOut || result.truncated) return null;
            return parseImageInspect(result.stdout)[0]?.id ?? null;
        } catch {
            return null;
        }
    }

    /**
     * Read-only eligibility for one service or every declared service. Docker
     * is never mutated here; every failure becomes a displayed refusal.
     */
    async function collectRolloutReadiness(context: ProjectContext, requested: string | null): Promise<RolloutReadinessResult> {
        const target = rolloutTarget(context);
        const [names, factsMap] = await Promise.all([provider.listServices(target), provider.serviceRolloutFacts(target)]);
        if (names === null || factsMap === null) {
            return { ok: false, reason: "Docker did not respond, so the rollout eligibility could not be checked." };
        }
        if (requested !== null && !names.includes(requested)) {
            return {
                ok: true,
                entries: [
                    {
                        service: requested,
                        declared: false,
                        invalid: false,
                        ready: false,
                        reason: "This stack defines no such service.",
                        image: null,
                        containerId: null,
                        declaration: null,
                    },
                ],
            };
        }
        const candidates = requested === null ? names : [requested];
        const entries: RolloutReadinessView[] = [];
        for (const service of candidates) {
            const facts = factsMap.get(service);
            if (!facts) {
                if (requested !== null) {
                    entries.push({
                        service,
                        declared: false,
                        invalid: false,
                        ready: false,
                        reason: "This service is not in the resolved Compose configuration.",
                        image: null,
                        containerId: null,
                        declaration: null,
                    });
                }
                continue;
            }
            const parsed = parseRolloutDeclaration(facts.labels);
            if (parsed === null) {
                if (requested !== null) {
                    entries.push({
                        service,
                        declared: false,
                        invalid: false,
                        ready: false,
                        reason: "This service does not declare panel.rollout.enabled.",
                        image: facts.image,
                        containerId: null,
                        declaration: null,
                    });
                }
                continue;
            }
            if (!parsed.ok) {
                entries.push({
                    service,
                    declared: true,
                    invalid: true,
                    ready: false,
                    reason: parsed.reason,
                    image: facts.image,
                    containerId: null,
                    declaration: null,
                });
                continue;
            }
            const ids = await provider.serviceContainerIds({ ...target, service });
            if (ids === null) {
                entries.push({
                    service,
                    declared: true,
                    invalid: false,
                    ready: false,
                    reason: "Docker did not respond, so this service's containers could not be read.",
                    image: facts.image,
                    containerId: null,
                    declaration: parsed.value,
                });
                continue;
            }
            const inspected = ids.length === 1 ? await inspectRolloutContainer(ids[0]!) : null;
            const eligibility = checkRolloutEligibility({
                facts,
                declaration: parsed.value,
                inspect: inspected,
                containerCount: ids.length,
            });
            if (!eligibility.ok) {
                entries.push({
                    service,
                    declared: true,
                    invalid: false,
                    ready: false,
                    reason: eligibility.reason,
                    image: facts.image,
                    containerId: inspected?.id ?? null,
                    declaration: parsed.value,
                });
                continue;
            }
            entries.push({
                service,
                declared: true,
                invalid: false,
                ready: true,
                reason: null,
                image: eligibility.image,
                containerId: inspected!.id,
                declaration: parsed.value,
            });
        }
        return { ok: true, entries };
    }

    /**
     * Authoritative revalidation, called inside the rollout operation with the
     * per-stack lock held. Re-resolves the project, re-reads the resolved
     * Compose facts, rediscovers every container and re-runs every rule.
     */
    async function prepareRollout(name: string, service: string): Promise<PreparedRollout> {
        const context = await resolveProjectContext(stacksRoot, name, provider);
        if (context.kind === "invalid") return { kind: "refused", reason: ENV_NOT_REGULAR };
        if (context.kind === "ambiguous") {
            return { kind: "refused", reason: "The panel cannot tell which Docker Compose project belongs to this stack." };
        }
        if (context.kind === "unavailable") {
            return { kind: "refused", reason: "Docker did not respond, so the rollout was not started." };
        }
        if (context.kind === "absent") {
            return { kind: "refused", reason: "This stack is not deployed yet, so there is nothing to roll out." };
        }
        const readiness = await collectRolloutReadiness(context, service);
        if (!readiness.ok) return { kind: "refused", reason: readiness.reason };
        const entry = readiness.entries[0];
        if (!entry || !entry.ready || !entry.declaration || !entry.containerId || !entry.image) {
            return { kind: "refused", reason: entry?.reason ?? "This service is not ready for a rollout." };
        }
        return {
            kind: "ok",
            context,
            preparation: {
                oldContainerId: entry.containerId,
                declaration: entry.declaration,
                image: entry.image,
            },
        };
    }

    function rolloutDependencies(context: ProjectContext): RolloutDependencies {
        const target = rolloutTarget(context);
        return {
            pull: (rolloutTargetValue, service, onOutput, timeoutMs) =>
                provider.pullService({ ...rolloutTargetValue, service, onOutput, timeoutMs }),
            scale: (rolloutTargetValue, service, onOutput, timeoutMs) =>
                provider.scaleService({ ...rolloutTargetValue, service, replicas: 2, onOutput, timeoutMs }),
            listServiceContainers: (rolloutTargetValue, service) => provider.serviceContainerIds({ ...rolloutTargetValue, service }),
            inspect: inspectRolloutContainer,
            imageId: resolveLocalImageId,
            stop: (id, seconds, onOutput, timeoutMs) => containerMutator.stop(id, seconds, { onOutput, timeoutMs }),
            remove: (id, onOutput, timeoutMs) => containerMutator.remove(id, { onOutput, timeoutMs }),
            markDrain: (id, path, onOutput, timeoutMs) => containerMutator.markDrain(id, path, { onOutput, timeoutMs }),
            sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
            now: () => Date.now(),
            isShuttingDown: () => shuttingDown || operations.isShuttingDown(),
        };
    }

    async function renderRollout(
        name: string,
        csrf: string,
        service: string | null,
        options: { notice?: { kind: NoteKind; text: string }; error?: { title: string; message: string }; status?: number } = {},
    ): Promise<Response> {
        if (!config.rolloutEnabled) throw new StackError("This page does not exist.", 404);
        const context = await resolveProjectContext(stacksRoot, name, provider);
        if (context.kind === "invalid") throw new StackError(ENV_NOT_REGULAR, 409);
        if (context.kind === "ambiguous") {
            throw new StackError("The panel cannot tell which Docker Compose project belongs to this stack.", 409);
        }
        if (context.kind === "unavailable") {
            throw new StackError("Docker did not respond, so rollout readiness could not be checked.", 503);
        }
        if (context.kind === "absent") {
            throw new StackError("This stack is not deployed yet, so there is nothing to roll out.", 409);
        }
        const readiness = await collectRolloutReadiness(context, service);
        if (!readiness.ok) throw new StackError(readiness.reason, 503);
        return htmlResponse(
            rolloutPage({
                stack: name,
                csrf,
                service,
                entries: readiness.entries,
                busy: operations.forStack(name)?.status === "running",
                notice: options.notice,
                error: options.error,
                access,
                timezone: config.timeZone || undefined,
                nav: await sidebarNav("stacks", name),
            }),
            options.status ?? 200,
        );
    }

    async function handleRolloutStart(request: Request, name: string, session: Session): Promise<Response> {
        if (!config.rolloutEnabled) throw new StackError("This page does not exist.", 404);
        const csrf = session.csrf;
        const back = `/stacks/${encodeURIComponent(name)}/rollout`;
        if (!isAllowedOrigin(request, config)) return staleForm(csrf, back);
        const form = await readForm(request);
        if (form === null) return tooLarge(csrf, back);
        if (!safeEqual(form.get("csrf") ?? "", csrf)) return staleForm(csrf, back);
        if (!sessions.isActive(session.id)) return sessionEnded();

        const pendingDeploy = await refusePendingDeploy(request, name, csrf, "rollout");
        if (pendingDeploy) return pendingDeploy;

        const service = (form.get("service") ?? "").trim();
        if (!isComposeServiceName(service)) {
            return renderRollout(name, csrf, service || null, {
                error: { title: "Nothing was run.", message: "This service name is not valid." },
                status: 400,
            });
        }
        const pull = form.get("pull") === "1";

        const context = await resolveProjectContext(stacksRoot, name, provider);
        if (context.kind === "invalid") throw new StackError(ENV_NOT_REGULAR, 409);
        if (context.kind === "ambiguous") {
            throw new StackError("The panel cannot tell which Docker Compose project belongs to this stack. Nothing was run.", 409);
        }
        if (context.kind === "unavailable") {
            throw new StackError("Docker did not respond, so the panel could not check this stack. Nothing was run.", 503);
        }
        if (context.kind === "absent") {
            throw new StackError("This stack is not deployed yet, so there is nothing to roll out.", 409);
        }

        const readiness = await collectRolloutReadiness(context, service);
        if (!readiness.ok) {
            await recordAudit({
                event: "rollout",
                result: "refused",
                actor: clientKey(request, config),
                stack: name,
                action: "rollout",
                service,
                detail: readiness.reason,
            });
            return renderRollout(name, csrf, service, {
                error: { title: "Nothing was run.", message: readiness.reason },
                status: 503,
            });
        }
        const entry = readiness.entries[0];
        if (!entry || !entry.ready || !entry.declaration) {
            const reason = entry?.reason ?? "This service is not ready for a rollout.";
            await recordAudit({
                event: "rollout",
                result: "refused",
                actor: clientKey(request, config),
                stack: name,
                action: "rollout",
                service,
                detail: reason,
            });
            return renderRollout(name, csrf, service, {
                error: { title: "Nothing was run.", message: reason },
                status: 409,
            });
        }

        if (!sessions.isActive(session.id)) {
            await recordAudit({
                event: "rollout",
                result: "refused",
                actor: clientKey(request, config),
                stack: name,
                action: "rollout",
                service,
                detail: "session ended",
            });
            return sessionEnded();
        }

        try {
            if (selfUpdatePending) throw new OperationsDisabledError(SELF_UPDATE_RUNNING);
            operations.startRollout({
                stack: name,
                service,
                project: context.project ?? undefined,
                run: async ({ onOutput, record }) => {
                    if (selfUpdatePending) throw new OperationsDisabledError(SELF_UPDATE_RUNNING);
                    // The authoritative check runs under the per-stack lock.
                    const prepared = await prepareRollout(name, service);
                    if (prepared.kind === "refused") return { refused: prepared.reason };
                    record({ containerId: prepared.preparation.oldContainerId });
                    return runRollout(rolloutDependencies(prepared.context), {
                        target: rolloutTarget(prepared.context),
                        service,
                        pull,
                        operationTimeoutMs: config.operationTimeoutMs,
                        rolloutTimeoutMs: config.rolloutTimeoutMs,
                        onOutput,
                        prepare: async () => ({ ok: true, preparation: prepared.preparation }),
                    });
                },
            });
            await recordAudit({
                event: "rollout",
                result: "started",
                actor: clientKey(request, config),
                stack: name,
                action: "rollout",
                service,
            });
            return redirect(`/stacks/${encodeURIComponent(name)}`, 303);
        } catch (error) {
            if (error instanceof StackBusyError || error instanceof OperationsDisabledError) {
                await recordAudit({
                    event: "rollout",
                    result: "refused",
                    actor: clientKey(request, config),
                    stack: name,
                    action: "rollout",
                    service,
                    detail: error.message,
                });
                return renderRollout(name, csrf, service, {
                    error: { title: "Nothing was run.", message: `${error.message} Nothing was run.` },
                    status: 409,
                });
            }
            throw error;
        }
    }

    function sseError(error: unknown): Response {
        if (error instanceof StackError) return plain(error.message, error.status);
        console.error("Internal error", error);
        return plain("Internal error.", 500);
    }

    async function fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        const method = request.method.toUpperCase();

        // Reject an unexpected Host before any routing. Health probes are
        // exempt so infrastructure checks with a service-name Host still work.
        if (url.pathname !== "/health/live" && !isAllowedHost(request, config)) {
            return plain("Invalid Host header.", 400);
        }

        if (url.pathname === "/health/live") {
            if (method !== "GET") return methodNotAllowed("GET");
            return new Response("ok", { headers: { "Content-Type": "text/plain; charset=utf-8", ...BASE_HEADERS } });
        }
        if (url.pathname === "/styles.css") {
            if (method !== "GET") return methodNotAllowed("GET");
            return new Response(Bun.file(new URL("../public/style.css", import.meta.url)), {
                headers: { "Content-Type": "text/css; charset=utf-8", ...BASE_HEADERS },
            });
        }
        if (url.pathname === "/app.js") {
            if (method !== "GET") return methodNotAllowed("GET");
            return new Response(Bun.file(new URL("../public/app.js", import.meta.url)), {
                headers: { "Content-Type": "text/javascript; charset=utf-8", ...BASE_HEADERS },
            });
        }
        const brandFile = BRAND_FILES[url.pathname];
        if (brandFile) {
            if (method !== "GET") return methodNotAllowed("GET");
            return new Response(Bun.file(new URL(`../public/${brandFile.file}`, import.meta.url)), {
                headers: { "Content-Type": brandFile.type, ...BASE_HEADERS },
            });
        }
        if (url.pathname === "/login") {
            if (method === "GET") return handleLoginGet(request);
            if (method === "POST") return handleLoginPost(request);
            return methodNotAllowed("GET, POST");
        }

        const opEventsMatch = /^\/stacks\/([^/]+)\/operations\/events$/.exec(url.pathname);
        const logEventsMatch = /^\/stacks\/([^/]+)\/logs\/events$/.exec(url.pathname);
        const isEventStream = opEventsMatch !== null || logEventsMatch !== null;
        // The Live refresh replaces page fragments: a login page would end up
        // inside the statistics, so this endpoint answers 401 like an event
        // stream instead of redirecting.
        const isServerStats = url.pathname === "/server/stats";

        // Everything below requires an authenticated session. Event streams
        // answer 401 instead of a login redirect so clients do not parse HTML.
        const cookies = parseCookies(request.headers.get("cookie"));
        const id = cookies[SESSION_COOKIE];
        const session = id ? sessions.get(id) : null;
        if (!session) {
            if (isEventStream || isServerStats) return plain("Unauthorized", 401);
            if (method === "GET" || method === "HEAD") return redirect("/login", 302);
            return sessionEnded();
        }

        if (isEventStream) {
            if (method !== "GET") return methodNotAllowed("GET");
            try {
                if (opEventsMatch) return await handleOperationEvents(decodeName(opEventsMatch[1]!), request, session.id);
                return await handleLogsEvents(decodeName(logEventsMatch![1]!), request, session.id);
            } catch (error) {
                return sseError(error);
            }
        }

        if (url.pathname === "/logout") {
            if (method !== "POST") return methodNotAllowed("POST");
            const form = await readForm(request);
            if (form === null) return plain("Payload too large", 413);
            if (!isAllowedOrigin(request, config) || !safeEqual(form.get("csrf") ?? "", session.csrf)) {
                return staleForm(session.csrf);
            }
            sessions.destroy(session.id);
            closeSessionStreams(session.id);
            await recordAudit({ event: "logout", result: "success", actor: clientKey(request, config) });
            const response = redirect("/login", 303);
            response.headers.append("Set-Cookie", clearedSessionCookie(cookieSecureFor(request, config)));
            return response;
        }

        if (url.pathname === "/new-site/preview" && config.managedSitesEnabled) {
            if (method !== "POST") return methodNotAllowed("POST");
            try {
                return await handlePreviewSite(request, session);
            } catch (error) {
                return routeError(error, session.csrf, "/new-site");
            }
        }
        if (url.pathname === "/new-site" && config.managedSitesEnabled) {
            if (method === "POST") {
                try {
                    return await handleCreateSite(request, session);
                } catch (error) {
                    return routeError(error, session.csrf, "/new-site");
                }
            }
            if (method === "GET") return renderNewSite(session.csrf);
            return methodNotAllowed("GET, POST");
        }
        if (url.pathname === "/new-stack") {
            if (method === "POST") return handleCreate(request, session);
            if (method === "GET") return renderCreate(session.csrf);
            return methodNotAllowed("GET, POST");
        }
        const editMatch = /^\/stacks\/([^/]+)\/edit$/.exec(url.pathname);
        if (editMatch && method === "POST") {
            try {
                return await handleSave(request, decodeName(editMatch[1]!), session);
            } catch (error) {
                return routeError(error, session.csrf, safeName(editMatch[1]!));
            }
        }
        const backupsMatch = /^\/stacks\/([^/]+)\/backups\/purge$/.exec(url.pathname);
        if (backupsMatch) {
            if (method !== "POST") return methodNotAllowed("POST");
            try {
                return await handleBackupPurge(request, decodeName(backupsMatch[1]!), session);
            } catch (error) {
                return routeError(error, session.csrf, safeName(backupsMatch[1]!));
            }
        }
        const regenerateMatch = /^\/stacks\/([^/]+)\/regenerate$/.exec(url.pathname);
        if (regenerateMatch && config.managedSitesEnabled) {
            if (method !== "POST") return methodNotAllowed("POST");
            try {
                return await handleRegenerate(request, decodeName(regenerateMatch[1]!), session);
            } catch (error) {
                return routeError(error, session.csrf, safeName(regenerateMatch[1]!));
            }
        }
        const baselineMatch = /^\/stacks\/([^/]+)\/baseline$/.exec(url.pathname);
        if (baselineMatch && config.managedSitesEnabled) {
            if (method !== "POST") return methodNotAllowed("POST");
            try {
                return await handleBaseline(request, decodeName(baselineMatch[1]!), session);
            } catch (error) {
                return routeError(error, session.csrf, safeName(baselineMatch[1]!));
            }
        }
        const backupAcknowledgeMatch = /^\/stacks\/([^/]+)\/backup\/acknowledge$/.exec(url.pathname);
        if (backupAcknowledgeMatch && config.managedSitesEnabled) {
            if (method !== "POST") return methodNotAllowed("POST");
            try {
                return await handleBackupAcknowledge(request, decodeName(backupAcknowledgeMatch[1]!), session);
            } catch (error) {
                return routeError(error, session.csrf, safeName(backupAcknowledgeMatch[1]!));
            }
        }
        const backupMatch = /^\/stacks\/([^/]+)\/backup$/.exec(url.pathname);
        if (backupMatch && config.managedSitesEnabled) {
            if (method !== "POST") return methodNotAllowed("POST");
            try {
                return await handleBackup(request, decodeName(backupMatch[1]!), session);
            } catch (error) {
                return routeError(error, session.csrf, safeName(backupMatch[1]!));
            }
        }
        const restoreMatch = /^\/stacks\/([^/]+)\/restore$/.exec(url.pathname);
        if (restoreMatch && config.managedSitesEnabled) {
            if (method !== "POST") return methodNotAllowed("POST");
            try {
                return await handleRestore(request, decodeName(restoreMatch[1]!), session);
            } catch (error) {
                return routeError(error, session.csrf, safeName(restoreMatch[1]!));
            }
        }
        const deployAcknowledgeMatch = /^\/stacks\/([^/]+)\/deploy\/acknowledge$/.exec(url.pathname);
        if (deployAcknowledgeMatch && config.managedSitesEnabled) {
            if (method !== "POST") return methodNotAllowed("POST");
            try {
                return await handleDeployAcknowledge(request, decodeName(deployAcknowledgeMatch[1]!), session);
            } catch (error) {
                return routeError(error, session.csrf, safeName(deployAcknowledgeMatch[1]!));
            }
        }
        const deployMatch = /^\/stacks\/([^/]+)\/deploy$/.exec(url.pathname);
        if (deployMatch && config.managedSitesEnabled) {
            if (method !== "POST") return methodNotAllowed("POST");
            try {
                return await handleDeploy(request, decodeName(deployMatch[1]!), session);
            } catch (error) {
                return routeError(error, session.csrf, safeName(deployMatch[1]!));
            }
        }
        const operationsMatch = /^\/stacks\/([^/]+)\/operations$/.exec(url.pathname);
        if (operationsMatch) {
            if (method !== "POST") return methodNotAllowed("POST");
            try {
                return await handleOperation(request, decodeName(operationsMatch[1]!), session);
            } catch (error) {
                return routeError(error, session.csrf, safeName(operationsMatch[1]!));
            }
        }
        const imageCheckMatch = /^\/stacks\/([^/]+)\/image-check$/.exec(url.pathname);
        if (imageCheckMatch) {
            if (method !== "POST") return methodNotAllowed("POST");
            try {
                return await handleImageCheck(request, decodeName(imageCheckMatch[1]!), session);
            } catch (error) {
                return routeError(error, session.csrf, safeName(imageCheckMatch[1]!));
            }
        }
        const rolloutMatch = /^\/stacks\/([^/]+)\/rollout$/.exec(url.pathname);
        if (rolloutMatch && method === "POST") {
            try {
                return await handleRolloutStart(request, decodeName(rolloutMatch[1]!), session);
            } catch (error) {
                return routeError(error, session.csrf, safeName(rolloutMatch[1]!));
            }
        }
        const toolboxMatch = /^\/stacks\/([^/]+)\/actions$/.exec(url.pathname);
        if (toolboxMatch && method === "POST") {
            try {
                return await handleToolboxAction(request, decodeName(toolboxMatch[1]!), session);
            } catch (error) {
                return routeError(error, session.csrf, safeName(toolboxMatch[1]!));
            }
        }
        const caddyAttachMatch = /^\/stacks\/([^/]+)\/domains\/attach$/.exec(url.pathname);
        if (caddyAttachMatch) {
            if (method !== "POST") return methodNotAllowed("POST");
            try {
                return await handleCaddyAttach(request, decodeName(caddyAttachMatch[1]!), session);
            } catch (error) {
                return routeError(error, session.csrf, safeName(caddyAttachMatch[1]!));
            }
        }
        const caddyDetachMatch = /^\/stacks\/([^/]+)\/domains\/detach$/.exec(url.pathname);
        if (caddyDetachMatch) {
            if (method !== "POST") return methodNotAllowed("POST");
            try {
                return await handleCaddyDetach(request, decodeName(caddyDetachMatch[1]!), session);
            } catch (error) {
                return routeError(error, session.csrf, safeName(caddyDetachMatch[1]!));
            }
        }
        if (url.pathname === "/about/check" || url.pathname === "/about/update") {
            if (method !== "POST") return methodNotAllowed("POST");
            try {
                return url.pathname === "/about/check"
                    ? await handleSelfUpdateCheck(request, session)
                    : await handleSelfUpdateStart(request, session);
            } catch (error) {
                return routeError(error, session.csrf);
            }
        }
        if (url.pathname === "/server/maintenance") {
            if (method !== "POST") return methodNotAllowed("POST");
            try {
                return await handleMaintenanceStart(request, session);
            } catch (error) {
                return routeError(error, session.csrf);
            }
        }
        if (method !== "GET" && method !== "HEAD") return methodNotAllowed("GET");

        try {
            if (url.pathname === "/") return await renderStackList(session.csrf);
            if (url.pathname === "/about") {
                // Fixed message only: the query flag is never reflected.
                const notice =
                    url.searchParams.get("checked") === "1"
                        ? { kind: "success" as const, text: "Checked: the latest image of this tag is downloaded." }
                        : undefined;
                return await renderAbout(session.csrf, { notice });
            }
            if (url.pathname === "/server/stats") {
                const response = await handleServerStats(parseMemoryTotalParam(url.searchParams.get("mem")));
                return method === "HEAD" ? withoutBody(response) : response;
            }
            if (url.pathname === "/server")
                return await renderServer(
                    session.csrf,
                    request,
                    url.searchParams.get("maintenance") === "1"
                        ? "Maintenance started. Reload this page to follow the outcome: it does not update by itself."
                        : undefined,
                );
            if (url.pathname === "/audit") return await renderAudit(session.csrf, url.searchParams.get("period"));
            if (url.pathname === "/access") return await renderAccess(session.csrf, request);
            if (url.pathname === "/containers")
                return await renderContainers(session.csrf, parseContainerFilter(url.searchParams.get("state")));
            const containerLogsMatch = /^\/containers\/([^/]+)\/logs$/.exec(url.pathname);
            if (containerLogsMatch) {
                const response = await handleContainerLogs(decodeName(containerLogsMatch[1]!), url.searchParams.get("tail"));
                return method === "HEAD" ? withoutBody(response) : response;
            }
            const containerDetailMatch = /^\/containers\/([^/]+)$/.exec(url.pathname);
            if (containerDetailMatch) return await renderContainerDetail(decodeName(containerDetailMatch[1]!), session.csrf);
            if (editMatch) {
                // Fixed message only: the query flag is never reflected.
                const notice = url.searchParams.get("purged") === "1" ? { kind: "success" as const, text: "Backups deleted." } : undefined;
                return await renderEdit(decodeName(editMatch[1]!), session.csrf, { notice });
            }
            const logSnapshotMatch = /^\/stacks\/([^/]+)\/logs$/.exec(url.pathname);
            if (logSnapshotMatch) {
                const response = await handleLogsSnapshot(decodeName(logSnapshotMatch[1]!), session.id, url.searchParams);
                return method === "HEAD" ? withoutBody(response) : response;
            }
            if (toolboxMatch) return await renderToolbox(decodeName(toolboxMatch[1]!), session.csrf);
            if (rolloutMatch) {
                const serviceParam = url.searchParams.get("service");
                if (serviceParam !== null && !isComposeServiceName(serviceParam)) {
                    return await renderRollout(decodeName(rolloutMatch[1]!), session.csrf, null, {
                        error: { title: "Not found.", message: "This service name is not valid." },
                        status: 400,
                    });
                }
                return await renderRollout(decodeName(rolloutMatch[1]!), session.csrf, serviceParam || null);
            }
            const detailMatch = /^\/stacks\/([^/]+)$/.exec(url.pathname);
            if (detailMatch) {
                // Fixed messages only: the query flag is never reflected.
                const saved = url.searchParams.get("saved");
                const notice =
                    url.searchParams.get("created") === "1"
                        ? {
                              kind: "success" as const,
                              text: "Stack created. No containers were started. Use Up when you are ready to deploy.",
                          }
                        : saved === "1"
                          ? {
                                kind: "success" as const,
                                text: "Saved. The running containers are unchanged: use Up to apply the new configuration.",
                            }
                          : saved === "0"
                            ? { kind: "info" as const, text: "No changes to save: the files on disk already match." }
                            : url.searchParams.get("attached") === "1"
                              ? { kind: "success" as const, text: "Domain attached. Caddy reloaded with the new site." }
                              : url.searchParams.get("detached") === "1"
                                ? { kind: "success" as const, text: "Domain detached. Caddy reloaded without it." }
                                : undefined;
                return await renderStackDetail(decodeName(detailMatch[1]!), session.csrf, notice, 200, url.searchParams);
            }
            return htmlResponse(
                messagePage(
                    "Not found",
                    "This page does not exist.",
                    { href: "/", label: "← Back to all stacks" },
                    pageChrome(session.csrf),
                ),
                404,
            );
        } catch (error) {
            return routeError(error, session.csrf);
        }
    }

    return {
        fetch,
        operations,
        images: imageCheck,
        logs,
        maintenance,
        sseSubscriptions: () => activeSse,
        beginShutdown: async (graceMs: number) => {
            // Refuse everything synchronously first: no new mutation, save or
            // follow can slip in while the drains below are awaited.
            shuttingDown = true;
            shutdownController.abort();
            operations.refuseNew();
            logs.refuseNew();
            maintenance.refuseNew();
            // One shared deadline for operations, saves, checks and follows; unresolved work stays
            // unknown and is never reported as done.
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                await Promise.race([
                    Promise.allSettled([
                        logs.shutdown(graceMs),
                        operations.shutdown(graceMs),
                        maintenance.shutdown(graceMs),
                        imageCheck.shutdown(graceMs),
                        ...saves,
                    ]),
                    new Promise<void>((resolve) => {
                        timer = setTimeout(resolve, graceMs);
                    }),
                ]);
            } finally {
                clearTimeout(timer);
            }
        },
    };
}
