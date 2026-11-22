import type { ComposeService, StackState } from "./compose-state.ts";
import type { OperationAction, OperationView } from "./operations.ts";
import type { AuditEntry } from "./audit.ts";
import type { ImageVersion, ServiceUpdate } from "./updates.ts";
import { normalizeReference } from "./updates.ts";
import type { ImageCheckView, NotTrackedReason, RemoteCheckReason, ServiceRemoteCheck } from "./image-check.ts";
import { metadataUrl, type DeclaredMetadata, type DeployedImage } from "./deployment.ts";
import type { AccessReport, AccessStatus } from "./access.ts";
import {
    ROLLBACK_TAG,
    UPDATER_NAME,
    recoveryCommands,
    rollbackCommands,
    type SelfIdentity,
    type SelfUpdateStatus,
    type UpdaterOutcome,
} from "./self-update.ts";
import {
    matchesContainerFilter,
    type ClassifiedContainer,
    type ContainerCategory,
    type ContainerDetails,
    type ContainerFilter,
} from "./container-state.ts";
import type { ToolboxAction, ToolboxRunner } from "./toolbox.ts";
import type { RolloutDeclaration } from "./rollout.ts";
import { isExplorerHref } from "./database.ts";
import { isValidDomain } from "./caddy.ts";
import { formatBytes } from "./web/format.ts";
import packageJson from "../package.json";
import buildInfo from "./build-info.json";

const BUILD_REVISION =
    typeof buildInfo.revision === "string" && /^[a-f0-9]{7,64}$/i.test(buildInfo.revision) ? buildInfo.revision.slice(0, 12) : null;
const VERSION =
    buildInfo.version === "dev" ? `${packageJson.version}-dev${BUILD_REVISION ? ` + ${BUILD_REVISION}` : ""}` : packageJson.version;

export function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (char) => {
        switch (char) {
            case "&":
                return "&amp;";
            case "<":
                return "&lt;";
            case ">":
                return "&gt;";
            case '"':
                return "&quot;";
            case "'":
                return "&#39;";
            default:
                return char;
        }
    });
}

/**
 * A small ⓘ for secondary details, kept out of the page until asked for.
 * Native popover: works without JavaScript, on touch and with the keyboard.
 * The browser's top layer escapes clipping ancestors. app.js enhances placement
 * near the button; without it the browser centers the popover. Text is escaped.
 */
export function infoTip(text: string, label = "More information"): string {
    const id = `info-${crypto.randomUUID()}`;
    return `<span class="info"><button type="button" popovertarget="${id}" aria-label="${escapeHtml(label)}">i</button><span id="${id}" class="info-body" popover>${escapeHtml(text)}</span></span>`;
}

export type NoteKind = "info" | "success" | "warn" | "error";

/** A message box. `text` is escaped; it is never interpreted as markup. */
export function note(kind: NoteKind, text: string, options: { title?: string; id?: string } = {}): string {
    const role = kind === "error" ? ` role="alert"` : "";
    const id = options.id ? ` id="${escapeHtml(options.id)}"` : "";
    const title = options.title ? `<strong>${escapeHtml(options.title)}</strong> ` : "";
    return `<div class="note note-${kind}"${id}${role}>${title}${escapeHtml(text)}</div>`;
}

/** The primary sections of the panel, in navigation order. */
export type NavSection = "stacks" | "containers" | "server" | "audit" | "access" | "about";

export interface NavigationOptions {
    /** Valid stack names (from `listStacks`), shown as a switcher. Names only, no state. */
    stacks: string[];
    /** The section the current page belongs to, marked `aria-current`. */
    section: NavSection;
    /** The stack being viewed, when the page is about one stack. */
    stack?: string;
}

export interface DocumentOptions {
    /** When set, the header renders an authenticated sign-out form using this CSRF token. */
    logoutCsrf?: string;
    /** How the panel is reached, shown in the footer (e.g. "127.0.0.1:5081 (loopback)"). */
    access?: string;
    /** Same-origin scripts to load with defer (e.g. "/app.js"). */
    scripts?: string[];
    /**
     * IANA display time zone (e.g. "Europe/Brussels"). When absent, the client
     * uses the reader's browser zone. Never user input; escaped before output.
     */
    timezone?: string;
    /** Standalone centered page without header and footer (sign-in, signed out). */
    bare?: boolean;
    /** When set, renders the authenticated navigation sidebar. */
    nav?: NavigationOptions;
    /**
     * Reload the page after this many seconds. Used while a background image
     * check runs, so the result is shown without JavaScript; the server keeps
     * the refresh off every other page.
     */
    refreshSeconds?: number;
}

const NAV_SECTIONS: readonly [NavSection, string, string][] = [
    ["stacks", "/", "Stacks"],
    ["containers", "/containers", "Containers"],
    ["server", "/server", "Server"],
    ["audit", "/audit", "Activity log"],
    ["access", "/access", "Access"],
    ["about", "/about", "About"],
];

/**
 * Authenticated navigation. Sections and the stack list are server-rendered
 * links; the disclosure starts closed (app.js opens it on wide screens) and
 * the local search is progressive enhancement. Only names are shown: no
 * state, counter or badge here.
 */
export function renderSidebar(nav: NavigationOptions): string {
    const sections = NAV_SECTIONS.map(([key, href, label]) => {
        const current = key === nav.section ? ` aria-current="page"` : "";
        return `<a href="${href}"${current}>${escapeHtml(label)}</a>`;
    }).join("");
    const hasStacks = nav.stacks.length > 0;
    const items = nav.stacks
        .map((name) => {
            const current = name === nav.stack;
            return `<li${current ? ` class="is-current"` : ""}><a href="/stacks/${encodeURIComponent(name)}"${current ? ` aria-current="page"` : ""}>${escapeHtml(name)}</a></li>`;
        })
        .join("");
    const search = hasStacks
        ? `<input type="search" class="nav-search" id="nav-search" placeholder="Filter stacks" aria-label="Filter stacks" autocomplete="off" spellcheck="false" data-nav-search>`
        : "";
    const list = hasStacks
        ? `<ul class="nav-list" id="nav-list">${items}</ul><p class="nav-empty muted" id="nav-empty" hidden>No stack matches.</p>`
        : `<p class="nav-empty muted">No stacks yet.</p>`;
    return `<details class="sidebar">
<summary class="sidebar-summary">Navigation</summary>
<div class="sidebar-body">
<nav class="nav-sections" aria-label="Sections">${sections}</nav>
<div class="nav-stacks"><p class="nav-heading">Your stacks</p>${search}${list}</div>
</div>
</details>`;
}

export function documentHtml(title: string, body: string, options: DocumentOptions = {}): string {
    // 'body' must contain ONLY trusted markup assembled with escapeHtml().
    const logout = options.logoutCsrf
        ? `<div class="session"><form method="post" action="/logout" class="logout"><input type="hidden" name="csrf" value="${escapeHtml(options.logoutCsrf)}"><button type="submit" class="btn btn-quiet">Sign out</button></form></div>`
        : "";
    // Every page with navigation needs app.js (drawer sync, stack filter):
    // default it here so no page can forget it.
    const scripts = (options.scripts ?? (options.nav ? ["/app.js"] : []))
        .map((src) => `<script src="${escapeHtml(src)}" defer></script>`)
        .join("");
    const timezone = options.timezone ? ` data-timezone="${escapeHtml(options.timezone)}"` : "";
    const refresh =
        options.refreshSeconds && options.refreshSeconds > 0
            ? `<meta http-equiv="refresh" content="${Math.min(Math.floor(options.refreshSeconds), 60)}">`
            : "";
    const content = options.nav
        ? `<div class="layout"><aside class="sidebar-wrap">${renderSidebar(options.nav)}</aside><main>${body}</main></div>`
        : `<main>${body}</main>`;
    return `<!doctype html>
<html lang="en"${timezone}>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" media="(prefers-color-scheme: light)" content="#F4F4F2">
  <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0E0E10">
  ${refresh}
  <title>${escapeHtml(title)} · Compose Panel</title>
  <link rel="stylesheet" href="/styles.css">
  <link id="favicon-svg" rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  ${scripts}
</head>
<body>
  ${
      options.bare
          ? `<main class="bare">${body}</main>`
          : `<div class="shell">
    <header><a href="/" class="brand"><img src="/brand-mark.svg" alt="" width="20" height="20">Compose Panel</a>${logout}</header>
    ${content}
    <footer>Compose Panel ${escapeHtml(VERSION)}${options.access ? ` · ${escapeHtml(options.access)}` : ""}</footer>
  </div>`
  }
</body>
</html>`;
}

/** A simple page with a heading, a message and a way back. */
export function messagePage(title: string, message: string, back: { href: string; label: string }, options: DocumentOptions = {}): string {
    const content = `<h1>${escapeHtml(title)}</h1><p class="lead">${escapeHtml(message)}</p><p><a href="${escapeHtml(back.href)}">${escapeHtml(back.label)}</a></p>`;
    return documentHtml(title, options.bare ? `<div class="login card">${content}</div>` : content, options);
}

export function loginPage(options: { csrf: string; error?: string | null }): string {
    const error = options.error ? note("error", options.error) : "";
    return documentHtml(
        "Sign in",
        `<div class="login card">
<picture><source media="(prefers-color-scheme: dark)" srcset="/icon-boot-on-dark.svg"><img src="/icon-boot-on-light.svg" alt="" width="64" height="64" class="login-mark"></picture>
<h1>Compose Panel</h1>
<p class="muted">Sign in to manage your stacks.</p>${error}
<form method="post" action="/login" class="form">
  <input type="hidden" name="csrf" value="${escapeHtml(options.csrf)}">
  <label>Username <input name="user" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus></label>
  <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
  <button type="submit" class="btn btn-primary">Sign in</button>
</form>
</div>`,
        { bare: true },
    );
}

export interface EditPageOptions {
    name: string;
    csrf: string;
    access?: string;
    timezone?: string;
    nav?: NavigationOptions;
    composeFilename: string;
    composeSource: string;
    composeHash: string;
    envSource: string;
    envHash: string;
    envExists: boolean;
    error?: { title: string; message: string } | null;
    notice?: { kind: NoteKind; text: string };
    /** null when the backup folder could not be read. */
    backups: { count: number; bytes: number; retain: number } | null;
}

export function createStackPage(options: {
    csrf: string;
    root: string;
    name?: string;
    composeSource?: string;
    envSource?: string;
    error?: string;
    access?: string;
    timezone?: string;
    nav?: NavigationOptions;
}): string {
    return documentHtml(
        "New stack",
        `<p class="crumbs"><a href="/">← All stacks</a></p>
<h1>New stack</h1>
<p class="lead">Create a folder under <code>${escapeHtml(options.root)}</code> with your Compose file and optional variables. The files are checked before the stack becomes available. Creating a stack does not pull images or start containers.</p>
${options.error ? note("error", options.error) : ""}
<form method="post" action="/new-stack" class="form edit-form" data-edit-form>
  <input type="hidden" name="csrf" value="${escapeHtml(options.csrf)}">
  <label>Stack name <span class="hint">Lowercase letters, digits, hyphens and underscores; up to 63 characters. An existing folder cannot be replaced.</span>
    <input type="text" name="name" value="${escapeHtml(options.name ?? "")}" pattern="[a-z0-9][a-z0-9_-]{0,62}" maxlength="63" autocapitalize="none" spellcheck="false" required autofocus>
  </label>
  <label>compose.yaml <textarea name="compose" rows="24" spellcheck="false" autocapitalize="none" required data-code>${escapeHtml(options.composeSource ?? "")}</textarea></label>
  <label>.env <span class="hint">Optional. Leave empty to create only the Compose file. Do not paste secrets into Compose labels.</span>
    <textarea name="env" rows="10" spellcheck="false" autocapitalize="none" data-sensitive data-code>${escapeHtml(options.envSource ?? "")}</textarea>
  </label>
  <div class="form-actions"><button type="submit" class="btn btn-primary" data-busy-label="Checking and creating…">Check and create stack</button><a href="/" class="btn">Cancel</a></div>
</form>`,
        { logoutCsrf: options.csrf, access: options.access, timezone: options.timezone, nav: options.nav, scripts: ["/app.js"] },
    );
}

export interface NewSiteDraft {
    name: string;
    siteId: string;
    project: string;
    port: string;
    channel: string;
    gitUrl: string;
    gitRef: string;
    paths: string;
    composer: boolean;
}

export interface ManagedSiteChannel {
    id: string;
    label: string;
    image: string;
}

export function newSitePage(options: {
    csrf: string;
    root: string;
    channels: readonly ManagedSiteChannel[];
    draft?: Partial<NewSiteDraft>;
    error?: string;
    access?: string;
    timezone?: string;
    nav?: NavigationOptions;
}): string {
    const draft = options.draft ?? {};
    const channels = options.channels
        .map(
            (channel) =>
                `<option value="${escapeHtml(channel.id)}"${channel.id === draft.channel ? " selected" : ""}>${escapeHtml(channel.label)} (${escapeHtml(channel.image)})</option>`,
        )
        .join("");
    return documentHtml(
        "New managed site",
        `<p class="crumbs"><a href="/">← All stacks</a></p>
<h1>New managed site</h1>
<p class="lead">Create one PHP site under <code>${escapeHtml(options.root)}</code> from a fixed runtime profile. The panel writes a trusted <code>compose-panel-site.json</code>, a generated Compose file and an approved gateway configuration. It does not fetch code, pull an image or start a container: publish the first release, then start the site.</p>
${options.error ? note("error", options.error) : ""}
<form method="post" action="/new-site" class="form">
  <input type="hidden" name="csrf" value="${escapeHtml(options.csrf)}">
  <label>Folder name <span class="hint">Lowercase letters, digits, hyphens and underscores; up to 63 characters. An existing folder is never replaced.</span>
    <input type="text" name="name" value="${escapeHtml(draft.name ?? "")}" pattern="[a-z0-9][a-z0-9_-]{0,62}" maxlength="63" autocapitalize="none" spellcheck="false" required autofocus>
  </label>
  <label>Site ID <span class="hint">Opaque and immutable; defaults to the folder name. Changing a domain never moves the site data.</span>
    <input type="text" name="siteId" value="${escapeHtml(draft.siteId ?? "")}" pattern="[a-z0-9][a-z0-9-]{2,63}" maxlength="64" autocapitalize="none" spellcheck="false">
  </label>
  <label>Compose project <span class="hint">Exact project name; defaults to the folder name. It is never inferred later from the folder.</span>
    <input type="text" name="project" value="${escapeHtml(draft.project ?? "")}" pattern="[a-z0-9][a-z0-9_-]{0,62}" maxlength="63" autocapitalize="none" spellcheck="false">
  </label>
  <label>Gateway loopback port <span class="hint">Reserved managed-site range 41000-41999. Keep it stable across releases; detach any domain before changing it.</span>
    <input type="number" name="port" value="${escapeHtml(draft.port ?? "")}" min="41000" max="41999" step="1" inputmode="numeric" required>
  </label>
  <label>Runtime channel
    <select name="channel" required><option value="">Choose a pinned channel…</option>${channels}</select>
  </label>
  <label>Git URL <span class="hint">Public HTTPS or a private SSH URL. No password or token in the URL.</span>
    <input type="url" name="gitUrl" value="${escapeHtml(draft.gitUrl ?? "")}" maxlength="2048" autocapitalize="none" spellcheck="false" required>
  </label>
  <label>Branch <span class="hint">Fully qualified, for example refs/heads/main. A short name or a wildcard is refused.</span>
    <input type="text" name="gitRef" value="${escapeHtml(draft.gitRef ?? "refs/heads/main")}" maxlength="255" autocapitalize="none" spellcheck="false" required>
  </label>
  <label>Persistent paths <span class="hint">Optional, one per line. Each path must stay below <code>shared/</code>; it is mounted writable into PHP only.</span>
    <textarea name="paths" rows="4" spellcheck="false" autocapitalize="none">${escapeHtml(draft.paths ?? "")}</textarea>
  </label>
  <p><label><input type="checkbox" name="composer" value="on"${draft.composer ? " checked" : ""}> Install Composer dependencies in each release</label></p>
  <p class="hint">Optional. The repository must commit <code>composer.lock</code> and declare <code>config.platform.php</code> for the channel. Dependencies are installed in a disposable container with no scripts, plugins, secrets or Docker socket.</p>
  <div class="form-actions">
    <button type="submit" formaction="/new-site/preview" class="btn">Preview files</button>
    <button type="submit" class="btn btn-primary" data-busy-label="Creating…">Create site</button>
    <a href="/" class="btn">Cancel</a>
  </div>
</form>`,
        { logoutCsrf: options.csrf, access: options.access, timezone: options.timezone, nav: options.nav, scripts: ["/app.js"] },
    );
}

export function newSitePreviewPage(options: {
    csrf: string;
    draft: NewSiteDraft;
    manifestSource: string;
    compose: string;
    gateway: string;
    opcache: string;
    access?: string;
    timezone?: string;
    nav?: NavigationOptions;
}): string {
    const hidden = (
        [
            ["name", options.draft.name],
            ["siteId", options.draft.siteId],
            ["project", options.draft.project],
            ["port", options.draft.port],
            ["channel", options.draft.channel],
            ["gitUrl", options.draft.gitUrl],
            ["gitRef", options.draft.gitRef],
            ["composer", options.draft.composer ? "on" : ""],
        ] as const
    )
        .map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`)
        .join("");
    return documentHtml(
        "Preview managed site",
        `<p class="crumbs"><a href="/new-site">← New managed site</a></p>
<h1>Preview managed site</h1>
<p class="lead">Nothing has been written. Check the trusted manifest and the generated files; creating the site writes exactly these bytes and validates the Compose file in its final folder.</p>
${note("info", "After creation, publish the first release before starting the site. The gateway is bound to 127.0.0.1 and is not exposed until you attach a domain.")}
<dl class="meta"><dt>Folder</dt><dd><code>${escapeHtml(options.draft.name)}</code></dd><dt>Site</dt><dd><code>${escapeHtml(options.draft.siteId)}</code></dd><dt>Project</dt><dd><code>${escapeHtml(options.draft.project)}</code></dd><dt>Gateway</dt><dd><code>127.0.0.1:${escapeHtml(options.draft.port)}</code></dd><dt>Composer</dt><dd>${options.draft.composer ? "installed in each release" : "not used"}</dd></dl>
<h2>compose-panel-site.json</h2>
<pre class="output">${escapeHtml(options.manifestSource)}</pre>
<h2>compose.yaml</h2>
<pre class="output">${escapeHtml(options.compose)}</pre>
<h2>generated/nginx-site.conf</h2>
<pre class="output">${escapeHtml(options.gateway)}</pre>
<h2>generated/opcache.ini</h2>
<pre class="output">${escapeHtml(options.opcache)}</pre>
<form method="post" action="/new-site" class="form">
  <input type="hidden" name="csrf" value="${escapeHtml(options.csrf)}">
  ${hidden}
  <textarea name="paths" hidden>${escapeHtml(options.draft.paths)}</textarea>
  <div class="form-actions">
    <button type="submit" class="btn btn-primary" data-busy-label="Creating…">Create site</button>
    <a href="/new-site" class="btn">Cancel</a>
  </div>
</form>`,
        { logoutCsrf: options.csrf, access: options.access, timezone: options.timezone, nav: options.nav, scripts: ["/app.js"] },
    );
}

function backupsSection(name: string, csrf: string, backups: EditPageOptions["backups"]): string {
    const head = `<section class="card"><h2>Backups</h2>`;
    if (backups === null)
        return `${head}${note("warn", "The backup folder could not be read, so backups are not listed. Saving still makes a backup or reports why it cannot.")}</section>`;
    const policy = `The panel keeps the ${backups.retain} most recent backups of each file and deletes older ones after a save.`;
    if (backups.count === 0) return `${head}<p class="muted">No backups yet. ${escapeHtml(policy)}</p></section>`;
    const files = backups.count === 1 ? "1 backup" : `${backups.count} backups`;
    return (
        `${head}<p class="muted">${files} (${escapeHtml(formatBytes(backups.bytes))}) in <code>.compose-panel/backups/${escapeHtml(name)}/</code>. ${escapeHtml(policy)}</p>` +
        `<details class="confirm"><summary><span class="btn btn-danger">Delete all backups…</span></summary>` +
        `<div class="confirm-panel">${note("warn", "Previous versions of the Compose file and .env of this stack are deleted for good. The current files are not affected. Click the button above again to cancel.")}` +
        `<form method="post" action="/stacks/${encodeURIComponent(name)}/backups/purge"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">` +
        `<button type="submit" class="btn btn-danger" data-busy-label="Deleting…">Yes, delete ${files}</button></form></div></details></section>`
    );
}

export function editPage(options: EditPageOptions): string {
    const error = options.error ? note("error", options.error.message, { title: options.error.title }) : "";
    const notice = options.notice ? note(options.notice.kind, options.notice.text) : "";
    const stackHref = `/stacks/${encodeURIComponent(options.name)}`;
    const envHint = options.envExists
        ? "Variables for this stack. Values are secret: they are never logged and are hidden from error messages."
        : "This stack has no .env file. One is created only if you type something here.";
    return documentHtml(
        `Edit ${options.name}`,
        `<p class="crumbs"><a href="${stackHref}">← ${escapeHtml(options.name)}</a></p>
<h1>Edit files</h1>
<p class="lead">Changes are checked with <code>docker compose config</code> before anything is written. If the check fails, nothing changes on disk. Each save keeps a backup of the previous version. Saving does <strong>not</strong> restart anything: use <em>Up</em> on the stack page to apply the changes.</p>
${error}${notice}
<form method="post" action="${stackHref}/edit" class="form edit-form" data-edit-form>
  <input type="hidden" name="csrf" value="${escapeHtml(options.csrf)}">
  <input type="hidden" name="composeHash" value="${escapeHtml(options.composeHash)}">
  <input type="hidden" name="envHash" value="${escapeHtml(options.envHash)}">
  <input type="hidden" name="envExists" value="${options.envExists ? "1" : "0"}">
  <label>${escapeHtml(options.composeFilename)}
    <textarea name="compose" rows="24" spellcheck="false" autocapitalize="none" required data-code>${escapeHtml(options.composeSource)}</textarea>
  </label>
  <label>.env <span class="hint">${escapeHtml(envHint)}</span>
    <textarea name="env" rows="12" spellcheck="false" autocapitalize="none" data-sensitive data-code>${escapeHtml(options.envSource)}</textarea>
  </label>
  <div class="form-actions">
    <button type="submit" class="btn btn-primary" data-busy-label="Checking and saving…">Check and save</button>
    <a href="${stackHref}" class="btn">Cancel</a>
  </div>
    </form>
${backupsSection(options.name, options.csrf, options.backups)}`,
        { logoutCsrf: options.csrf, access: options.access, timezone: options.timezone, scripts: ["/app.js"], nav: options.nav },
    );
}

const STATE_LABELS: Record<string, string> = {
    running: "Running",
    stopped: "Stopped",
    "not-created": "Not deployed",
    unknown: "Unknown",
};

/** Declared deployment owner: informational, never a trust or permission signal. */
export function managedByBadge(owner: string | null): string {
    return owner ? `<span class="state state-managed">Managed by ${escapeHtml(owner)}</span>` : "";
}

export function stateBadge(state: string): string {
    return `<span class="state state-${escapeHtml(state)}">${escapeHtml(STATE_LABELS[state] ?? state)}</span>`;
}

/** Badge for a single container as reported by `docker compose ps`. */
function serviceBadge(service: ComposeService): string {
    const state = service.state.toLowerCase();
    if (state === "exited") {
        // An init job that exited 0 is finished, not broken. A non-zero code is
        // not necessarily a crash either: `docker stop` itself yields 137/143.
        const done = service.exitCode === 0;
        const label = service.exitCode === null ? "Exited" : `Exited (code ${service.exitCode})`;
        return `<span class="state ${done ? "state-done" : "state-stopped"}">${escapeHtml(label)}</span>`;
    }
    const cls = state === "running" ? "state-running" : state === "restarting" || state === "dead" ? "state-failed" : "state-stopped";
    const label = state.charAt(0).toUpperCase() + state.slice(1);
    return `<span class="state ${cls}">${escapeHtml(label)}</span>`;
}

const HEALTH_LABELS: Record<string, string> = { healthy: "Healthy", unhealthy: "Unhealthy", starting: "Starting" };

/**
 * Health is Docker's own check result, a separate badge next to the run-state
 * badge (never merged into it). Nothing is shown without a health check.
 */
function healthBadge(health: string | null): string {
    if (!health) return "";
    const key = health.toLowerCase();
    const cls = key === "healthy" ? "state-done" : key === "unhealthy" ? "state-failed" : "state-stopped";
    return `<span class="state ${cls}" title="Docker health check">${escapeHtml(HEALTH_LABELS[key] ?? health)}</span>`;
}

/**
 * Stack-level health marker, kept apart from the run-state badge: a container
 * can be Running while Docker's health check fails. Empty when nothing is wrong.
 */
export function healthSummaryBadge(services: ComposeService[]): string {
    const count = (value: string) => services.filter((service) => (service.health ?? "").toLowerCase() === value).length;
    const unhealthy = count("unhealthy");
    if (unhealthy > 0) return `<span class="state state-failed">Health: ${unhealthy} unhealthy</span>`;
    const starting = count("starting");
    if (starting > 0) return `<span class="state state-stopped">Health: ${starting} starting</span>`;
    return "";
}

function versionText(version: ImageVersion): string {
    return version.version ?? (version.created ? `built ${version.created}` : (version.digest ?? "unknown version"));
}

export function deploymentSection(deployed: DeployedImage[] = [], declared?: DeclaredMetadata | null, showDeployed = true): string {
    const link = (value: string): string => {
        const href = metadataUrl(value);
        return href
            ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(value)} ↗</a>`
            : escapeHtml(value);
    };
    const field = (label: string, value: string | null, url = false): string =>
        value ? `<dt>${escapeHtml(label)}</dt><dd>${url ? link(value) : `<code>${escapeHtml(value)}</code>`}</dd>` : "";
    const images = deployed
        .map(
            (image) => `<article><h3>${escapeHtml(image.service)} <small>${escapeHtml(image.container)}</small></h3><dl>
${field("Version", image.version)}${field("Revision", image.revision)}${field("Source", image.source, true)}${field("Image ID", image.imageId)}
${image.digests.map((digest) => field("Repository digest", digest)).join("")}</dl></article>`,
        )
        .join("");
    const labels = Object.entries(declared ?? {})
        .map(([service, values]) => {
            const fields = Object.entries(values)
                .map(([key, value]) => field(key.slice(6), value, key.endsWith(".url") || key === "stack.source"))
                .join("");
            return fields ? `<article><h3>${escapeHtml(service)}</h3><dl>${fields}</dl></article>` : "";
        })
        .join("");
    const declaredBlock = labels
        ? `<details><summary>Declared Compose metadata</summary><p class="muted">Resolved labels from the current Compose file. These may differ from the deployed containers.</p>${labels}</details>`
        : "";
    const warning =
        declared === null
            ? note("warn", "Declared Compose metadata could not be read. Check the Compose file, .env and Docker availability.")
            : "";
    if (!showDeployed && !declaredBlock && !warning) return "";
    const heading = showDeployed ? "Deployed version" : "Deployment metadata";
    const deployedBlock = showDeployed
        ? images || `<p class="muted">Deployed image metadata is unavailable. No version is inferred from an image tag.</p>`
        : "";
    return `<section class="card deployment"><h2>${heading}</h2>${deployedBlock}${warning}${declaredBlock}</section>`;
}

/**
 * External database explorer link (ADR 0027). Rendered only when the stack
 * declares an `x-compose-panel.database` extension and the panel has a global
 * explorer URL, or to report an invalid declaration. The panel never contacts
 * the explorer: this is a plain external link, opened without referrer or
 * opener access. The link carries only public, bounded query parameters, never
 * a secret.
 */
export function databaseSection(
    explorer: { url: string; label: string | null; query: Record<string, string> } | null,
    error: string | null = null,
): string {
    if (!explorer) {
        return error ? `<section class="card database"><h2>Database</h2>${note("warn", error)}</section>` : "";
    }
    const link = isExplorerHref(explorer.url)
        ? `<p><a class="btn" href="${escapeHtml(explorer.url)}" target="_blank" rel="noopener noreferrer">Explore the database ↗</a></p>`
        : note("warn", "The configured database explorer URL is not valid, so no link is shown.");
    const context = [
        explorer.label ? escapeHtml(explorer.label) : "",
        ...Object.entries(explorer.query).map(([key, value]) => `<code>${escapeHtml(key)}=${escapeHtml(value)}</code>`),
    ]
        .filter(Boolean)
        .join(" · ");
    const meta = context ? `<p class="meta">${context}</p>` : "";
    return `<section class="card database"><h2>Database</h2>${meta}${link}</section>`;
}

/** A domain the helper reports as attached to a stack (ADR 0030). */
export interface AttachedDomain {
    domain: string;
    service: string;
    port: number;
}

/** A host port a running container of the stack publishes (ADR 0030). */
export interface PublishedUpstream {
    service: string;
    /** Container side, e.g. "3000/tcp". */
    container: string;
    /** Host binding as Docker reports it, e.g. "0.0.0.0:3080". */
    host: string;
    port: number;
    /** Exactly what the managed file dials: TCP on 127.0.0.1. */
    eligible: boolean;
}

export interface DomainsSectionOptions {
    stackName: string;
    csrf: string;
    /** Service names from Docker, offered as suggestions. */
    services: string[];
    /** Ports published by running containers; null when Docker could not tell. */
    published?: PublishedUpstream[] | null;
    /** Declared deployment owner (`stack.managed-by`), if any. */
    owner: string | null;
    /** Domains the helper reports for this stack. */
    attached: AttachedDomain[];
    /** Set when the helper status could not be read; the page stays 200. */
    statusError: string | null;
    /** Whether the helper socket is configured (real attach/detach). */
    socketReady: boolean;
    preview: { domain: string; service: string; port: string; file: string | null; error: string | null; hasInput: boolean };
    /** Domain awaiting detach confirmation (two-step, works without JS). */
    confirmDetach: string | null;
}

/**
 * Caddy site management (ADR 0030). One card with three parts: the attached
 * domains with an Open-application link and a two-step Detach, a shared form
 * for Attach (POST, only with a configured helper) and the GET preview of the
 * managed file (never a mutation). Stacks with a declared external owner get
 * a read-only card instead of the forms. Every dynamic value is escaped; the
 * domain link is only built for a strictly valid domain.
 */
export function domainsSection(options: DomainsSectionOptions): string {
    const { stackName, csrf, services, owner, attached, statusError, socketReady, preview, confirmDetach } = options;
    const published = options.published ?? null;
    const href = `/stacks/${encodeURIComponent(stackName)}`;
    const list =
        attached.length === 0
            ? `<p class="muted">No domains attached.</p>`
            : `<ul class="domains-list">${attached
                  .map((site) => {
                      const open = isValidDomain(site.domain)
                          ? `<a href="https://${escapeHtml(site.domain)}" target="_blank" rel="noopener noreferrer">${escapeHtml(site.domain)} ↗</a>`
                          : `<code>${escapeHtml(site.domain)}</code>`;
                      const detach =
                          !owner && socketReady
                              ? confirmDetach === site.domain
                                  ? `<form method="post" action="${href}/domains/detach" class="form inline-form"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="domain" value="${escapeHtml(site.domain)}"><input type="hidden" name="confirm" value="1"><button type="submit" class="btn btn-danger">Confirm detach</button> <a href="${href}" class="btn">Cancel</a></form>`
                                  : `<form method="post" action="${href}/domains/detach" class="form inline-form"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="domain" value="${escapeHtml(site.domain)}"><button type="submit" class="btn">Detach</button></form>`
                              : "";
                      return `<li>${open} <span class="meta"><code>${escapeHtml(site.service)}</code> · <code>127.0.0.1:${escapeHtml(String(site.port))}</code></span>${detach}</li>`;
                  })
                  .join("")}</ul>`;
    const status = statusError ? note("warn", statusError) : "";
    if (owner) {
        return `<section class="card domains"><h2>Domains</h2>${note("info", `Routing for this stack is managed externally (${owner}). Domains are shown here for information only and cannot be attached from this panel.`)}${status}${list}</section>`;
    }
    const explanation = socketReady
        ? `<p class="muted">Attaching validates the service and port, publishes the Caddy file and reloads Caddy. Only TCP ports bound to 127.0.0.1 are eligible. DNS and HTTPS are not checked by the panel.</p>`
        : note(
              "info",
              "Preview only: the helper is not configured, so nothing can be attached. See the deployment guide to enable domain management.",
          );
    const serviceOptions = services.map((name) => `<option value="${escapeHtml(name)}">`).join("");
    // Only the Attach submitter sends the CSRF token, keeping it out of GET preview URLs.
    const attachButton = socketReady
        ? `<button type="submit" class="btn btn-primary" name="csrf" value="${escapeHtml(csrf)}">Attach domain</button>`
        : "";
    const required = socketReady ? " required" : "";
    const form = `<form method="${socketReady ? "post" : "get"}" action="${socketReady ? `${href}/domains/attach` : href}" class="form domains-form">
        <label>Domain <input type="text" name="${socketReady ? "domain" : "caddyDomain"}" value="${escapeHtml(preview.domain)}" placeholder="app.example.com" autocomplete="off" spellcheck="false"${required}></label>
        <label>Target service <input type="text" name="${socketReady ? "service" : "caddyService"}" value="${escapeHtml(preview.service)}" placeholder="web" list="caddy-services" autocomplete="off" spellcheck="false"${required}><datalist id="caddy-services">${serviceOptions}</datalist></label>
        <label>Local upstream port <input type="text" name="${socketReady ? "port" : "caddyPort"}" value="${escapeHtml(preview.port)}" placeholder="8080" list="caddy-ports" autocomplete="off" spellcheck="false" inputmode="numeric"${required}>${portOptions("caddy-ports", published)}</label>
        <div class="form-actions">${attachButton}<button type="submit" class="btn" formmethod="get" formaction="${href}" formnovalidate>Preview configuration</button></div>
    </form>`;
    const output = preview.error
        ? note("warn", preview.error)
        : preview.file
          ? `<details open><summary>Generated Caddy configuration</summary><pre class="output">${escapeHtml(preview.file)}</pre></details>`
          : "";
    return `<section class="card domains"><h2>Domains</h2>${status}${list}${publishedPorts(published)}${socketReady ? "" : explanation}${form}${socketReady ? explanation : ""}${output}</section>`;
}

/** Eligible host ports as suggestions for the port field. */
function portOptions(id: string, published: PublishedUpstream[] | null): string {
    const eligible = (published ?? []).filter((entry) => entry.eligible);
    if (eligible.length === 0) return "";
    const options = eligible
        .map((entry) => `<option value="${entry.port}" label="${escapeHtml(`${entry.service} → ${entry.container}`)}">`)
        .join("");
    return `<datalist id="${id}">${options}</datalist>`;
}

/**
 * What the running containers publish, so the right host port can be picked:
 * the host side (not the container side) and only on 127.0.0.1.
 */
function publishedPorts(published: PublishedUpstream[] | null): string {
    if (published === null) return "";
    if (published.length === 0) {
        return `<p class="muted">No running container of this stack publishes a port. Publish one on 127.0.0.1 (for example <code>127.0.0.1:3080:3000</code>) and run Up.</p>`;
    }
    const items = published
        .map((entry) => {
            const mark = entry.eligible ? `<span class="state state-running">Eligible</span>` : `<span class="state">Not eligible</span>`;
            return `<li><code>${escapeHtml(entry.service)}</code> · <code>${escapeHtml(entry.host)}</code> → <code>${escapeHtml(entry.container)}</code> ${mark}</li>`;
        })
        .join("");
    const other = published.find((entry) => !entry.eligible);
    const hint = other
        ? `<p class="muted">Only TCP ports published on 127.0.0.1 can be attached, by their host-side port. To make one eligible, bind it to 127.0.0.1 in the Compose file (for example <code>127.0.0.1:${other.port}:${escapeHtml(other.container.split("/")[0] ?? "")}</code>), then run Up.</p>`
        : "";
    return `<details class="domains-ports" open><summary>Published ports</summary><ul>${items}</ul>${hint}</details>`;
}

/** "1.27.1 → 1.27.2"; when both sides read the same, the digests tell them apart. */
function updateSides(update: ServiceUpdate): [string, string] {
    const from = versionText(update.from);
    const to = versionText(update.to);
    if (from !== to) return [from, to];
    return [`${from} (${update.from.digest ?? "?"})`, `${to} (${update.to.digest ?? "?"})`];
}

/**
 * "1.27.1 → 1.27.2"; when both sides read the same, the digests tell them
 * apart. Version strings come from untrusted image labels, so both sides are
 * HTML-escaped: the result is safe to interpolate into markup.
 */
export function updateText(update: ServiceUpdate): string {
    const [from, to] = updateSides(update);
    return `${escapeHtml(from)} → ${escapeHtml(to)}`;
}

function imageCell(service: ComposeService, update: ServiceUpdate | undefined): string {
    if (!service.image) return `<span class="muted">—</span>`;
    // A locally built image without a tag is reported by its full ID: show the
    // short form (as `docker images` does) and keep the full one as a tooltip.
    const id = /^sha256:([0-9a-f]{64})$/.exec(service.image);
    const image = id
        ? `<code title="${escapeHtml(service.image)}">${escapeHtml(id[1]!.slice(0, 12))}</code>`
        : `<code>${escapeHtml(service.image)}</code>`;
    if (!update) return image;
    // Link targets come from image labels: validated as http(s) in updates.ts,
    // escaped here, and opened without referrer or opener access.
    const link = update.link
        ? ` <a href="${escapeHtml(update.link.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(update.link.label)} ↗</a>`
        : "";
    return `${image}<div class="update"><span class="state state-update">Update ready</span> <span><span class="version">${escapeHtml(updateSides(update)[0])}</span> → <span class="version">${escapeHtml(updateSides(update)[1])}</span></span>${link}</div>`;
}

/** One sentence per unknown reason; raw registry output is never shown. */
const REMOTE_REASON_TEXT: Record<RemoteCheckReason, string> = {
    "not-found": "the registry has no such tag",
    unauthorized: "the registry refused access; check the Docker client configuration",
    "rate-limited": "the registry is rate limiting requests",
    timeout: "the registry did not answer in time",
    "invalid-output": "Docker returned an unexpected answer",
    unsupported: "this Docker installation cannot read registries",
    "no-local-digest": "no local digest is recorded for this tag yet; use Pull first",
    "ambiguous-local-digest": "several local digests are recorded for this repository, so the tag cannot be identified",
};

const NOT_TRACKED_TEXT: Record<NotTrackedReason, string> = {
    build: "built from a Dockerfile; a rebuild, not a pull, updates it",
    "digest-pinned": "pinned by digest, which never moves",
    "image-id": "referenced by image ID, which has no tag to compare",
    "no-image": "declares no image",
};

/** What the remote check adds under the image of one service (ADR 0041). */
function remoteCell(view: ImageCheckView | null, service: string, displayed: string | null, localPending: boolean): string {
    if (!view || view.status !== "done" || view.discarded) return "";
    const entry: ServiceRemoteCheck | undefined = view.services.find((item) => item.service === service);
    if (!entry) return "";
    // A registry verdict belongs to the reference the check verified. A service
    // whose displayed image is a different reference (the Compose file was
    // edited, the container still runs the previous one, or the tag was lost)
    // must not inherit it: an association by service name alone would mislabel
    // the row. "Not checked" describes the service itself, so it needs no tag.
    if (entry.verdict.kind !== "not-tracked") {
        if (!entry.reference || !displayed) return "";
        if (normalizeReference(entry.reference) !== normalizeReference(displayed)) return "";
    }
    const verdict = entry.verdict;
    switch (verdict.kind) {
        case "up-to-date":
            // "Up to date" means the running image, the local tag and the
            // registry all agree. When the container still runs the previous
            // image, the row already says "Update ready"; asserting both would
            // merge two different facts into a contradictory verdict.
            if (localPending) {
                return `<div class="update" data-remote="same-as-local"><span class="muted">the registry resolves this tag to the local digest</span></div>`;
            }
            return `<div class="update" data-remote="up-to-date"><span class="state state-done">Up to date</span> <span class="muted">the registry resolves this tag to the digest recorded locally (${escapeHtml(shortDigest(verdict.remoteDigest))})</span></div>`;
        case "update-available":
            return `<div class="update" data-remote="update-available"><span class="state state-update">Update available</span> <span class="muted">the registry now resolves this tag to ${escapeHtml(shortDigest(verdict.remoteDigest))}; locally ${escapeHtml(shortDigest(verdict.localDigest))}</span></div>`;
        case "unknown":
            return `<div class="update" data-remote="unknown"><span class="state state-unknown">Unknown</span> <span class="muted">${escapeHtml(REMOTE_REASON_TEXT[verdict.reason])}</span></div>`;
        case "not-tracked":
            return `<div class="update" data-remote="not-tracked"><span class="state">Not checked</span> <span class="muted">${escapeHtml(NOT_TRACKED_TEXT[verdict.reason])}</span></div>`;
    }
}

function shortDigest(digest: string): string {
    return digest.length > 19 ? `${digest.slice(0, 19)}…` : digest;
}

export interface RemoteCheckOptions {
    /** The last stored result for this stack, or null before the first check. */
    view: ImageCheckView | null;
    /** A check is running for the whole panel (single-flight). */
    running: boolean;
    /** This stack page may offer a check (deployed, verified project). */
    enabled: boolean;
    /** A mutation is running for this stack; a check started now would be discarded. */
    mutationRunning: boolean;
}

/** The explicit Check button and an honest status for the last result. */
function remoteCheckCard(actions: { name: string; csrf: string; busy: boolean }, options: RemoteCheckOptions): string {
    const view = options.view;
    const disabledReason = options.mutationRunning
        ? "Wait for the running action to finish."
        : options.running
          ? "A check is already running."
          : !options.enabled
            ? "Available once this stack is deployed."
            : "";
    const disabled = disabledReason !== "";
    const form = `<form method="post" action="/stacks/${encodeURIComponent(actions.name)}/image-check" class="toolbar"><input type="hidden" name="csrf" value="${escapeHtml(actions.csrf)}"><button type="submit" class="btn"${disabled ? " disabled" : ""}${disabledReason ? ` title="${escapeHtml(disabledReason)}"` : ""} data-busy-label="Checking…">Check</button>${disabledReason ? `<span class="muted">${escapeHtml(disabledReason)}</span>` : ""}</form>`;
    let status: string;
    if (view?.status === "running") {
        status = note("info", "Checking the registry now. This page reloads when the result is ready. Nothing is downloaded.");
    } else if (view?.discarded) {
        status = note(
            "warn",
            "The last check was discarded because the stack changed while it ran, so no verdict was shown. Run Check again.",
        );
    } else if (view) {
        const counts = view.services.reduce(
            (total, entry) => {
                if (entry.verdict.kind === "up-to-date" || entry.verdict.kind === "update-available") total.compared += 1;
                if (entry.verdict.kind === "update-available") total.updates += 1;
                if (entry.verdict.kind === "unknown") total.unknown += 1;
                if (entry.verdict.kind === "not-tracked") total.untracked += 1;
                return total;
            },
            { compared: 0, updates: 0, unknown: 0, untracked: 0 },
        );
        const parts = [
            counts.updates > 0 ? `${counts.updates} update available` : "",
            counts.compared - counts.updates > 0 ? `${counts.compared - counts.updates} matching the local digest` : "",
            counts.unknown > 0 ? `${counts.unknown} unknown` : "",
            counts.untracked > 0 ? `${counts.untracked} not checked` : "",
        ].filter(Boolean);
        const at = new Date(view.finishedAt ?? view.startedAt).toISOString();
        status = `<p class="muted">Last check <time datetime="${escapeHtml(at)}" data-local-time>${escapeHtml(at.slice(11, 19))} UTC</time>${parts.length > 0 ? ` · ${escapeHtml(parts.join(", "))}` : ""}</p>`;
    } else {
        status = `<p class="muted">Check asks each registry whether its tag now resolves to a different digest. It downloads nothing and changes no container.</p>`;
    }
    return `<div class="remote-check">${form}${status}</div>`;
}

export function servicesSection(
    services: ComposeService[],
    state: string,
    updates: Record<string, ServiceUpdate> = {},
    actions?: { name: string; csrf: string; busy: boolean },
    recreatePending: string[] = [],
    rolloutServices: string[] = [],
    remoteCheck?: RemoteCheckOptions,
): string {
    const check = actions && remoteCheck ? remoteCheckCard(actions, remoteCheck) : "";
    let content: string;
    if (services.length > 0) {
        // Scoped Restart/Up (ADR 0021), plain POST forms like the Actions card.
        // Same state table: offered on `running`/`stopped` only, never on
        // `unknown`; the server re-validates every submission.
        const scoped = actions !== undefined && (state === "running" || state === "stopped");
        const rows = services
            .map((service) => {
                const rollout = rolloutServices.includes(service.name) && service.state.toLowerCase() === "running";
                const cell = scoped ? `<td>${serviceActions(actions, service, rollout)}</td>` : "";
                const pending =
                    scoped && recreatePending.includes(service.name)
                        ? `<div class="update" data-recreate-pending><span class="state state-update">Recreate pending</span>${infoTip("Up recreates this service with the current Compose file and .env. Restart keeps the existing container as it is.")}</div>`
                        : "";
                const status = `<span class="badges">${serviceBadge(service)}${healthBadge(service.health)}</span>${pending}`;
                return `<tr><td>${escapeHtml(service.name)}</td><td>${status}</td><td>${imageCell(service, updates[service.name])}${remoteCell(remoteCheck?.view ?? null, service.name, service.image, Boolean(updates[service.name]))}</td>${cell}</tr>`;
            })
            .join("");
        const actionsHead = scoped ? `<th>Actions</th>` : "";
        content = `<div class="table-wrap"><table class="table services-table"><thead><tr><th>Service</th><th>Container</th><th>Image</th>${actionsHead}</tr></thead><tbody>${rows}</tbody></table></div>`;
    } else if (state === "not-created") {
        content = `<p class="muted">No containers yet. Use <em>Up</em> to create them.</p>`;
    } else {
        content = `<p class="muted">No container information available.</p>`;
    }
    return `<section class="card"><h2>Services</h2>${check}${content}</section>`;
}

/** Per-service Pull, Restart, Up and opt-in Rollout for one table row (ADR 0021, ADR 0035, ADR 0041). */
function serviceActions(actions: { name: string; csrf: string; busy: boolean }, service: ComposeService, rollout: boolean): string {
    const buttons = (["pull", "restart", "up"] as const)
        .map((action) => {
            const label = action === "pull" ? "Pull" : action === "restart" ? "Restart" : "Up";
            const disabled = actions.busy ? " disabled" : "";
            return `<form method="post" action="/stacks/${encodeURIComponent(actions.name)}/operations" class="op-form"><input type="hidden" name="csrf" value="${escapeHtml(actions.csrf)}"><input type="hidden" name="action" value="${action}"><input type="hidden" name="service" value="${escapeHtml(service.name)}"><button type="submit" class="btn btn-quiet"${disabled} data-op-button data-busy-label="Starting…">${label}</button></form>`;
        })
        .join("");
    const rolloutLink =
        rollout && !actions.busy
            ? `<a class="btn btn-quiet" href="/stacks/${encodeURIComponent(actions.name)}/rollout?service=${encodeURIComponent(service.name)}" title="Start a second instance, wait for it to become healthy, then remove the old one">Rollout…</a>`
            : "";
    return `<div class="row-actions">${buttons}${rolloutLink}</div>`;
}

const OPERATIONS: { action: OperationAction; label: string; help: string; style: string; needsDeployment: boolean }[] = [
    {
        action: "up",
        label: "Up",
        help: "Create or update this stack's containers so they match the Compose file and the local images. Use this after editing or after Pull. Per-service Up is offered in the Services table.",
        style: "btn-primary",
        needsDeployment: false,
    },
    {
        action: "pull",
        label: "Pull",
        help: "Download this stack's images, except services built from a Dockerfile (those are built by Up). No container is touched: services with a newer image are then marked “Update ready”. Pull always refreshes the tag, even when a service declares pull_policy: missing or never. Per-service Pull is offered in the Services table.",
        style: "",
        needsDeployment: false,
    },
    {
        action: "pull-up",
        label: "Pull + up",
        help: "Pull this stack's images (except locally built services), then Up, in one step: services with a newer image are recreated right away.",
        style: "",
        needsDeployment: false,
    },
    {
        action: "restart",
        label: "Restart",
        help: "Restart all containers in this stack. Does not apply Compose file changes. Per-service Restart is offered in the Services table.",
        style: "",
        needsDeployment: true,
    },
    {
        action: "stop",
        label: "Stop",
        help: "Stop this stack's containers without removing them. Start brings them back; Up recreates them.",
        style: "",
        needsDeployment: true,
    },
    {
        action: "start",
        label: "Start",
        help: "Start this stack's stopped containers without recreating them. Unlike Up, it never applies Compose file changes.",
        style: "",
        needsDeployment: true,
    },
    {
        action: "down",
        label: "Down",
        help: "Stop and remove this stack's containers and networks. Volumes and images are kept.",
        style: "btn-danger",
        needsDeployment: true,
    },
];

export const OPERATION_LABELS: Record<OperationAction, string> = Object.fromEntries(
    OPERATIONS.map((op) => [op.action, op.label]),
) as Record<OperationAction, string>;

export function operationControls(
    name: string,
    csrf: string,
    options: { busy: boolean; state: StackState; updatesReady?: string[]; recreatePending?: string[]; managedBy?: string | null },
): string {
    const action = `/stacks/${encodeURIComponent(name)}/operations`;
    // Which actions the panel offers for each honest state. `unknown` means the
    // panel cannot guarantee what it would manipulate, so nothing may run.
    const runnable = new Set<OperationAction>(
        options.state === "running" || options.state === "stopped"
            ? OPERATIONS.map((op) => op.action)
            : options.state === "not-created"
              ? OPERATIONS.filter((op) => !op.needsDeployment).map((op) => op.action)
              : [],
    );
    const rows = OPERATIONS.map((op) => {
        // Buttons blocked by state (not by a running action) stay disabled when
        // app.js unlocks the page: only a reload can offer them again.
        const stateBlocked = !runnable.has(op.action);
        const blocked = options.busy || stateBlocked;
        const disabled = blocked ? " disabled" : "";
        const lock = stateBlocked ? ` data-state-locked` : "";
        const form = (label: string) =>
            `<form method="post" action="${action}" class="op-form"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="action" value="${op.action}"><button type="submit" class="btn ${op.style}"${disabled}${lock} data-op-button data-busy-label="Starting…">${escapeHtml(label)}</button></form>`;
        if (op.action === "down" && runnable.has("down")) {
            // Destructive: a disclosure asks for a second, explicit click. Works without JS.
            return (
                `<details class="op-confirm"><summary class="op-row"><span class="btn ${op.style}">${escapeHtml(op.label)}…</span><span class="op-help">${escapeHtml(op.help)}</span></summary>` +
                `<div class="op-confirm-panel">${note("warn", `This stops and removes every container and network of ${name}. Volumes and images are kept, and Up recreates the containers. Click Down… again to cancel.`)}` +
                `${form("Yes, remove the containers")}</div></details>`
            );
        }
        return `<div class="op-row">${form(op.label)}<p class="op-help">${escapeHtml(op.help)}</p></div>`;
    }).join("");
    const status = options.busy
        ? note("info", "An action is running. The buttons unlock when it finishes.", { id: "op-busy-note" })
        : options.state === "unknown"
          ? `<p class="muted">The panel could not determine this stack's state, so no action is available. The reason is shown above; reload the page to try again.</p>`
          : options.state === "not-created"
            ? `<p class="muted">This stack is not deployed yet, so only <em>Up</em>, <em>Pull</em> and <em>Pull + up</em> are available.</p>`
            : stackNotes(options.updatesReady ?? [], options.recreatePending ?? []);
    const managed = options.managedBy
        ? note(
              "warn",
              `${options.managedBy} declares that it deploys this stack. Actions and edits made here stay possible, but its next deployment may overwrite them.`,
          )
        : "";
    return (
        `<section class="card"><h2>Actions</h2>` +
        `<p class="muted">These actions apply to this stack only. They run on the server and keep going if you close this page. Only one action or save runs at a time per stack.</p>` +
        `${managed}${status}<div class="op-list">${rows}</div></section>`
    );
}

function stackNotes(updatesReady: string[], recreatePending: string[]): string {
    const updates =
        updatesReady.length > 0
            ? note(
                  "info",
                  `Update ready for ${updatesReady.join(", ")}: Up recreates ${updatesReady.length === 1 ? "it" : "them"} with the newer image. The other services are not affected by the image change. Details under Services.`,
              )
            : "";
    // ADR 0032: states the consequence (Up recreates), not a cause.
    const pending =
        recreatePending.length > 0
            ? note(
                  "info",
                  `Recreate pending for ${recreatePending.join(", ")}: Up recreates ${recreatePending.length === 1 ? "it" : "them"} with the current Compose file and .env. Restart does not apply configuration changes.`,
              )
            : "";
    return updates + pending;
}

const OPERATION_STATUS_LABELS: Record<string, string> = {
    running: "Running",
    succeeded: "Succeeded",
    failed: "Failed",
    unknown: "Outcome unknown",
    refused: "Refused",
    intervention: "Intervention required",
};

export function operationStatusLabel(status: string): string {
    return OPERATION_STATUS_LABELS[status] ?? status;
}

function formatDuration(ms: number): string {
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 60) return `${seconds} s`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes} min ${seconds % 60} s`;
}

/** Plain-language details for an operation; shared by the server render and app.js. */
export function operationDetails(
    operation: Pick<OperationView, "exitCode" | "timedOut" | "truncated" | "startedAt" | "endedAt" | "source">,
): string {
    const parts: string[] = [];
    if (operation.endedAt !== null) parts.push(`took ${formatDuration(operation.endedAt - operation.startedAt)}`);
    if (operation.exitCode !== null) parts.push(`exit code ${operation.exitCode}`);
    // An app action runs inside a container; a Compose operation may still be
    // applying changes to the stack. Same behaviour, different wording.
    if (operation.timedOut)
        parts.push(
            operation.source
                ? "stopped waiting at the time limit — the action may still be running in the container, so check it before retrying"
                : "stopped at the time limit — the operation may still be applying changes, so check the stack before retrying",
        );
    if (operation.truncated) parts.push("output shortened (only the most recent part is kept)");
    return parts.join(" · ");
}

export function operationPanel(operation: OperationView | null, stack?: string): string {
    if (!operation) return "";
    const stackHref = stack !== undefined ? `/stacks/${encodeURIComponent(stack)}` : "/";
    const stream = stack !== undefined ? ` data-op-stream="${stackHref}/operations/events"` : "";
    const started = new Date(operation.startedAt).toISOString();
    const details = operationDetails(operation);
    // An application action uses its own label: a script named `start` must not
    // be shown as the Compose "Start". `Object.hasOwn` keeps an app script named
    // `constructor`/`toString` from resolving to an inherited member.
    const title = operation.source
        ? operation.label
        : Object.hasOwn(OPERATION_LABELS, operation.action)
          ? OPERATION_LABELS[operation.action as OperationAction]
          : operation.label;
    return (
        `<section class="card operation"${stream} data-op-status="${escapeHtml(operation.status)}" data-op-started="${operation.startedAt}">` +
        `<h2>Last action: ${escapeHtml(title)}${operation.service ? ` · ${escapeHtml(operation.service)}` : ""}</h2>` +
        `<p class="op-summary"><span class="state state-${escapeHtml(operation.status)}" id="op-status" aria-live="polite">${escapeHtml(operationStatusLabel(operation.status))}</span>` +
        ` <span class="muted">started <time datetime="${escapeHtml(started)}" data-local-time>${started.slice(11, 19)} UTC</time></span>` +
        `<span class="muted" id="op-meta">${details ? ` · ${escapeHtml(details)}` : ""}</span></p>` +
        `<pre class="output" id="op-output">${escapeHtml(operation.output)}</pre>` +
        `<p class="muted" id="op-live-note" hidden>Live output. Closing this page does not stop the action.</p>` +
        `<div class="note note-success" id="op-refresh" hidden>Finished. <a href="${stackHref}">Reload the page</a> to see the updated service status.</div>` +
        `</section>`
    );
}

export function logsPanel(name: string, tailLines: number, timezone = "", services: string[] = []): string {
    const base = `/stacks/${encodeURIComponent(name)}/logs`;
    const zoneHint = timezone
        ? ` Times are shown in <strong>${escapeHtml(timezone)}</strong>.`
        : ` Times are shown in your browser's time zone.`;
    // Server-known service names only (convenience: the server re-validates
    // against `config --services` on every request).
    const serviceOptions = [`<option value="">All services</option>`]
        .concat([...new Set(services)].map((service) => `<option value="${escapeHtml(service)}">${escapeHtml(service)}</option>`))
        .join("");
    const tails = [...new Set([100, 200, 500, 1000, tailLines])].sort((a, b) => a - b);
    const tailOptions = tails
        .map((lines) => `<option value="${lines}"${lines === tailLines ? " selected" : ""}>${lines}</option>`)
        .join("");
    return (
        `<section class="card logs" data-logs-snapshot="${base}" data-logs-stream="${base}/events"><h2>Logs</h2>` +
        `<p class="muted">Shows the last ${tailLines} lines. <em>Follow live</em> then keeps new lines arriving. Following stops when you click <em>Stop following</em>, change the selection, or leave the page.${zoneHint}</p>` +
        `<form method="get" action="${base}" class="toolbar" id="logs-form"><label for="logs-service">Service</label><select id="logs-service" name="service">${serviceOptions}</select>` +
        `<label for="logs-tail">Lines</label><select id="logs-tail" name="tail">${tailOptions}</select>` +
        `<button type="submit" class="btn" id="logs-show">Show</button><button type="button" class="btn" id="logs-refresh">Refresh</button><button type="button" class="btn" id="logs-follow">Follow live</button><button type="button" class="btn" id="logs-stop" disabled>Stop following</button></form>` +
        `<p id="logs-status" class="muted" role="status">Not following.</p>` +
        `<pre class="output" id="logs-output"></pre>` +
        `</section>`
    );
}

export interface ToolboxSourceView {
    id: string;
    service: string;
    runner: ToolboxRunner;
    workdir: string | null;
    user: string | null;
    /** Catalog revision captured at render time; null when unavailable. */
    revision: string | null;
    actions: ToolboxAction[];
    /** Reason the source cannot be used right now (service down, replicas…). */
    unavailable: string | null;
}

export interface ToolboxPageOptions {
    csrf: string;
    access?: string;
    timezone?: string;
    nav?: NavigationOptions;
    stack: string;
    sources: ToolboxSourceView[];
    operation?: OperationView | null;
    notice?: { kind: NoteKind; text: string };
    error?: { title: string; message: string };
}

const RUNNER_LABELS: Record<ToolboxRunner, string> = { composer: "Composer", npm: "npm", bun: "Bun", exec: "Command" };

function toolboxActionForm(stack: string, source: ToolboxSourceView, action: ToolboxAction, csrf: string, busy: boolean): string {
    const actionUrl = `/stacks/${encodeURIComponent(stack)}/actions`;
    const disabled = busy ? " disabled" : "";
    const form =
        `<form method="post" action="${actionUrl}" class="op-form"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">` +
        `<input type="hidden" name="source" value="${escapeHtml(source.id)}">` +
        `<input type="hidden" name="action" value="${escapeHtml(action.name)}">` +
        `<input type="hidden" name="revision" value="${escapeHtml(source.revision ?? "")}">` +
        `<button type="submit" class="btn"${disabled} data-op-button data-busy-label="Starting…">${escapeHtml(action.label)}</button></form>`;
    if (action.confirmation) {
        // Irreversible: a disclosure asks for a second, explicit click. Works without JS.
        return (
            `<details class="op-confirm"><summary class="op-row"><span class="btn">${escapeHtml(action.label)}…</span><span class="op-help"><code>${escapeHtml(action.name)}</code></span></summary>` +
            `<div class="op-confirm-panel">${note("warn", action.confirmation)}<div class="op-row">${form}</div></div></details>`
        );
    }
    return `<div class="op-row">${form}<p class="op-help"><code>${escapeHtml(action.name)}</code>${action.group ? ` · ${escapeHtml(action.group)}` : ""}</p></div>`;
}

function toolboxSourceCard(stack: string, source: ToolboxSourceView, csrf: string, busy: boolean): string {
    const context = [
        source.workdir ? `workdir <code>${escapeHtml(source.workdir)}</code>` : "",
        source.user ? `user <code>${escapeHtml(source.user)}</code>` : "",
    ]
        .filter(Boolean)
        .join(" · ");
    const head = `<h2><code>${escapeHtml(source.service)}</code> <small>${escapeHtml(RUNNER_LABELS[source.runner])}</small></h2>`;
    const meta = context ? `<p class="meta">${context}</p>` : "";
    if (source.unavailable) {
        return `<section class="card">${head}${meta}${note("warn", source.unavailable)}</section>`;
    }
    if (source.actions.length === 0) {
        return `<section class="card">${head}${meta}<p class="muted">No action is declared for this source.</p></section>`;
    }
    const rows = source.actions.map((action) => toolboxActionForm(stack, source, action, csrf, busy)).join("");
    return `<section class="card">${head}${meta}<div class="op-list">${rows}</div></section>`;
}

/**
 * Application actions page (ADR 0026). HTML-first: every action is a plain POST
 * form and a confirmation is a native `<details>`, so the page works without
 * JavaScript. Keeping it a dedicated page avoids reading container manifests on
 * every stack view.
 */
export function toolboxPage(options: ToolboxPageOptions): string {
    const href = `/stacks/${encodeURIComponent(options.stack)}`;
    const busy = options.operation?.status === "running";
    const intro = `<p class="lead">Run this stack's declared application actions (Composer, npm or Bun scripts). Each action runs non-interactively inside its container and is logged like any other operation.</p>`;
    const notice = options.notice ? note(options.notice.kind, options.notice.text) : "";
    const error = options.error ? note("error", options.error.message, { title: options.error.title }) : "";
    const body =
        options.sources.length > 0
            ? options.sources.map((source) => toolboxSourceCard(options.stack, source, options.csrf, busy)).join("")
            : `<section class="card"><h2>No application actions</h2>` +
              `<p class="muted">This stack declares no actions. Add an <code>x-compose-panel</code> section to its Compose file and a <code>compose-panel.actions</code> block to the project's manifest:</p>` +
              `<pre class="output">x-compose-panel:
  toolbox:
    sources:
      - id: backend
        service: app
        runner: composer</pre>` +
              `<p class="muted">The extension only says <em>where</em> to run. Each action must also be declared in the project's <code>composer.json</code> (<code>extra["compose-panel"]</code>) or <code>package.json</code> (<code>"compose-panel"</code>).</p></section>`;
    const operation = operationPanel(options.operation ?? null, options.stack);
    return documentHtml(
        `${options.stack} · Actions`,
        `<p class="crumbs"><a href="${href}">← Back to ${escapeHtml(options.stack)}</a></p>` +
            `<div class="page-head"><h1>Application actions</h1><a href="${href}" class="btn">Stack</a></div>` +
            intro +
            notice +
            error +
            operation +
            body,
        { logoutCsrf: options.csrf, access: options.access, timezone: options.timezone, nav: options.nav, scripts: ["/app.js"] },
    );
}

export interface RolloutReadinessView {
    service: string;
    /** False when the requested service declares no `panel.rollout.*` label. */
    declared: boolean;
    invalid: boolean;
    ready: boolean;
    reason: string | null;
    image: string | null;
    containerId: string | null;
    declaration: RolloutDeclaration | null;
}

export interface RolloutPageOptions {
    stack: string;
    csrf: string;
    /** Null lists every declared service; a name renders its confirmation page. */
    service: string | null;
    entries: RolloutReadinessView[];
    busy?: boolean;
    notice?: { kind: NoteKind; text: string };
    error?: { title: string; message: string };
    access?: string;
    timezone?: string;
    nav?: NavigationOptions;
}

function rolloutParams(declaration: RolloutDeclaration): string {
    const rows: [string, string][] = [
        ["Health timeout", `${declaration.timeoutSeconds} s`],
        ["Settle after healthy", `${declaration.settleSeconds} s`],
        ["Drain marker", declaration.drainFile ?? "none"],
        ["Drain detection", declaration.drainFile ? `${declaration.drainDetectSeconds} s` : "—"],
        ["Drain window", declaration.drainFile ? `${declaration.drainTimeSeconds} s` : "—"],
        ["Stop timeout", `${declaration.stopTimeoutSeconds} s`],
    ];
    const table = rows
        .map(
            ([label, value]) =>
                `<tr><th>${escapeHtml(label)}</th><td>${
                    value.startsWith("/") ? `<code>${escapeHtml(value)}</code>` : escapeHtml(value)
                }</td></tr>`,
        )
        .join("");
    return `<div class="table-wrap"><table class="table"><tbody>${table}</tbody></table></div>`;
}

function rolloutWarnings(declaration: RolloutDeclaration): string {
    const items = [
        "Two instances run at the same time during the rollout. The application must tolerate that: sessions, caches, shared files and database migrations included.",
        "A reverse proxy must discover both instances, route only to healthy ones and stop routing to the old one once it is drained. The Caddy domains managed by this panel use a published loopback port and are not compatible with rollout.",
        "If the panel crashes during a rollout, the outcome is unknown. Nothing is replayed automatically.",
        "From the first drain attempt onward, a failure requires manual intervention: the panel keeps the candidate and does not roll back automatically.",
    ];
    if (declaration.drainFile === null) {
        items.push(
            "No drain marker is declared. The old instance is stopped gracefully, but the panel cannot promise that in-flight requests finish.",
        );
    }
    return `<div class="note note-warn"><strong>${escapeHtml("Before you start")}</strong><ul>${items
        .map((item) => `<li>${escapeHtml(item)}</li>`)
        .join("")}</ul></div>`;
}

function rolloutReadyCard(stack: string, entry: RolloutReadinessView): string {
    const href = `/stacks/${encodeURIComponent(stack)}/rollout?service=${encodeURIComponent(entry.service)}`;
    return (
        `<section class="card"><h2><code>${escapeHtml(entry.service)}</code> <span class="state state-done">Ready</span></h2>` +
        `<p class="meta">${entry.image ? `<span>Image <code>${escapeHtml(entry.image)}</code></span>` : ""}` +
        `${
            entry.containerId
                ? `<span>Container <code title="${escapeHtml(entry.containerId)}">${escapeHtml(entry.containerId.slice(0, 12))}</code></span>`
                : ""
        }</p>` +
        (entry.declaration ? rolloutParams(entry.declaration) : "") +
        `<p><a class="btn" href="${href}">Review rollout</a></p></section>`
    );
}

function rolloutRefusedCard(entry: RolloutReadinessView): string {
    const badge = entry.invalid
        ? `<span class="state state-failed">Declaration invalid</span>`
        : `<span class="state state-refused">Not eligible</span>`;
    return `<section class="card"><h2><code>${escapeHtml(entry.service)}</code> ${badge}</h2>${
        entry.reason ? note("warn", entry.reason) : ""
    }</section>`;
}

/**
 * Rollout readiness and confirmation page (ADR 0035). HTML-first: the preview
 * is a plain GET and the action a plain POST, so it works without JavaScript.
 */
export function rolloutPage(options: RolloutPageOptions): string {
    const href = `/stacks/${encodeURIComponent(options.stack)}`;
    const title = options.service === null ? "Rollout readiness" : `Rollout ${options.service}`;
    const notice = options.notice ? note(options.notice.kind, options.notice.text) : "";
    const error = options.error ? note("error", options.error.message, { title: options.error.title }) : "";
    const single = options.service === null ? null : (options.entries.find((entry) => entry.service === options.service) ?? null);
    let body: string;
    if (options.service === null) {
        body =
            options.entries.length > 0
                ? options.entries
                      .map((entry) => (entry.ready ? rolloutReadyCard(options.stack, entry) : rolloutRefusedCard(entry)))
                      .join("")
                : `<section class="card"><h2>No service declares a rollout</h2>` +
                  `<p class="muted">Add <code>panel.rollout.enabled: "true"</code> to the labels of an eligible service. A healthcheck, an image, no published port, no fixed container name and no shared namespace are required.</p></section>`;
    } else if (!single) {
        body = `<section class="card"><h2>Rollout</h2>${note("warn", "This service is not declared for rollout.")}</section>`;
    } else if (!single.ready || !single.declaration) {
        body = rolloutRefusedCard(single);
    } else {
        const form =
            `<form method="post" action="/stacks/${encodeURIComponent(options.stack)}/rollout" class="op-form">` +
            `<input type="hidden" name="csrf" value="${escapeHtml(options.csrf)}">` +
            `<input type="hidden" name="service" value="${escapeHtml(single.service)}">` +
            `<p><label><input type="checkbox" name="pull" value="1" checked> Download the image before the rollout</label></p>` +
            `<button type="submit" class="btn btn-primary"${options.busy ? " disabled" : ""} data-op-button data-busy-label="Starting…">Roll out ${escapeHtml(single.service)}</button>` +
            `</form>`;
        body =
            `<section class="card"><h2><code>${escapeHtml(single.service)}</code> <span class="state state-done">Ready</span></h2>` +
            `<p class="meta">${single.image ? `<span>Image <code>${escapeHtml(single.image)}</code></span>` : ""}</p>` +
            rolloutParams(single.declaration) +
            rolloutWarnings(single.declaration) +
            form +
            `</section>`;
    }
    return documentHtml(
        `${options.stack} · ${title}`,
        `<p class="crumbs"><a href="${href}">← Back to ${escapeHtml(options.stack)}</a></p>` +
            `<div class="page-head"><h1>${escapeHtml(title)}</h1><a href="${href}" class="btn">Stack</a></div>` +
            `<p class="lead">Start a second instance of one service, wait for it to become healthy, then stop and remove only the old one. This is not a general zero-downtime guarantee.</p>` +
            notice +
            error +
            body,
        { logoutCsrf: options.csrf, access: options.access, timezone: options.timezone, nav: options.nav, scripts: ["/app.js"] },
    );
}

export interface AuditPageOptions {
    csrf: string;
    access?: string;
    timezone?: string;
    nav?: NavigationOptions;
    periods: string[];
    selected: string | null;
    entries: AuditEntry[];
}

const AUDIT_RESULT_CLASS: Record<string, string> = {
    success: "state-done",
    succeeded: "state-done",
    started: "state-running",
    failure: "state-failed",
    failed: "state-failed",
    partial: "state-failed",
    conflict: "state-stopped",
    refused: "state-stopped",
    intervention: "state-failed",
};

/** Read-only activity log: a period selector and the parsed entries of one file. */
export function auditPage(options: AuditPageOptions): string {
    const periodOptions = options.periods
        .map(
            (period) =>
                `<option value="${escapeHtml(period)}"${period === options.selected ? " selected" : ""}>${escapeHtml(period)}</option>`,
        )
        .join("");
    const selector =
        options.periods.length > 0
            ? `<form method="get" action="/audit" class="toolbar period"><label for="audit-period">Period</label><select id="audit-period" name="period" data-auto-submit>${periodOptions}</select><button type="submit" class="btn" data-auto-submit-fallback>Show</button></form>`
            : "";
    let table: string;
    if (options.periods.length === 0) {
        table = note("info", "No activity recorded yet. Sign-ins, edits and actions appear here.");
    } else if (options.entries.length === 0) {
        table = note("info", "No entries in this period.");
    } else {
        const rows = options.entries
            .map((entry) => {
                const when = entry.ts ? `${entry.ts.slice(0, 19).replace("T", " ")}Z` : "";
                const resultClass = AUDIT_RESULT_CLASS[entry.result] ?? "state-stopped";
                const stack = entry.stack ? `<code>${escapeHtml(entry.stack)}</code>` : `<span class="muted">—</span>`;
                const action = entry.action
                    ? escapeHtml(entry.action) + (entry.service ? ` · ${escapeHtml(entry.service)}` : "")
                    : `<span class="muted">—</span>`;
                const actor = entry.username
                    ? `${escapeHtml(entry.actor ?? "—")} <span class="muted">(${escapeHtml(entry.username)})</span>`
                    : escapeHtml(entry.actor ?? "—");
                const detail = entry.detail ? escapeHtml(entry.detail) : "";
                return (
                    `<tr><td><time datetime="${escapeHtml(entry.ts ?? "")}" data-local-time="full">${escapeHtml(when)}</time></td>` +
                    `<td>${escapeHtml(entry.event)}</td>` +
                    `<td><span class="state ${resultClass}">${escapeHtml(entry.result)}</span></td>` +
                    `<td>${actor}</td><td>${stack}</td><td>${action}</td><td class="col-optional">${detail}</td></tr>`
                );
            })
            .join("");
        table =
            `<div class="table-wrap"><table class="table"><thead><tr>` +
            `<th>Time</th><th>Event</th><th>Result</th><th>Actor</th><th>Stack</th><th>Action</th><th class="col-optional">Detail</th>` +
            `</tr></thead><tbody>${rows}</tbody></table></div>`;
    }
    return documentHtml(
        "Activity log",
        `<p class="crumbs"><a href="/">← All stacks</a></p>` +
            `<div class="page-head"><h1>Activity log</h1></div>` +
            `<p class="lead">Read-only record of sign-ins, file saves and actions, kept in <code>.compose-panel/audit</code> on the host. It never contains passwords, hashes or <code>.env</code> values.</p>` +
            selector +
            (options.selected
                ? `<p class="muted">Showing <code>${escapeHtml(options.selected)}.log</code> (${options.entries.length} entries, most recent last).</p>`
                : "") +
            table,
        { logoutCsrf: options.csrf, access: options.access, timezone: options.timezone, scripts: ["/app.js"], nav: options.nav },
    );
}

const ACCESS_STATUS: Record<AccessStatus, { label: string; cls: string }> = {
    verified: { label: "Verified", cls: "state state-done" },
    configured: { label: "Configured", cls: "state" },
    unknown: { label: "Verify externally", cls: "state" },
};

export interface AccessPageOptions {
    csrf: string;
    access?: string;
    timezone?: string;
    nav?: NavigationOptions;
    report: AccessReport;
}

/**
 * Read-only access diagnostic (ADR 0013). Reports only what the panel can check
 * itself; a configured access is never shown as verified or secure.
 */
export function accessPage(options: AccessPageOptions): string {
    const report = options.report;
    const rows = report.findings
        .map((finding) => {
            const status = ACCESS_STATUS[finding.status];
            return `<tr><td>${escapeHtml(finding.area)}</td><td><span class="${status.cls}">${escapeHtml(status.label)}</span></td><td>${escapeHtml(finding.detail)}</td></tr>`;
        })
        .join("");
    const warnings = report.warnings.map((warning) => note("warn", warning)).join("");
    const summary = note(
        "info",
        `${report.verifiedCount} checks verified by the panel · ${report.externalCount} require an external check. The panel never marks an access secure from its configuration alone.`,
    );
    const body = `<p class="crumbs"><a href="/">← All stacks</a></p>
<div class="page-head"><h1>Access &amp; security</h1></div>
<p class="lead">Read-only. This page reports only what the panel can check itself; a configured access is not a verified one. Network-level protection (firewall, VPN, IP allow-list, identity proxy) is verified by you, not here.</p>
${summary}
<section class="card"><h2>This request</h2><p>Arrived through <strong>${escapeHtml(report.request)}</strong>.</p></section>
${warnings}
<section class="card"><h2>Access</h2><div class="table-wrap"><table class="table"><thead><tr><th>Area</th><th>Status</th><th>Detail</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
    return documentHtml("Access & security", body, {
        logoutCsrf: options.csrf,
        access: options.access,
        timezone: options.timezone,
        scripts: ["/app.js"],
        nav: options.nav,
    });
}

export const CONTAINER_CATEGORY_LABELS: Record<ContainerCategory, string> = {
    managed: "Managed",
    external: "External Compose",
    standalone: "Standalone",
};

const CONTAINER_STATE_CLASS: Record<string, string> = {
    running: "state-running",
    restarting: "state-running",
    paused: "state-stopped",
    exited: "state-stopped",
    created: "state-stopped",
    dead: "state-failed",
};

/** Badge for a single Docker container state (`docker ps` vocabulary). */
export function containerStateBadge(state: string): string {
    const key = state.toLowerCase();
    const label = key ? key.charAt(0).toUpperCase() + key.slice(1) : "Unknown";
    return `<span class="state ${CONTAINER_STATE_CLASS[key] ?? "state-stopped"}">${escapeHtml(label)}</span>`;
}

/** The `docker ps` port summary, escaped; an empty value is a dash. */
function portsCell(ports: string): string {
    const value = ports.trim();
    return value ? `<code>${escapeHtml(value)}</code>` : `<span class="muted">—</span>`;
}

function containerNameCell(container: ClassifiedContainer): string {
    const name = container.name || container.id.slice(0, 12);
    return `<a href="/containers/${encodeURIComponent(container.id)}">${escapeHtml(name)}</a>`;
}

function containerRows(containers: ClassifiedContainer[], columns: "full" | "compact"): string {
    return containers
        .map((container) => {
            const detail =
                columns === "full"
                    ? `<td class="col-optional">${container.status ? escapeHtml(container.status) : `<span class="muted">—</span>`}</td>`
                    : "";
            const category = columns === "compact" ? `<td>${escapeHtml(CONTAINER_CATEGORY_LABELS[container.category])}</td>` : "";
            const image = columns === "full" ? `<td>${escapeHtml(container.image)}</td>` : "";
            return `<tr><td>${containerNameCell(container)}</td><td>${containerStateBadge(container.state)}</td>${category}${detail}${image}<td>${portsCell(container.ports)}</td></tr>`;
        })
        .join("");
}

/**
 * Home-page section: the containers the panel does not manage, so the stacks
 * table stays the management view and this stays observation. Managed containers
 * are omitted here (they already appear under their stack).
 */
export function otherContainersSection(
    containers: ClassifiedContainer[],
    filter: ContainerFilter = "running",
    unavailable: string | null = null,
): string {
    if (unavailable) return `<section class="card"><h2>Other containers</h2>${note("warn", unavailable)}</section>`;
    const others = containers.filter((container) => container.category !== "managed" && matchesContainerFilter(container.state, filter));
    const link = `<p><a href="/containers">View all containers →</a></p>`;
    const head = `<th>Name</th><th>State</th><th>Category</th><th>Image</th><th>Ports</th>`;
    const content =
        others.length > 0
            ? `<p class="muted">Docker containers outside managed stacks. Read only: Compose Panel never starts, stops or removes them.</p>` +
              `<div class="table-wrap"><table class="table"><thead><tr>${head}</tr></thead><tbody>${containerRows(others, "compact")}</tbody></table></div>` +
              link
            : `<p class="muted">No other containers running. <a href="/containers?state=all">See all containers</a>.</p>`;
    return `<section class="card"><h2>Other containers</h2>${content}</section>`;
}

export interface ContainersPageOptions {
    csrf: string;
    access?: string;
    timezone?: string;
    nav?: NavigationOptions;
    filter: ContainerFilter;
    containers: ClassifiedContainer[];
    note?: string | null;
}

const CONTAINER_FILTERS: readonly [ContainerFilter, string][] = [
    ["running", "Running"],
    ["stopped", "Stopped"],
    ["all", "All"],
];

/**
 * Full read-only container list. Shows all three categories (including Managed,
 * so a container can be traced back to its stack), filtered by state. Filters
 * are plain links: no JavaScript. Managed containers are observation only here;
 * their lifecycle is on the stack page.
 */
export function containersPage(options: ContainersPageOptions): string {
    const visible = options.containers.filter((container) => matchesContainerFilter(container.state, options.filter));
    const filters = CONTAINER_FILTERS.map(([value, label]) => {
        const active = value === options.filter;
        return `<a href="/containers?state=${value}" class="btn${active ? " btn-primary" : ""}"${active ? ` aria-current="page"` : ""}>${label}</a>`;
    }).join("");
    const order: ContainerCategory[] = ["managed", "external", "standalone"];
    const sections = order
        .map((category) => {
            const list = visible.filter((container) => container.category === category);
            if (list.length === 0) return "";
            const content = `<div class="table-wrap"><table class="table"><thead><tr><th>Name</th><th>State</th><th class="col-optional">Detail</th><th>Image</th><th>Ports</th></tr></thead><tbody>${containerRows(list, "full")}</tbody></table></div>`;
            return `<section class="card"><h2>${escapeHtml(CONTAINER_CATEGORY_LABELS[category])} <span class="muted">(${list.length})</span></h2>${content}</section>`;
        })
        .join("");
    const body =
        `<p class="crumbs"><a href="/">← All stacks</a></p>` +
        `<div class="page-head"><h1>Containers</h1></div>` +
        `<p class="lead">Every container Docker reports. <strong>Managed</strong> containers belong to a stack and are driven from its page; <strong>External Compose</strong> and <strong>Standalone</strong> containers are observed only. Read only: no start, stop, restart or remove.</p>` +
        (options.note ? note("warn", options.note) : "") +
        `<div class="toolbar">${filters}</div>` +
        (sections || (options.note ? "" : note("info", "No containers match this view.")));
    return documentHtml("Containers", body, {
        logoutCsrf: options.csrf,
        access: options.access,
        timezone: options.timezone,
        scripts: ["/app.js"],
        nav: options.nav,
    });
}

function containerTime(value: string | null): string {
    if (!value) return `<span class="muted">—</span>`;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return escapeHtml(value);
    const iso = date.toISOString();
    return `<time datetime="${escapeHtml(iso)}" data-local-time="full">${escapeHtml(iso.slice(0, 19).replace("T", " "))} UTC</time>`;
}

function healthCell(health: string | null): string {
    if (!health) return `<span class="muted">Not configured</span>`;
    const key = health.toLowerCase();
    const cls = key === "healthy" ? "state-done" : key === "unhealthy" ? "state-failed" : "state-stopped";
    const label = HEALTH_LABELS[key] ?? health;
    return `<span class="state ${cls}">${escapeHtml(label)}</span>`;
}

function detailRow(label: string, value: string): string {
    return `<tr><th scope="row">${escapeHtml(label)}</th><td>${value}</td></tr>`;
}

function containerPortsSection(details: ContainerDetails): string {
    if (details.ports.length === 0) {
        return `<section class="card"><h2>Ports</h2><p class="muted">No port published or exposed.</p></section>`;
    }
    const rows = details.ports
        .map((port) => {
            const host = port.host ? `<code>${escapeHtml(port.host)}</code>` : `<span class="muted">Not published</span>`;
            const scope = port.publicInterface ? ` <span class="state state-stopped">All interfaces</span>` : "";
            return `<tr><td><code>${escapeHtml(port.container)}</code></td><td>${host}${scope}</td></tr>`;
        })
        .join("");
    return (
        `<section class="card"><h2>Ports</h2>` +
        `<p class="muted">“All interfaces” means Docker binds the port on every host interface. A firewall or NAT outside the panel may still block it.</p>` +
        `<div class="table-wrap"><table class="table"><thead><tr><th>Container</th><th>Host binding</th></tr></thead><tbody>${rows}</tbody></table></div></section>`
    );
}

function containerNetworksSection(details: ContainerDetails): string {
    if (details.networks.length === 0) {
        return `<section class="card"><h2>Networks</h2><p class="muted">No network attachments reported.</p></section>`;
    }
    const rows = details.networks
        .map((network) => {
            const ipv4 = network.ipv4 ? `<code>${escapeHtml(network.ipv4)}</code>` : `<span class="muted">—</span>`;
            const names = network.dnsNames.length
                ? network.dnsNames.map((name) => `<code>${escapeHtml(name)}</code>`).join(", ")
                : `<span class="muted">—</span>`;
            return `<tr><td><code>${escapeHtml(network.name)}</code></td><td>${ipv4}</td><td>${names}</td></tr>`;
        })
        .join("");
    return `<section class="card"><h2>Networks</h2>
        <p class="muted">Attachments and DNS names reported by Docker; connectivity and name resolution are not checked.</p>
        <div class="table-wrap"><table class="table"><thead><tr><th>Network</th><th>IPv4</th><th>DNS names</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

function containerMountsSection(details: ContainerDetails): string {
    if (details.mounts.length === 0) {
        return `<section class="card"><h2>Mounts</h2><p class="muted">No mounts.</p></section>`;
    }
    const rows = details.mounts
        .map((mount) => {
            const mode = mount.mode || (mount.readOnly ? "ro" : "rw");
            return (
                `<tr><td>${escapeHtml(mount.type)}</td><td>${mount.source ? `<code>${escapeHtml(mount.source)}</code>` : `<span class="muted">—</span>`}</td>` +
                `<td><code>${escapeHtml(mount.destination)}</code></td><td>${escapeHtml(mode)}</td></tr>`
            );
        })
        .join("");
    return (
        `<section class="card"><details><summary>Mounts (${details.mounts.length})</summary>` +
        `<p class="muted">Host source paths are shown for debugging: treat them as sensitive.</p>` +
        `<div class="table-wrap"><table class="table"><thead><tr><th>Type</th><th>Source (host)</th><th>Destination</th><th>Mode</th></tr></thead><tbody>${rows}</tbody></table></div></details></section>`
    );
}

/**
 * Read-only log snapshot panel for one container. No follow: the Docker `logs`
 * call is a single bounded read, re-run on demand. The `data-container-logs`
 * URL is fetched by app.js; the "Latest ... lines" link works without scripts.
 */
export function containerLogsPanel(id: string, tailLines: number, timezone = ""): string {
    const base = `/containers/${encodeURIComponent(id)}/logs`;
    const zoneHint = timezone
        ? ` Times are shown in <strong>${escapeHtml(timezone)}</strong>.`
        : ` Times are shown in your browser's time zone.`;
    return (
        `<section class="card logs" data-container-logs="${base}"><h2>Logs</h2>` +
        `<p class="muted">Last ${tailLines} lines, read once on demand. Read only: the panel never follows or restarts this container.${zoneHint}</p>` +
        `<div class="toolbar"><a class="btn" href="${base}?tail=${tailLines}">Latest ${tailLines} lines</a><button type="button" class="btn" id="container-logs-refresh">Refresh</button></div>` +
        `<p id="container-logs-status" class="muted" role="status">Not loaded.</p>` +
        `<pre class="output" id="container-logs-output"></pre>` +
        `</section>`
    );
}

export interface ContainerDetailPageOptions {
    csrf: string;
    access?: string;
    timezone?: string;
    nav?: NavigationOptions;
    container: ClassifiedContainer;
    details: ContainerDetails | null;
    note?: string | null;
    logTailLines: number;
}

/**
 * Read-only detail of a single container. Shows the whitelisted `inspect`
 * projection, ports, networks, restart policy, health and mounts (collapsed); there is no
 * start/stop/remove/exec and no env or args.
 */
export function containerDetailPage(options: ContainerDetailPageOptions): string {
    const container = options.container;
    const details = options.details;
    const name = container.name || container.id.slice(0, 12);
    const stackLink =
        container.category === "managed" && container.stack
            ? ` · <a href="/stacks/${encodeURIComponent(container.stack)}">Stack ${escapeHtml(container.stack)}</a>`
            : "";
    let extras: string;
    if (details) {
        extras =
            `<section class="card"><h2>Details</h2><div class="table-wrap"><table class="table"><tbody>` +
            detailRow("Container ID", `<code>${escapeHtml(details.id)}</code>`) +
            detailRow("Image", details.image ? `<code>${escapeHtml(details.image)}</code>` : `<span class="muted">—</span>`) +
            detailRow("State", `${containerStateBadge(details.state)} <span class="muted">${escapeHtml(container.status)}</span>`) +
            detailRow("Health", healthCell(details.health)) +
            detailRow(
                "Restart policy",
                details.restartPolicy ? `<code>${escapeHtml(details.restartPolicy)}</code>` : `<span class="muted">—</span>`,
            ) +
            detailRow("Created", containerTime(details.created)) +
            detailRow("Started", containerTime(details.startedAt)) +
            detailRow("Finished", containerTime(details.finishedAt)) +
            detailRow("Exit code", details.exitCode !== null ? `<code>${details.exitCode}</code>` : `<span class="muted">—</span>`) +
            `</tbody></table></div></section>` +
            containerPortsSection(details) +
            containerNetworksSection(details) +
            containerMountsSection(details);
    } else {
        extras =
            `<section class="card"><h2>Details</h2><p class="muted">No details available.</p></section>` +
            `<section class="card"><h2>Ports</h2><p class="muted">Ports are shown from the container list: <code>${escapeHtml(container.ports || "none")}</code>.</p></section>`;
    }
    const body =
        `<p class="crumbs"><a href="/containers">← All containers</a></p>` +
        `<div class="page-head"><h1>${escapeHtml(name)}</h1></div>` +
        `<p class="meta">${containerStateBadge(container.state)}<span class="state">${escapeHtml(CONTAINER_CATEGORY_LABELS[container.category])}</span>` +
        `<span class="muted">Read only: observation only, no action on this container.</span>${stackLink}</p>` +
        (options.note ? note("warn", options.note) : "") +
        extras +
        containerLogsPanel(container.id, options.logTailLines, options.timezone);
    return documentHtml(name, body, {
        logoutCsrf: options.csrf,
        access: options.access,
        timezone: options.timezone,
        scripts: ["/app.js"],
        nav: options.nav,
    });
}

export function htmlResponse(body: string, status = 200): Response {
    return new Response(body, {
        status,
        headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            // Not "no-referrer": with it, browsers send `Origin: null` on the
            // panel's own form posts, which the strict Origin check must refuse.
            // "same-origin" sends the real origin to the panel and nothing to
            // other sites.
            "Referrer-Policy": "same-origin",
            "X-Frame-Options": "DENY",
            Vary: "Cookie",
            "Content-Security-Policy":
                "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        },
    });
}

export interface AboutPageOptions {
    csrf: string;
    access?: string;
    timezone?: string;
    nav?: NavigationOptions;
    status: SelfUpdateStatus;
    /** Bounded output of the last updater container, when Docker can read it. */
    output: string | null;
    /** This panel started an updater that has not ended yet. */
    pending: boolean;
    notice?: { kind: NoteKind; text: string };
    error?: { title: string; message: string };
}

const UPDATER_OUTCOMES: Record<UpdaterOutcome, { label: string; cls: string }> = {
    running: { label: "Running", cls: "state-running" },
    updated: { label: "Succeeded", cls: "state-succeeded" },
    refused: { label: "Refused, nothing changed", cls: "state-stopped" },
    failed: { label: "Failed", cls: "state-failed" },
};

/** The shared recovery commands, plus where to read the updater output. */
function recoveryText(identity: SelfIdentity): string {
    return [...recoveryCommands(identity), `docker logs ${UPDATER_NAME}`].join("\n");
}

/**
 * Version and self-update (ADR 0018). Check pulls the panel's own tag; Update
 * starts the one-shot updater after an explicit confirmation. Both are plain
 * forms; app.js only waits for the panel to come back after a restart.
 */
export function aboutPage(options: AboutPageOptions): string {
    const { status } = options;
    const timeTag = (iso: string | null): string =>
        iso
            ? `<time datetime="${escapeHtml(iso)}" data-local-time="full">${escapeHtml(iso.slice(0, 19).replace("T", " "))} UTC</time>`
            : `<span class="muted">—</span>`;
    const error = options.error ? note("error", options.error.message, { title: options.error.title }) : "";
    const notice = options.notice ? note(options.notice.kind, options.notice.text) : "";
    const support = status.support;
    const identity = support.kind === "ready" ? support.identity : null;

    const rows = [detailRow("Version", `<code>${escapeHtml(VERSION)}</code>`)];
    if (identity) {
        const running = status.current
            ? `<span class="version">${escapeHtml(versionText(status.current))}</span>`
            : `<span class="muted">unknown</span>`;
        rows.push(
            detailRow("Image", `<code>${escapeHtml(identity.imageRef)}</code>`),
            detailRow("Running image", running),
            detailRow(
                "Compose project",
                `<code>${escapeHtml(identity.project)}</code> · service <code>${escapeHtml(identity.service)}</code>`,
            ),
            detailRow("Deployment directory", `<code>${escapeHtml(identity.workingDir)}</code>`),
        );
    }
    const unsupported =
        support.kind === "unsupported"
            ? note("warn", `${support.reason} The steps are in docs/deployment.md, under "Upgrade and rollback".`, {
                  title: "Self-update unavailable.",
              })
            : "";
    const panelCard = `<section class="card"><h2>This panel</h2><div class="table-wrap"><table class="table"><tbody>${rows.join("")}</tbody></table></div>${unsupported}</section>`;

    const lastRun = status.lastRun;
    const updating = options.pending || (lastRun.kind === "run" && lastRun.run.outcome === "running");
    let updatesCard = "";
    if (identity) {
        let body: string;
        if (updating) {
            const waiting = note(
                "info",
                "Compose Panel restarts during the update, so this page is unavailable for a moment. It reloads by itself when the panel is back; sign in again then. Your stacks keep running.",
                { title: "An update is running." },
            );
            body = `<div data-self-update-wait>${waiting}</div>`;
        } else {
            const available = status.available;
            let ready: string;
            if (available) {
                const from = status.current ? versionText(status.current) : "current";
                const link = available.link
                    ? ` · <a href="${escapeHtml(available.link.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(available.link.label)}</a>`
                    : "";
                const sides = `<p><span class="state state-update">Newer image downloaded</span> <span class="version">${escapeHtml(from)}</span> → <span class="version">${escapeHtml(versionText(available.version))}</span>${link}</p>`;
                const verdict = status.verdict;
                let install: string;
                if (verdict === null) {
                    install = note("info", "Check again to verify this image against its published release before installing it.");
                } else if (verdict.kind === "refused") {
                    install = note("warn", verdict.reason, { title: "Not installable." });
                } else if (verdict.kind === "waiting") {
                    const at = new Date(verdict.installableAt).toISOString();
                    install = `<div class="note note-info"><strong>Waiting period.</strong> Release ${escapeHtml(verdict.version)} was published ${timeTag(verdict.publishedAt)}. Installation waits 72 hours after both publication and the latest digest registration, until ${timeTag(at)}. To update sooner, use the host commands in docs/deployment.md.</div>`;
                } else {
                    const warning = note(
                        "warn",
                        "Compose Panel restarts during the update: the page is unavailable for a moment and you sign in again afterwards. Your stacks keep running. Wait for running actions and saves to finish first. Click the button above again to cancel.",
                    );
                    install = `<p class="muted">Release ${escapeHtml(verdict.version)}, published ${timeTag(verdict.publishedAt)}. The downloaded image matches the release digest and the versioned registry.</p>
<details class="confirm"><summary><span class="btn btn-primary">Install update…</span></summary>
<div class="confirm-panel">${warning}<form method="post" action="/about/update"><input type="hidden" name="csrf" value="${escapeHtml(options.csrf)}"><input type="hidden" name="target" value="${escapeHtml(available.imageId)}"><button type="submit" class="btn btn-primary" data-busy-label="Starting…">Yes, install now</button></form></div>
</details>`;
                }
                ready = `${sides}${install}`;
            } else {
                ready = `<p class="muted">No newer image of <code>${escapeHtml(identity.imageRef)}</code> has been downloaded. Use the <code>latest</code> tag on the host to follow new release versions.</p>`;
            }
            body = `${ready}
<form method="post" action="/about/check" class="op-row"><input type="hidden" name="csrf" value="${escapeHtml(options.csrf)}"><button type="submit" class="btn" data-busy-label="Checking…">Check &amp; download update</button><p class="op-help">Downloads <code>${escapeHtml(identity.imageRef)}</code> if a newer image was published, then checks its release and digest history on GitHub. Nothing restarts.</p></form>`;
        }
        updatesCard = `<section class="card"><h2>Updates</h2>${body}<p class="muted"><a href="https://github.com/lekoala/compose-panel/blob/master/releases.json" target="_blank" rel="noopener noreferrer">Release registry</a> · <a href="https://github.com/lekoala/compose-panel/commits/master/releases.json" target="_blank" rel="noopener noreferrer">Digest history</a></p></section>`;
    }

    let lastCard = "";
    if (lastRun.kind === "foreign") {
        lastCard = `<section class="card"><h2>Last update</h2>${note("warn", `A container named ${UPDATER_NAME} exists but was not created by the panel. The panel does not read or remove it.`)}</section>`;
    } else if (lastRun.kind === "run") {
        const run = lastRun.run;
        const outcome = UPDATER_OUTCOMES[run.outcome];
        const open = run.outcome === "failed" || run.outcome === "refused" ? " open" : "";
        const output =
            options.output === null
                ? `<p class="muted">Docker could not read the updater output. Run <code>docker logs ${UPDATER_NAME}</code> on the host.</p>`
                : `<details${open}><summary>Updater output</summary><pre class="output">${escapeHtml(options.output.replace(/\s+$/, "") || "(no output)")}</pre></details>`;
        const recovery =
            run.outcome === "failed" && identity
                ? `${note("error", "The panel container may not be in the expected state. Run these commands on the host to finish or redo the update.", { title: "Update failed." })}<pre class="output">${escapeHtml(recoveryText(identity))}</pre>`
                : "";
        // The updater kept the exact previous image; offer the way back after
        // any update that reached the recreate.
        const rollback =
            (run.outcome === "failed" || run.outcome === "updated") && identity && run.previousImage
                ? `<details${run.outcome === "failed" ? " open" : ""}><summary>Roll back to the previous image</summary><p class="muted">The previous image is kept locally as <code>${escapeHtml(ROLLBACK_TAG)}</code>. These host commands recreate the panel from it, without downloading anything or editing a file.</p><pre class="output">${escapeHtml(rollbackCommands(identity).join("\n"))}</pre></details>`
                : "";
        const imageRow = (label: string, version: string | null, id: string | null): string =>
            id
                ? detailRow(label, `${version ? `<span class="version">${escapeHtml(version)}</span> ` : ""}<code>${escapeHtml(id)}</code>`)
                : "";
        const images =
            imageRow("Previous image", run.previousVersion, run.previousImage) +
            imageRow("Target image", run.targetVersion, run.targetImage);
        const imagesTable = images ? `<div class="table-wrap"><table class="table"><tbody>${images}</tbody></table></div>` : "";
        const ended = run.finishedAt ? `<span class="muted">ended ${timeTag(run.finishedAt)}</span>` : "";
        lastCard = `<section class="card"><h2>Last update</h2>
<p class="meta"><span class="state ${outcome.cls}">${escapeHtml(outcome.label)}</span><span class="muted">started ${timeTag(run.startedAt)}</span>${ended}</p>
${imagesTable}${recovery}${rollback}${output}</section>`;
    }

    const body = `<p class="crumbs"><a href="/">← All stacks</a></p>
<div class="page-head"><h1>About</h1></div>
<p class="lead">Compose Panel ${escapeHtml(VERSION)}. Updating replaces only the panel container; your stacks keep running.</p>
${error}${notice}${panelCard}${updatesCard}${lastCard}`;
    return documentHtml("About", body, {
        logoutCsrf: options.csrf,
        access: options.access,
        timezone: options.timezone,
        scripts: ["/app.js"],
        nav: options.nav,
    });
}
