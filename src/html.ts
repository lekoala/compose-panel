import type { ComposeService, StackState } from "./compose-state.ts";
import type { OperationAction, OperationView } from "./operations.ts";
import type { AuditEntry } from "./audit.ts";
import type { ImageVersion, ServiceUpdate } from "./updates.ts";
import { metadataUrl, type DeclaredMetadata, type DeployedImage } from "./deployment.ts";
import type { AccessReport, AccessStatus } from "./access.ts";
import { ROLLBACK_TAG, UPDATER_NAME, recoveryCommands, rollbackCommands, type SelfIdentity, type SelfUpdateStatus, type UpdaterOutcome } from "./self-update.ts";
import { matchesContainerFilter, type ClassifiedContainer, type ContainerCategory, type ContainerDetails, type ContainerFilter } from "./container-state.ts";
import { statDisplayName, type AttentionItem, type AttentionReason, type ClassifiedStat, type DiskUsage, type DiskUsageRow, type EngineInfo, type Insights, type StackUsage } from "./insights.ts";
import type { ToolboxAction, ToolboxRunner } from "./toolbox.ts";
import { isExplorerHref } from "./database.ts";
import { isValidDomain } from "./caddy.ts";
import packageJson from "../package.json";

const VERSION = packageJson.version;

export function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, char => {
        switch (char) {
            case "&": return "&amp;";
            case "<": return "&lt;";
            case ">": return "&gt;";
            case '"': return "&quot;";
            case "'": return "&#39;";
            default: return char;
        }
    });
}

/**
 * A small ⓘ for secondary details, kept out of the page until asked for.
 * Native `<details>`: works without JavaScript, on touch and with the keyboard
 * (a `title` tooltip would not). `text` is escaped; app.js only closes it on an
 * outside click or Escape. Place it in a heading or a block, never inside a
 * `<p>`: the parser would close the paragraph and the tip would land on its
 * own line.
 */
export function infoTip(text: string, label = "More information"): string {
    return `<details class="info"><summary aria-label="${escapeHtml(label)}">i</summary><span class="info-body">${escapeHtml(text)}</span></details>`;
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
    const sections = NAV_SECTIONS
        .map(([key, href, label]) => {
            const current = key === nav.section ? ` aria-current="page"` : "";
            return `<a href="${href}"${current}>${escapeHtml(label)}</a>`;
        })
        .join("");
    const hasStacks = nav.stacks.length > 0;
    const items = nav.stacks
        .map(name => {
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
    const scripts = (options.scripts ?? (options.nav ? ["/app.js"] : [])).map(src => `<script src="${escapeHtml(src)}" defer></script>`).join("");
    const timezone = options.timezone ? ` data-timezone="${escapeHtml(options.timezone)}"` : "";
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
  <title>${escapeHtml(title)} · Compose Panel</title>
  <link rel="stylesheet" href="/styles.css">
  <link id="favicon-svg" rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  ${scripts}
</head>
<body>
  ${options.bare ? `<main class="bare">${body}</main>` : `<div class="shell">
    <header><a href="/" class="brand"><img src="/brand-mark.svg" alt="" width="20" height="20">Compose Panel</a>${logout}</header>
    ${content}
    <footer>Compose Panel ${escapeHtml(VERSION)}${options.access ? ` · ${escapeHtml(options.access)}` : ""}</footer>
  </div>`}
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
    return documentHtml("Sign in", `<div class="login card">
<picture><source media="(prefers-color-scheme: dark)" srcset="/icon-boot-on-dark.svg"><img src="/icon-boot-on-light.svg" alt="" width="64" height="64" class="login-mark"></picture>
<h1>Compose Panel</h1>
<p class="muted">Sign in to manage your stacks.</p>${error}
<form method="post" action="/login" class="form">
  <input type="hidden" name="csrf" value="${escapeHtml(options.csrf)}">
  <label>Username <input name="user" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus></label>
  <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
  <button type="submit" class="btn btn-primary">Sign in</button>
</form>
</div>`, { bare: true });
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
    csrf: string; root: string; name?: string; composeSource?: string; envSource?: string;
    error?: string; access?: string; timezone?: string; nav?: NavigationOptions;
}): string {
    return documentHtml("New stack", `<p class="crumbs"><a href="/">← All stacks</a></p>
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
</form>`, { logoutCsrf: options.csrf, access: options.access, timezone: options.timezone, nav: options.nav, scripts: ["/app.js"] });
}

function backupsSection(name: string, csrf: string, backups: EditPageOptions["backups"]): string {
    const head = `<section class="card"><h2>Backups</h2>`;
    if (backups === null) return `${head}${note("warn", "The backup folder could not be read, so backups are not listed. Saving still makes a backup or reports why it cannot.")}</section>`;
    const policy = `The panel keeps the ${backups.retain} most recent backups of each file and deletes older ones after a save.`;
    if (backups.count === 0) return `${head}<p class="muted">No backups yet. ${escapeHtml(policy)}</p></section>`;
    const files = backups.count === 1 ? "1 backup" : `${backups.count} backups`;
    return `${head}<p class="muted">${files} (${escapeHtml(formatBytes(backups.bytes))}) in <code>.compose-panel/backups/${escapeHtml(name)}/</code>. ${escapeHtml(policy)}</p>`
        + `<details class="confirm"><summary><span class="btn btn-danger">Delete all backups…</span></summary>`
        + `<div class="confirm-panel">${note("warn", "Previous versions of the Compose file and .env of this stack are deleted for good. The current files are not affected. Click the button above again to cancel.")}`
        + `<form method="post" action="/stacks/${encodeURIComponent(name)}/backups/purge"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`
        + `<button type="submit" class="btn btn-danger" data-busy-label="Deleting…">Yes, delete ${files}</button></form></div></details></section>`;
}

export function editPage(options: EditPageOptions): string {
    const error = options.error ? note("error", options.error.message, { title: options.error.title }) : "";
    const notice = options.notice ? note(options.notice.kind, options.notice.text) : "";
    const stackHref = `/stacks/${encodeURIComponent(options.name)}`;
    const envHint = options.envExists
        ? "Variables for this stack. Values are secret: they are never logged and are hidden from error messages."
        : "This stack has no .env file. One is created only if you type something here.";
    return documentHtml(`Edit ${options.name}`, `<p class="crumbs"><a href="${stackHref}">← ${escapeHtml(options.name)}</a></p>
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
${backupsSection(options.name, options.csrf, options.backups)}`, { logoutCsrf: options.csrf, access: options.access, timezone: options.timezone, scripts: ["/app.js"], nav: options.nav });
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
 * Health is Docker's own check result, shown only when the column is relevant
 * (see `servicesSection`). It is never merged into the run-state badge.
 */
function healthBadge(health: string | null): string {
    if (!health) return `<span class="muted">Not configured</span>`;
    const key = health.toLowerCase();
    const cls = key === "healthy" ? "state-done" : key === "unhealthy" ? "state-failed" : "state-stopped";
    return `<span class="state ${cls}">${escapeHtml(HEALTH_LABELS[key] ?? health)}</span>`;
}

/**
 * Stack-level health marker, kept apart from the run-state badge: a container
 * can be Running while Docker's health check fails. Empty when nothing is wrong.
 */
export function healthSummaryBadge(services: ComposeService[]): string {
    const count = (value: string) => services.filter(service => (service.health ?? "").toLowerCase() === value).length;
    const unhealthy = count("unhealthy");
    if (unhealthy > 0) return `<span class="state state-failed">Health: ${unhealthy} unhealthy</span>`;
    const starting = count("starting");
    if (starting > 0) return `<span class="state state-stopped">Health: ${starting} starting</span>`;
    return "";
}

function versionText(version: ImageVersion): string {
    return version.version ?? (version.created ? `built ${version.created}` : version.digest ?? "unknown version");
}

export function deploymentSection(deployed: DeployedImage[] = [], declared?: DeclaredMetadata | null, showDeployed = true): string {
    const link = (value: string): string => {
        const href = metadataUrl(value);
        return href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(value)} ↗</a>` : escapeHtml(value);
    };
    const field = (label: string, value: string | null, url = false): string => value
        ? `<dt>${escapeHtml(label)}</dt><dd>${url ? link(value) : `<code>${escapeHtml(value)}</code>`}</dd>` : "";
    const images = deployed.map(image => `<article><h3>${escapeHtml(image.service)} <small>${escapeHtml(image.container)}</small></h3><dl>
${field("Version", image.version)}${field("Revision", image.revision)}${field("Source", image.source, true)}${field("Image ID", image.imageId)}
${image.digests.map(digest => field("Repository digest", digest)).join("")}</dl></article>`).join("");
    const labels = Object.entries(declared ?? {}).map(([service, values]) => {
        const fields = Object.entries(values).map(([key, value]) => field(key.slice(6), value, key.endsWith(".url") || key === "stack.source")).join("");
        return fields ? `<article><h3>${escapeHtml(service)}</h3><dl>${fields}</dl></article>` : "";
    }).join("");
    const declaredBlock = labels
        ? `<details><summary>Declared Compose metadata</summary><p class="muted">Resolved labels from the current Compose file. These may differ from the deployed containers.</p>${labels}</details>`
        : "";
    const warning = declared === null ? note("warn", "Declared Compose metadata could not be read. Check the Compose file, .env and Docker availability.") : "";
    if (!showDeployed && !declaredBlock && !warning) return "";
    const heading = showDeployed ? "Deployed version" : "Deployment metadata";
    const deployedBlock = showDeployed ? images || `<p class="muted">Deployed image metadata is unavailable. No version is inferred from an image tag.</p>` : "";
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
    ].filter(Boolean).join(" · ");
    const meta = context ? `<p class="meta">${context}</p>` : "";
    return `<section class="card database"><h2>Database</h2>${meta}${link}</section>`;
}

/** A domain the helper reports as attached to a stack (ADR 0030). */
export interface AttachedDomain {
    domain: string;
    service: string;
    port: number;
}

export interface DomainsSectionOptions {
    stackName: string;
    csrf: string;
    /** Service names from Docker, offered as suggestions. */
    services: string[];
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
 * domains with an Open-application link and a two-step Detach, the Attach
 * form (POST, only with a configured helper), and the GET preview of the
 * managed file (never a mutation). Stacks with a declared external owner get
 * a read-only card instead of the forms. Every dynamic value is escaped; the
 * domain link is only built for a strictly valid domain.
 */
export function domainsSection(options: DomainsSectionOptions): string {
    const { stackName, csrf, services, owner, attached, statusError, socketReady, preview, confirmDetach } = options;
    const href = `/stacks/${encodeURIComponent(stackName)}`;
    const list = attached.length === 0
        ? `<p class="muted">No domains attached.</p>`
        : `<ul class="domains-list">${attached.map(site => {
            const open = isValidDomain(site.domain)
                ? `<a href="https://${escapeHtml(site.domain)}" target="_blank" rel="noopener noreferrer">${escapeHtml(site.domain)} ↗</a>`
                : `<code>${escapeHtml(site.domain)}</code>`;
            const detach = !owner && socketReady
                ? (confirmDetach === site.domain
                    ? `<form method="post" action="${href}/domains/detach" class="form inline-form"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="domain" value="${escapeHtml(site.domain)}"><input type="hidden" name="confirm" value="1"><button type="submit" class="btn btn-danger">Confirm detach</button> <a href="${href}" class="btn">Cancel</a></form>`
                    : `<form method="post" action="${href}/domains/detach" class="form inline-form"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="domain" value="${escapeHtml(site.domain)}"><button type="submit" class="btn">Detach</button></form>`)
                : "";
            return `<li>${open} <span class="meta"><code>${escapeHtml(site.service)}</code> · <code>127.0.0.1:${escapeHtml(String(site.port))}</code></span>${detach}</li>`;
        }).join("")}</ul>`;
    const status = statusError ? note("warn", statusError) : "";
    if (owner) {
        return `<section class="card domains"><h2>Domains</h2>${note("info", `Routing for this stack is managed externally (${owner}). Domains are shown here for information only and cannot be attached from this panel.`)}${status}${list}</section>`;
    }
    const attach = socketReady
        ? `<form method="post" action="${href}/domains/attach" class="form domains-form">`
        + `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`
        + `<label>Domain <input type="text" name="domain" value="${escapeHtml(preview.domain)}" placeholder="app.example.com" autocomplete="off" spellcheck="false" required></label>`
        + `<label>Target service <input type="text" name="service" value="${escapeHtml(preview.service)}" placeholder="web" list="caddy-services" autocomplete="off" spellcheck="false" required><datalist id="caddy-services">${services.map(name => `<option value="${escapeHtml(name)}">`).join("")}</datalist></label>`
        + `<label>Local upstream port <input type="text" name="port" value="${escapeHtml(preview.port)}" placeholder="8080" autocomplete="off" spellcheck="false" inputmode="numeric" required></label>`
        + `<div class="form-actions"><button type="submit" class="btn btn-primary">Attach domain</button></div></form>`
        + `<p class="muted">Attaching validates the service and port, publishes the Caddy file and reloads Caddy. Only TCP ports bound to 127.0.0.1 are eligible. DNS and HTTPS are not checked by the panel.</p>`
        : note("info", "Preview only: the helper is not configured, so nothing can be attached. See the deployment guide to enable domain management.");
    const previewOptions = services.map(name => `<option value="${escapeHtml(name)}">`).join("");
    const form = `<form method="get" action="${href}" class="form domains-form">`
        + `<label>Domain <input type="text" name="caddyDomain" value="${escapeHtml(preview.domain)}" placeholder="app.example.com" autocomplete="off" spellcheck="false"></label>`
        + `<label>Target service <input type="text" name="caddyService" value="${escapeHtml(preview.service)}" placeholder="web" list="caddy-services-preview" autocomplete="off" spellcheck="false"><datalist id="caddy-services-preview">${previewOptions}</datalist></label>`
        + `<label>Local upstream port <input type="text" name="caddyPort" value="${escapeHtml(preview.port)}" placeholder="8080" autocomplete="off" spellcheck="false" inputmode="numeric"></label>`
        + `<div class="form-actions"><button type="submit" class="btn">Preview configuration</button></div></form>`;
    const output = preview.error
        ? note("warn", preview.error)
        : preview.file
            ? `<details open><summary>Generated Caddy configuration</summary><pre class="output">${escapeHtml(preview.file)}</pre></details>`
            : "";
    return `<section class="card domains"><h2>Domains</h2>${status}${list}${attach}${form}${output}</section>`;
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
    const image = `<code>${escapeHtml(service.image)}</code>`;
    if (!update) return image;
    // Link targets come from image labels: validated as http(s) in updates.ts,
    // escaped here, and opened without referrer or opener access.
    const link = update.link
        ? ` <a href="${escapeHtml(update.link.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(update.link.label)} ↗</a>`
        : "";
    return `${image}<div class="update"><span class="state state-update">Update ready</span> <span><span class="version">${escapeHtml(updateSides(update)[0])}</span> → <span class="version">${escapeHtml(updateSides(update)[1])}</span></span>${link}</div>`;
}

export function servicesSection(services: ComposeService[], state: string, updates: Record<string, ServiceUpdate> = {}, actions?: { name: string; csrf: string; busy: boolean }): string {
    let content: string;
    if (services.length > 0) {
        // Only show the health column when at least one service declares a
        // health check; otherwise it is an empty column with no information.
        const showHealth = services.some(service => service.health !== null);
        // Scoped Restart/Up (ADR 0021), plain POST forms like the Actions card.
        // Same state table: offered on `running`/`stopped` only, never on
        // `unknown`; the server re-validates every submission.
        const scoped = actions !== undefined && (state === "running" || state === "stopped");
        const rows = services
            .map(service => {
                const health = showHealth ? `<td class="col-optional">${healthBadge(service.health)}</td>` : "";
                const cell = scoped ? `<td>${serviceActions(actions, service.name)}</td>` : "";
                return `<tr><td>${escapeHtml(service.name)}</td><td>${serviceBadge(service)}</td>${health}<td>${imageCell(service, updates[service.name])}</td>${cell}</tr>`;
            })
            .join("");
        const healthHead = showHealth ? `<th class="col-optional">Health check</th>` : "";
        const actionsHead = scoped ? `<th>Actions</th>` : "";
        content = `<div class="table-wrap"><table class="table"><thead><tr><th>Service</th><th>Container</th>${healthHead}<th>Image</th>${actionsHead}</tr></thead><tbody>${rows}</tbody></table></div>`;
    } else if (state === "not-created") {
        content = `<p class="muted">No containers yet. Use <em>Up</em> to create them.</p>`;
    } else {
        content = `<p class="muted">No container information available.</p>`;
    }
    return `<section class="card"><h2>Services</h2>${content}</section>`;
}

/** Per-service Restart and Up for one table row (ADR 0021). */
function serviceActions(actions: { name: string; csrf: string; busy: boolean }, service: string): string {
    const buttons = (["restart", "up"] as const).map(action => {
        const label = action === "restart" ? "Restart" : "Up";
        const disabled = actions.busy ? " disabled" : "";
        return `<form method="post" action="/stacks/${encodeURIComponent(actions.name)}/operations" class="op-form"><input type="hidden" name="csrf" value="${escapeHtml(actions.csrf)}"><input type="hidden" name="action" value="${action}"><input type="hidden" name="service" value="${escapeHtml(service)}"><button type="submit" class="btn btn-quiet"${disabled} data-op-button data-busy-label="Starting…">${label}</button></form>`;
    }).join("");
    return `<div class="row-actions">${buttons}</div>`;
}

const OPERATIONS: { action: OperationAction; label: string; help: string; style: string; needsDeployment: boolean }[] = [
    { action: "up", label: "Up", help: "Create or update this stack's containers so they match the Compose file and the local images. Use this after editing or after Pull. Per-service Up is offered in the Services table.", style: "btn-primary", needsDeployment: false },
    { action: "pull", label: "Pull", help: "Download this stack's images, except services built from a Dockerfile (those are built by Up). No container is touched: services with a newer image are then marked “Update ready”.", style: "", needsDeployment: false },
    { action: "pull-up", label: "Pull + up", help: "Pull this stack's images (except locally built services), then Up, in one step: services with a newer image are recreated right away.", style: "", needsDeployment: false },
    { action: "restart", label: "Restart", help: "Restart all containers in this stack. Does not apply Compose file changes. Per-service Restart is offered in the Services table.", style: "", needsDeployment: true },
    { action: "stop", label: "Stop", help: "Stop this stack's containers without removing them. Start brings them back; Up recreates them.", style: "", needsDeployment: true },
    { action: "start", label: "Start", help: "Start this stack's stopped containers without recreating them. Unlike Up, it never applies Compose file changes.", style: "", needsDeployment: true },
    { action: "down", label: "Down", help: "Stop and remove this stack's containers and networks. Volumes and images are kept.", style: "btn-danger", needsDeployment: true },
];

export const OPERATION_LABELS: Record<OperationAction, string> = Object.fromEntries(OPERATIONS.map(op => [op.action, op.label])) as Record<OperationAction, string>;

export function operationControls(name: string, csrf: string, options: { busy: boolean; state: StackState; updatesReady?: string[]; managedBy?: string | null }): string {
    const action = `/stacks/${encodeURIComponent(name)}/operations`;
    // Which actions the panel offers for each honest state. `unknown` means the
    // panel cannot guarantee what it would manipulate, so nothing may run.
    const runnable = new Set<OperationAction>(
        options.state === "running" || options.state === "stopped"
            ? OPERATIONS.map(op => op.action)
            : options.state === "not-created"
                ? OPERATIONS.filter(op => !op.needsDeployment).map(op => op.action)
                : [],
    );
    const rows = OPERATIONS.map(op => {
        // Buttons blocked by state (not by a running action) stay disabled when
        // app.js unlocks the page: only a reload can offer them again.
        const stateBlocked = !runnable.has(op.action);
        const blocked = options.busy || stateBlocked;
        const disabled = blocked ? " disabled" : "";
        const lock = stateBlocked ? ` data-state-locked` : "";
        const form = (label: string) => `<form method="post" action="${action}" class="op-form"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="action" value="${op.action}"><button type="submit" class="btn ${op.style}"${disabled}${lock} data-op-button data-busy-label="Starting…">${escapeHtml(label)}</button></form>`;
        if (op.action === "down" && runnable.has("down")) {
            // Destructive: a disclosure asks for a second, explicit click. Works without JS.
            return `<details class="op-confirm"><summary class="op-row"><span class="btn ${op.style}">${escapeHtml(op.label)}…</span><span class="op-help">${escapeHtml(op.help)}</span></summary>`
                + `<div class="op-confirm-panel">${note("warn", `This stops and removes every container and network of ${name}. Volumes and images are kept, and Up recreates the containers. Click Down… again to cancel.`)}`
                + `${form("Yes, remove the containers")}</div></details>`;
        }
        return `<div class="op-row">${form(op.label)}<p class="op-help">${escapeHtml(op.help)}</p></div>`;
    }).join("");
    const status = options.busy
        ? note("info", "An action is running. The buttons unlock when it finishes.", { id: "op-busy-note" })
        : options.state === "unknown"
            ? `<p class="muted">The panel could not determine this stack's state, so no action is available. The reason is shown above; reload the page to try again.</p>`
            : options.state === "not-created"
                ? `<p class="muted">This stack is not deployed yet, so only <em>Up</em>, <em>Pull</em> and <em>Pull + up</em> are available.</p>`
                : options.updatesReady && options.updatesReady.length > 0
                    ? note("info", `Update ready for ${options.updatesReady.join(", ")}: Up recreates ${options.updatesReady.length === 1 ? "it" : "them"} with the newer image. The other services are not affected by the image change. Details under Services.`)
                    : "";
    const managed = options.managedBy
        ? note("warn", `${options.managedBy} declares that it deploys this stack. Actions and edits made here stay possible, but its next deployment may overwrite them.`)
        : "";
    return `<section class="card"><h2>Actions</h2>`
        + `<p class="muted">These actions apply to this stack only. They run on the server and keep going if you close this page. Only one action or save runs at a time per stack.</p>`
        + `${managed}${status}<div class="op-list">${rows}</div></section>`;
}

const OPERATION_STATUS_LABELS: Record<string, string> = {
    running: "Running",
    succeeded: "Succeeded",
    failed: "Failed",
    unknown: "Outcome unknown",
    refused: "Refused",
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
export function operationDetails(operation: Pick<OperationView, "exitCode" | "timedOut" | "truncated" | "startedAt" | "endedAt" | "source">): string {
    const parts: string[] = [];
    if (operation.endedAt !== null) parts.push(`took ${formatDuration(operation.endedAt - operation.startedAt)}`);
    if (operation.exitCode !== null) parts.push(`exit code ${operation.exitCode}`);
    // An app action runs inside a container; a Compose operation may still be
    // applying changes to the stack. Same behaviour, different wording.
    if (operation.timedOut) parts.push(operation.source
        ? "stopped waiting at the time limit — the action may still be running in the container, so check it before retrying"
        : "stopped at the time limit — the operation may still be applying changes, so check the stack before retrying");
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
    return `<section class="card operation"${stream} data-op-status="${escapeHtml(operation.status)}" data-op-started="${operation.startedAt}">`
        + `<h2>Last action: ${escapeHtml(title)}${operation.service ? ` · ${escapeHtml(operation.service)}` : ""}</h2>`
        + `<p class="op-summary"><span class="state state-${escapeHtml(operation.status)}" id="op-status" aria-live="polite">${escapeHtml(operationStatusLabel(operation.status))}</span>`
        + ` <span class="muted">started <time datetime="${escapeHtml(started)}" data-local-time>${started.slice(11, 19)} UTC</time></span>`
        + `<span class="muted" id="op-meta">${details ? ` · ${escapeHtml(details)}` : ""}</span></p>`
        + `<pre class="output" id="op-output">${escapeHtml(operation.output)}</pre>`
        + `<p class="muted" id="op-live-note" hidden>Live output. Closing this page does not stop the action.</p>`
        + `<div class="note note-success" id="op-refresh" hidden>Finished. <a href="${stackHref}">Reload the page</a> to see the updated service status.</div>`
        + `</section>`;
}

export function logsPanel(name: string, tailLines: number, timezone = "", services: string[] = []): string {
    const base = `/stacks/${encodeURIComponent(name)}/logs`;
    const zoneHint = timezone
        ? ` Times are shown in <strong>${escapeHtml(timezone)}</strong>.`
        : ` Times are shown in your browser's time zone.`;
    // Server-known service names only (convenience: the server re-validates
    // against `config --services` on every request).
    const serviceOptions = [`<option value="">All services</option>`]
        .concat([...new Set(services)].map(service => `<option value="${escapeHtml(service)}">${escapeHtml(service)}</option>`))
        .join("");
    const tails = [...new Set([100, 200, 500, 1000, tailLines])].sort((a, b) => a - b);
    const tailOptions = tails
        .map(lines => `<option value="${lines}"${lines === tailLines ? " selected" : ""}>${lines}</option>`)
        .join("");
    return `<section class="card logs" data-logs-snapshot="${base}" data-logs-stream="${base}/events"><h2>Logs</h2>`
        + `<p class="muted">Shows the last ${tailLines} lines. <em>Follow live</em> then keeps new lines arriving. Following stops when you click <em>Stop following</em>, change the selection, or leave the page.${zoneHint}</p>`
        + `<form method="get" action="${base}" class="toolbar" id="logs-form"><label for="logs-service">Service</label><select id="logs-service" name="service">${serviceOptions}</select>`
        + `<label for="logs-tail">Lines</label><select id="logs-tail" name="tail">${tailOptions}</select>`
        + `<button type="submit" class="btn" id="logs-show">Show</button><button type="button" class="btn" id="logs-refresh">Refresh</button><button type="button" class="btn" id="logs-follow">Follow live</button><button type="button" class="btn" id="logs-stop" disabled>Stop following</button></form>`
        + `<p id="logs-status" class="muted" role="status">Not following.</p>`
        + `<pre class="output" id="logs-output"></pre>`
        + `</section>`;
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

const RUNNER_LABELS: Record<ToolboxRunner, string> = { composer: "Composer", npm: "npm", bun: "Bun" };

function toolboxActionForm(stack: string, source: ToolboxSourceView, action: ToolboxAction, csrf: string, busy: boolean): string {
    const actionUrl = `/stacks/${encodeURIComponent(stack)}/actions`;
    const disabled = busy ? " disabled" : "";
    const form = `<form method="post" action="${actionUrl}" class="op-form"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`
        + `<input type="hidden" name="source" value="${escapeHtml(source.id)}">`
        + `<input type="hidden" name="action" value="${escapeHtml(action.name)}">`
        + `<input type="hidden" name="revision" value="${escapeHtml(source.revision ?? "")}">`
        + `<button type="submit" class="btn"${disabled} data-op-button data-busy-label="Starting…">${escapeHtml(action.label)}</button></form>`;
    if (action.confirmation) {
        // Irreversible: a disclosure asks for a second, explicit click. Works without JS.
        return `<details class="op-confirm"><summary class="op-row"><span class="btn">${escapeHtml(action.label)}…</span><span class="op-help"><code>${escapeHtml(action.name)}</code></span></summary>`
            + `<div class="op-confirm-panel">${note("warn", action.confirmation)}<div class="op-row">${form}</div></div></details>`;
    }
    return `<div class="op-row">${form}<p class="op-help"><code>${escapeHtml(action.name)}</code>${action.group ? ` · ${escapeHtml(action.group)}` : ""}</p></div>`;
}

function toolboxSourceCard(stack: string, source: ToolboxSourceView, csrf: string, busy: boolean): string {
    const context = [
        source.workdir ? `workdir <code>${escapeHtml(source.workdir)}</code>` : "",
        source.user ? `user <code>${escapeHtml(source.user)}</code>` : "",
    ].filter(Boolean).join(" · ");
    const head = `<h2><code>${escapeHtml(source.service)}</code> <small>${escapeHtml(RUNNER_LABELS[source.runner])}</small></h2>`;
    const meta = context ? `<p class="meta">${context}</p>` : "";
    if (source.unavailable) {
        return `<section class="card">${head}${meta}${note("warn", source.unavailable)}</section>`;
    }
    if (source.actions.length === 0) {
        return `<section class="card">${head}${meta}<p class="muted">No action is declared for this source.</p></section>`;
    }
    const rows = source.actions.map(action => toolboxActionForm(stack, source, action, csrf, busy)).join("");
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
    const body = options.sources.length > 0
        ? options.sources.map(source => toolboxSourceCard(options.stack, source, options.csrf, busy)).join("")
        : `<section class="card"><h2>No application actions</h2>`
            + `<p class="muted">This stack declares no actions. Add an <code>x-compose-panel</code> section to its Compose file and a <code>compose-panel.actions</code> block to the project's manifest:</p>`
            + `<pre class="output">x-compose-panel:
  toolbox:
    sources:
      - id: backend
        service: app
        runner: composer</pre>`
            + `<p class="muted">The extension only says <em>where</em> to run. Each action must also be declared in the project's <code>composer.json</code> (<code>extra["compose-panel"]</code>) or <code>package.json</code> (<code>"compose-panel"</code>).</p></section>`;
    const operation = operationPanel(options.operation ?? null, options.stack);
    return documentHtml(
        `${options.stack} · Actions`,
        `<p class="crumbs"><a href="${href}">← Back to ${escapeHtml(options.stack)}</a></p>`
        + `<div class="page-head"><h1>Application actions</h1><a href="${href}" class="btn">Stack</a></div>`
        + intro + notice + error + operation + body,
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
};

/** Read-only activity log: a period selector and the parsed entries of one file. */
export function auditPage(options: AuditPageOptions): string {
    const periodOptions = options.periods
        .map(period => `<option value="${escapeHtml(period)}"${period === options.selected ? " selected" : ""}>${escapeHtml(period)}</option>`)
        .join("");
    const selector = options.periods.length > 0
        ? `<form method="get" action="/audit" class="toolbar period"><label for="audit-period">Period</label><select id="audit-period" name="period" data-auto-submit>${periodOptions}</select><button type="submit" class="btn" data-auto-submit-fallback>Show</button></form>`
        : "";
    let table: string;
    if (options.periods.length === 0) {
        table = note("info", "No activity recorded yet. Sign-ins, edits and actions appear here.");
    } else if (options.entries.length === 0) {
        table = note("info", "No entries in this period.");
    } else {
        const rows = options.entries.map(entry => {
            const when = entry.ts ? `${entry.ts.slice(0, 19).replace("T", " ")}Z` : "";
            const resultClass = AUDIT_RESULT_CLASS[entry.result] ?? "state-stopped";
            const stack = entry.stack ? `<code>${escapeHtml(entry.stack)}</code>` : `<span class="muted">—</span>`;
            const action = entry.action ? escapeHtml(entry.action) + (entry.service ? ` · ${escapeHtml(entry.service)}` : "") : `<span class="muted">—</span>`;
            const actor = entry.username
                ? `${escapeHtml(entry.actor ?? "—")} <span class="muted">(${escapeHtml(entry.username)})</span>`
                : escapeHtml(entry.actor ?? "—");
            const detail = entry.detail ? escapeHtml(entry.detail) : "";
            return `<tr><td><time datetime="${escapeHtml(entry.ts ?? "")}" data-local-time="full">${escapeHtml(when)}</time></td>`
                + `<td>${escapeHtml(entry.event)}</td>`
                + `<td><span class="state ${resultClass}">${escapeHtml(entry.result)}</span></td>`
                + `<td>${actor}</td><td>${stack}</td><td>${action}</td><td class="col-optional">${detail}</td></tr>`;
        }).join("");
        table = `<div class="table-wrap"><table class="table"><thead><tr>`
            + `<th>Time</th><th>Event</th><th>Result</th><th>Actor</th><th>Stack</th><th>Action</th><th class="col-optional">Detail</th>`
            + `</tr></thead><tbody>${rows}</tbody></table></div>`;
    }
    return documentHtml(
        "Activity log",
        `<p class="crumbs"><a href="/">← All stacks</a></p>`
        + `<div class="page-head"><h1>Activity log</h1></div>`
        + `<p class="lead">Read-only record of sign-ins, file saves and actions, kept in <code>.compose-panel/audit</code> on the host. It never contains passwords, hashes or <code>.env</code> values.</p>`
        + selector
        + (options.selected ? `<p class="muted">Showing <code>${escapeHtml(options.selected)}.log</code> (${options.entries.length} entries, most recent last).</p>` : "")
        + table,
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
    const rows = report.findings.map(finding => {
        const status = ACCESS_STATUS[finding.status];
        return `<tr><td>${escapeHtml(finding.area)}</td><td><span class="${status.cls}">${escapeHtml(status.label)}</span></td><td>${escapeHtml(finding.detail)}</td></tr>`;
    }).join("");
    const warnings = report.warnings.map(warning => note("warn", warning)).join("");
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
    return documentHtml("Access & security", body, { logoutCsrf: options.csrf, access: options.access, timezone: options.timezone, scripts: ["/app.js"], nav: options.nav });
}

const CONTAINER_CATEGORY_LABELS: Record<ContainerCategory, string> = {
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
    return containers.map(container => {
        const detail = columns === "full"
            ? `<td class="col-optional">${container.status ? escapeHtml(container.status) : `<span class="muted">—</span>`}</td>`
            : "";
        const category = columns === "compact"
            ? `<td>${escapeHtml(CONTAINER_CATEGORY_LABELS[container.category])}</td>`
            : "";
        const image = columns === "full" ? `<td>${escapeHtml(container.image)}</td>` : "";
        return `<tr><td>${containerNameCell(container)}</td><td>${containerStateBadge(container.state)}</td>${category}${detail}${image}<td>${portsCell(container.ports)}</td></tr>`;
    }).join("");
}

/**
 * Home-page section: the containers the panel does not manage, so the stacks
 * table stays the management view and this stays observation. Managed containers
 * are omitted here (they already appear under their stack).
 */
export function otherContainersSection(containers: ClassifiedContainer[], filter: ContainerFilter = "running", unavailable: string | null = null): string {
    if (unavailable) return `<section class="card"><h2>Other containers</h2>${note("warn", unavailable)}</section>`;
    const others = containers.filter(container => container.category !== "managed" && matchesContainerFilter(container.state, filter));
    const link = `<p><a href="/containers">View all containers →</a></p>`;
    const head = `<th>Name</th><th>State</th><th>Category</th><th>Image</th><th>Ports</th>`;
    const content = others.length > 0
        ? `<p class="muted">Docker containers outside managed stacks. Read only: Compose Panel never starts, stops or removes them.</p>`
            + `<div class="table-wrap"><table class="table"><thead><tr>${head}</tr></thead><tbody>${containerRows(others, "compact")}</tbody></table></div>`
            + link
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
    const visible = options.containers.filter(container => matchesContainerFilter(container.state, options.filter));
    const filters = CONTAINER_FILTERS.map(([value, label]) => {
        const active = value === options.filter;
        return `<a href="/containers?state=${value}" class="btn${active ? " btn-primary" : ""}"${active ? ` aria-current="page"` : ""}>${label}</a>`;
    }).join("");
    const order: ContainerCategory[] = ["managed", "external", "standalone"];
    const sections = order.map(category => {
        const list = visible.filter(container => container.category === category);
        if (list.length === 0) return "";
        const content = `<div class="table-wrap"><table class="table"><thead><tr><th>Name</th><th>State</th><th class="col-optional">Detail</th><th>Image</th><th>Ports</th></tr></thead><tbody>${containerRows(list, "full")}</tbody></table></div>`;
        return `<section class="card"><h2>${escapeHtml(CONTAINER_CATEGORY_LABELS[category])} <span class="muted">(${list.length})</span></h2>${content}</section>`;
    }).join("");
    const body = `<p class="crumbs"><a href="/">← All stacks</a></p>`
        + `<div class="page-head"><h1>Containers</h1></div>`
        + `<p class="lead">Every container Docker reports. <strong>Managed</strong> containers belong to a stack and are driven from its page; <strong>External Compose</strong> and <strong>Standalone</strong> containers are observed only. Read only: no start, stop, restart or remove.</p>`
        + (options.note ? note("warn", options.note) : "")
        + `<div class="toolbar">${filters}</div>`
        + (sections || (options.note ? "" : note("info", "No containers match this view.")));
    return documentHtml("Containers", body, { logoutCsrf: options.csrf, access: options.access, timezone: options.timezone, scripts: ["/app.js"], nav: options.nav });
}

const ATTENTION_LABELS: Record<AttentionReason, string> = {
    "unhealthy": "Unhealthy",
    "restarting": "Restarting",
    "exited-nonzero": "Exited with an error",
};

function formatBytes(bytes: number | null): string {
    if (bytes === null || !Number.isFinite(bytes)) return "—";
    if (bytes < 1024) return `${Math.round(bytes)} B`;
    const units = ["KiB", "MiB", "GiB", "TiB", "PiB"];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function formatPercent(value: number | null): string {
    if (value === null || !Number.isFinite(value)) return "—";
    return `${Math.round(value * 10) / 10}%`;
}

/** A stack link for a managed container, else the category, else a dash. */
function stackCell(container: ClassifiedContainer | null): string {
    if (!container) return `<span class="muted">Unattributed</span>`;
    if (container.stack) return `<a href="/stacks/${encodeURIComponent(container.stack)}">${escapeHtml(container.stack)}</a>`;
    return `<span class="muted">${escapeHtml(CONTAINER_CATEGORY_LABELS[container.category])}</span>`;
}

function statRows(stats: ClassifiedStat[]): string {
    return stats.map(stat => {
        // Used memory is the figure that matters; the limit is a hover detail
        // (Mem % already gives the proportion).
        const limit = stat.memLimitBytes === null ? "" : ` title="of ${escapeHtml(formatBytes(stat.memLimitBytes))}"`;
        const memory = stat.memUsedBytes === null
            ? `<span class="muted">—</span>`
            : `<span${limit}>${escapeHtml(formatBytes(stat.memUsedBytes))}</span>${usageBar(stat.memPercent === null ? null : stat.memPercent / 100)}`;
        return `<tr><td><a href="/containers/${encodeURIComponent(stat.id)}">${escapeHtml(statDisplayName(stat))}</a></td>`
            + `<td>${stackCell(stat.container)}</td>`
            + `<td class="num">${escapeHtml(formatPercent(stat.cpuPercent))}</td>`
            + `<td class="num">${memory}</td>`
            + `<td class="num col-optional">${escapeHtml(formatPercent(stat.memPercent))}</td>`
            + `<td class="col-optional"><code>${escapeHtml(stat.netIo || "—")}</code></td>`
            + `<td class="col-optional"><code>${escapeHtml(stat.blockIo || "—")}</code></td>`
            + `<td class="num col-optional">${stat.pids === null ? `<span class="muted">—</span>` : stat.pids}</td></tr>`;
    }).join("");
}

/**
 * A thin usage bar under a number. Inline SVG with the width as an attribute,
 * so the CSP (no inline styles) allows it; colors come from CSS. Decorative:
 * the number next to it carries the value, so the SVG is hidden from screen
 * readers. Nothing when the fraction is unknown. Mirrored by `bar()` in app.js.
 */
export function usageBar(fraction: number | null): string {
    if (fraction === null || !Number.isFinite(fraction)) return "";
    const value = Math.min(Math.max(fraction, 0), 1);
    const width = Math.round(value * 1000) / 10;
    const high = value >= 0.9 ? " bar-high" : "";
    return `<svg class="bar${high}" viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true" focusable="false"><rect class="bar-track" width="100" height="4" rx="2"/><rect class="bar-fill" width="${width}" height="4" rx="2"/></svg>`;
}

function stackRows(stacks: StackUsage[], memoryTotalBytes: number | null): string {
    return stacks.map(usage => `<tr><td><a href="/stacks/${encodeURIComponent(usage.stack)}">${escapeHtml(usage.stack)}</a></td>`
        + `<td class="num">${escapeHtml(formatPercent(usage.cpuPercent))}</td>`
        + `<td class="num">${escapeHtml(formatBytes(usage.memUsedBytes))}${usageBar(memoryTotalBytes ? usage.memUsedBytes / memoryTotalBytes : null)}</td>`
        + `<td class="num">${usage.containers}</td></tr>`).join("");
}

function attentionRows(items: AttentionItem[]): string {
    return items.map(item => {
        const cls = item.reason === "unhealthy" ? "state-failed" : "state-stopped";
        const stack = item.stack ? `<a href="/stacks/${encodeURIComponent(item.stack)}">${escapeHtml(item.stack)}</a>` : `<span class="muted">—</span>`;
        return `<tr><td><a href="/containers/${encodeURIComponent(item.id)}">${escapeHtml(item.name)}</a></td>`
            + `<td><span class="state ${cls}">${escapeHtml(ATTENTION_LABELS[item.reason])}</span></td><td>${stack}</td></tr>`;
    }).join("");
}

function exitedRows(items: AttentionItem[]): string {
    return items.map(item => {
        const stack = item.stack ? `<a href="/stacks/${encodeURIComponent(item.stack)}">${escapeHtml(item.stack)}</a>` : `<span class="muted">—</span>`;
        return `<tr><td><a href="/containers/${encodeURIComponent(item.id)}">${escapeHtml(item.name)}</a></td><td>${stack}</td></tr>`;
    }).join("");
}

/**
 * Stopped-with-an-error containers, folded under Needs attention. Kept in the
 * page even when empty (hidden) so the Live refresh can fill it.
 */
function exitedSection(items: AttentionItem[] | null): string {
    const list = items ?? [];
    const hidden = list.length === 0 ? " hidden" : "";
    return `<details class="exited" id="live-exited"${hidden}><summary>Stopped with an error (<span id="live-exited-count">${list.length}</span>)</summary>`
        + `<div class="table-wrap"><table class="table"><thead><tr><th>Container</th><th>Stack</th></tr></thead><tbody id="live-exited-rows">${exitedRows(list)}</tbody></table></div></details>`;
}

function diskRows(rows: DiskUsageRow[]): string {
    return rows.map(row => `<tr><td>${escapeHtml(row.type)}</td>`
        + `<td>${row.totalCount === null ? `<span class="muted">—</span>` : row.totalCount}</td>`
        + `<td>${row.active === null ? `<span class="muted">—</span>` : row.active}</td>`
        + `<td class="num">${escapeHtml(row.size || "—")}</td>`
        + `<td class="num">${escapeHtml(row.reclaimable || "—")}${usageBar(row.sizeBytes && row.reclaimableBytes !== null ? row.reclaimableBytes / row.sizeBytes : null)}</td></tr>`).join("");
}

function engineFacts(info: EngineInfo): string {
    return `<div class="table-wrap"><table class="table"><thead><tr><th>Operating system</th><th class="col-optional">Kernel</th><th>Architecture</th><th>Engine</th><th class="col-optional">Storage driver</th></tr></thead><tbody><tr>`
        + `<td>${escapeHtml(info.operatingSystem ?? "—")}</td>`
        + `<td class="col-optional">${escapeHtml(info.kernelVersion ?? "—")}</td>`
        + `<td>${escapeHtml(info.architecture ?? "—")}</td>`
        + `<td>${escapeHtml(info.engineVersion ?? "—")}</td>`
        + `<td class="col-optional">${escapeHtml(info.driver ?? "—")}</td></tr></tbody></table></div>`;
}

export interface ServerPageOptions {
    csrf: string;
    access?: string;
    timezone?: string;
    nav?: NavigationOptions;
    insights: Insights;
    /** Disk usage when requested with ?disk=1; null shows the on-demand link. */
    disk: DiskUsage | null;
}

/**
 * Read-only Docker diagnostics for the host's engine: what runs, what consumes,
 * and what needs attention. Honest by construction: engine facts are labelled as
 * the daemon's machine (not host monitoring), disk usage is Docker-managed only,
 * stack CPU is a cumulative figure that may exceed 100 %, and an unavailable
 * section is never rendered as zero.
 */
export function serverPage(options: ServerPageOptions): string {
    const { insights } = options;
    const timeTag = (ms: number): string => {
        const iso = new Date(ms).toISOString();
        return `<time datetime="${escapeHtml(iso)}" data-local-time="full">${escapeHtml(iso.slice(0, 19).replace("T", " "))} UTC</time>`;
    };
    // Empty-state rows live inside the tbody so the Live update can replace the
    // rows without the client rebuilding the whole table.
    const emptyRow = (columns: number, text: string): string => `<tr><td colspan="${columns}" class="muted">${escapeHtml(text)}</td></tr>`;

    const engineCard = `<section class="card"><h2>Docker engine${infoTip("As Docker sees it: this can be a virtual machine rather than the physical server.")}</h2>`
        + (insights.info
            ? `<div class="stats" aria-label="Docker Engine summary">`
                + `<div class="stat"><span class="stat-value">${insights.info.cpus ?? "—"}</span><span class="stat-label">CPUs</span></div>`
                + `<div class="stat"><span class="stat-value">${escapeHtml(formatBytes(insights.info.memoryTotalBytes))}</span><span class="stat-label">Memory</span></div>`
                + `<div class="stat"><span class="stat-value" id="live-running">${insights.runningContainers ?? "—"}</span><span class="stat-label">Running containers</span></div>`
                + `<div class="stat"><span class="stat-value" id="live-attention">${insights.attention === null ? "—" : insights.attention.length}</span><span class="stat-label">Needs attention</span></div>`
                + `</div>`
                + engineFacts(insights.info)
            : `<p class="muted">Engine details are unavailable.</p>`)
        + `</section>`;

    const topCard = `<section class="card"><h2>Top containers by CPU${infoTip("Network and block I/O are totals since each container started.")}</h2>`
        + `<div class="table-wrap"><table class="table"><thead><tr><th>Container</th><th>Stack</th><th class="num">CPU</th><th class="num">Memory</th><th class="num col-optional">Mem %</th><th class="col-optional">Network I/O</th><th class="col-optional">Block I/O</th><th class="num col-optional">PIDs</th></tr></thead><tbody id="live-stats">`
        + (insights.stats === null
            ? emptyRow(8, "Container usage is unavailable.")
            : insights.stats.length === 0
                ? emptyRow(8, "No running containers.")
                : statRows([...insights.stats].sort((a, b) => (b.cpuPercent ?? -1) - (a.cpuPercent ?? -1))))
        + `</tbody></table></div>`
        + `</section>`;

    const stacksCard = `<section class="card"><h2>Usage by stack${infoTip("CPU adds up the stack's containers. 100 % is one core, so it can go higher.")}</h2>`
        + `<div class="table-wrap"><table class="table"><thead><tr><th>Stack</th><th class="num">CPU</th><th class="num">Memory</th><th class="num">Containers</th></tr></thead><tbody id="live-stacks"${insights.info?.memoryTotalBytes ? ` data-mem-total="${insights.info.memoryTotalBytes}"` : ""}>`
        + (insights.stacks === null
            ? emptyRow(4, "Per-stack usage is unavailable.")
            : insights.stacks.length === 0
                ? emptyRow(4, "No managed running containers.")
                : stackRows(insights.stacks, insights.info?.memoryTotalBytes ?? null))
        + `</tbody></table></div>`
        + `</section>`;

    const attentionCard = `<section class="card"><h2>Needs attention${infoTip("Unhealthy or restarting right now. Containers that stopped with an error are listed below: a finished job often ends that way.")}</h2>`
        + `<div class="table-wrap"><table class="table"><thead><tr><th>Container</th><th>Issue</th><th>Stack</th></tr></thead><tbody id="live-attention-rows">`
        + (insights.attention === null
            ? emptyRow(3, "Container health could not be checked.")
            : insights.attention.length === 0
                ? emptyRow(3, "No current issues.")
                : attentionRows(insights.attention))
        + `</tbody></table></div>`
        + exitedSection(insights.exited)
        + `</section>`;

    let diskCard: string;
    if (options.disk === null) {
        diskCard = `<p><a class="btn" href="/server?disk=1">Show disk usage</a></p>`;
    } else if (options.disk.rows === null) {
        diskCard = note("warn", options.disk.note ?? "Docker disk usage is unavailable.")
            + `<p><a class="btn" href="/server?disk=1">Try again</a></p>`;
    } else {
        const readAt = options.disk.readAt === null ? "" : `<p class="muted">Read ${timeTag(options.disk.readAt)} · <a href="/server?disk=1">Read again</a></p>`;
        diskCard = `<div class="table-wrap"><table class="table"><thead><tr><th>Type</th><th>Items</th><th>Active</th><th class="num">Size</th><th class="num">Reclaimable</th></tr></thead><tbody>${diskRows(options.disk.rows)}</tbody></table></div>`
            + readAt;
    }
    const diskSection = `<section class="card"><h2>Docker disk usage${infoTip("Images, containers, volumes and build cache only, not the whole disk.")}</h2>${diskCard}</section>`;

    const body = `<p class="crumbs"><a href="/">← All stacks</a></p>`
        + `<div class="page-head"><h1>Server${infoTip("Only what Docker reports. Server load, uptime, filesystems and system updates are not shown.")}</h1></div>`
        + `<div class="server-toolbar" data-server-live data-server-stats="/server/stats" data-live-interval="15000">`
        + `<label class="live-toggle"><input type="checkbox" id="server-live"> Live (every 15 s)</label>`
        + `<span class="muted">Updated <time id="live-read-at" datetime="${escapeHtml(new Date(insights.readAt).toISOString())}" data-local-time="full">${escapeHtml(new Date(insights.readAt).toISOString().slice(0, 19).replace("T", " "))} UTC</time></span>`
        + `<span id="server-live-status" class="muted" role="status" aria-live="polite"></span>`
        + `<a class="btn btn-quiet" href="/server">Refresh</a>`
        + `</div>`
        + `<p class="lead">What runs on this Docker engine and what it uses.</p>`
        + insights.notes.map(text => note("warn", text)).join("")
        + engineCard
        + topCard
        + stacksCard
        + attentionCard
        + diskSection;
    return documentHtml("Server", body, { logoutCsrf: options.csrf, access: options.access, timezone: options.timezone, scripts: ["/app.js"], nav: options.nav });
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
    const rows = details.ports.map(port => {
        const host = port.host ? `<code>${escapeHtml(port.host)}</code>` : `<span class="muted">Not published</span>`;
        const scope = port.publicInterface ? ` <span class="state state-stopped">All interfaces</span>` : "";
        return `<tr><td><code>${escapeHtml(port.container)}</code></td><td>${host}${scope}</td></tr>`;
    }).join("");
    return `<section class="card"><h2>Ports</h2>`
        + `<p class="muted">“All interfaces” means Docker binds the port on every host interface. A firewall or NAT outside the panel may still block it.</p>`
        + `<div class="table-wrap"><table class="table"><thead><tr><th>Container</th><th>Host binding</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

function containerMountsSection(details: ContainerDetails): string {
    if (details.mounts.length === 0) {
        return `<section class="card"><h2>Mounts</h2><p class="muted">No mounts.</p></section>`;
    }
    const rows = details.mounts.map(mount => {
        const mode = mount.mode || (mount.readOnly ? "ro" : "rw");
        return `<tr><td>${escapeHtml(mount.type)}</td><td>${mount.source ? `<code>${escapeHtml(mount.source)}</code>` : `<span class="muted">—</span>`}</td>`
            + `<td><code>${escapeHtml(mount.destination)}</code></td><td>${escapeHtml(mode)}</td></tr>`;
    }).join("");
    return `<section class="card"><details><summary>Mounts (${details.mounts.length})</summary>`
        + `<p class="muted">Host source paths are shown for debugging: treat them as sensitive.</p>`
        + `<div class="table-wrap"><table class="table"><thead><tr><th>Type</th><th>Source (host)</th><th>Destination</th><th>Mode</th></tr></thead><tbody>${rows}</tbody></table></div></details></section>`;
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
    return `<section class="card logs" data-container-logs="${base}"><h2>Logs</h2>`
        + `<p class="muted">Last ${tailLines} lines, read once on demand. Read only: the panel never follows or restarts this container.${zoneHint}</p>`
        + `<div class="toolbar"><a class="btn" href="${base}?tail=${tailLines}">Latest ${tailLines} lines</a><button type="button" class="btn" id="container-logs-refresh">Refresh</button></div>`
        + `<p id="container-logs-status" class="muted" role="status">Not loaded.</p>`
        + `<pre class="output" id="container-logs-output"></pre>`
        + `</section>`;
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
 * projection, ports, restart policy, health and mounts (collapsed); there is no
 * start/stop/remove/exec and no env or args.
 */
export function containerDetailPage(options: ContainerDetailPageOptions): string {
    const container = options.container;
    const details = options.details;
    const name = container.name || container.id.slice(0, 12);
    const stackLink = container.category === "managed" && container.stack
        ? ` · <a href="/stacks/${encodeURIComponent(container.stack)}">Stack ${escapeHtml(container.stack)}</a>`
        : "";
    let extras = "";
    if (details) {
        extras = `<section class="card"><h2>Details</h2><div class="table-wrap"><table class="table"><tbody>`
            + detailRow("Container ID", `<code>${escapeHtml(details.id)}</code>`)
            + detailRow("Image", details.image ? `<code>${escapeHtml(details.image)}</code>` : `<span class="muted">—</span>`)
            + detailRow("State", `${containerStateBadge(details.state)} <span class="muted">${escapeHtml(container.status)}</span>`)
            + detailRow("Health", healthCell(details.health))
            + detailRow("Restart policy", details.restartPolicy ? `<code>${escapeHtml(details.restartPolicy)}</code>` : `<span class="muted">—</span>`)
            + detailRow("Created", containerTime(details.created))
            + detailRow("Started", containerTime(details.startedAt))
            + detailRow("Finished", containerTime(details.finishedAt))
            + detailRow("Exit code", details.exitCode !== null ? `<code>${details.exitCode}</code>` : `<span class="muted">—</span>`)
            + `</tbody></table></div></section>`
            + containerPortsSection(details)
            + containerMountsSection(details);
    } else {
        extras = `<section class="card"><h2>Details</h2><p class="muted">No details available.</p></section>`
            + `<section class="card"><h2>Ports</h2><p class="muted">Ports are shown from the container list: <code>${escapeHtml(container.ports || "none")}</code>.</p></section>`;
    }
    const body = `<p class="crumbs"><a href="/containers">← All containers</a></p>`
        + `<div class="page-head"><h1>${escapeHtml(name)}</h1></div>`
        + `<p class="meta">${containerStateBadge(container.state)}<span class="state">${escapeHtml(CONTAINER_CATEGORY_LABELS[container.category])}</span>`
        + `<span class="muted">Read only: observation only, no action on this container.</span>${stackLink}</p>`
        + (options.note ? note("warn", options.note) : "")
        + extras
        + containerLogsPanel(container.id, options.logTailLines, options.timezone);
    return documentHtml(name, body, { logoutCsrf: options.csrf, access: options.access, timezone: options.timezone, scripts: ["/app.js"], nav: options.nav });
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
            "Vary": "Cookie",
            "Content-Security-Policy": "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
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
    const timeTag = (iso: string | null): string => iso
        ? `<time datetime="${escapeHtml(iso)}" data-local-time="full">${escapeHtml(iso.slice(0, 19).replace("T", " "))} UTC</time>`
        : `<span class="muted">—</span>`;
    const error = options.error ? note("error", options.error.message, { title: options.error.title }) : "";
    const notice = options.notice ? note(options.notice.kind, options.notice.text) : "";
    const support = status.support;
    const identity = support.kind === "ready" ? support.identity : null;

    const rows = [detailRow("Version", `<code>${escapeHtml(VERSION)}</code>`)];
    if (identity) {
        const running = status.current ? `<span class="version">${escapeHtml(versionText(status.current))}</span>` : `<span class="muted">unknown</span>`;
        rows.push(
            detailRow("Image", `<code>${escapeHtml(identity.imageRef)}</code>`),
            detailRow("Running image", running),
            detailRow("Compose project", `<code>${escapeHtml(identity.project)}</code> · service <code>${escapeHtml(identity.service)}</code>`),
            detailRow("Deployment directory", `<code>${escapeHtml(identity.workingDir)}</code>`),
        );
    }
    const unsupported = support.kind === "unsupported"
        ? note("warn", `${support.reason} The steps are in docs/deployment.md, under "Upgrade and rollback".`, { title: "Self-update unavailable." })
        : "";
    const panelCard = `<section class="card"><h2>This panel</h2><div class="table-wrap"><table class="table"><tbody>${rows.join("")}</tbody></table></div>${unsupported}</section>`;

    const lastRun = status.lastRun;
    const updating = options.pending || (lastRun.kind === "run" && lastRun.run.outcome === "running");
    let updatesCard = "";
    if (identity) {
        let body: string;
        if (updating) {
            const waiting = note("info", "Compose Panel restarts during the update, so this page is unavailable for a moment. It reloads by itself when the panel is back; sign in again then. Your stacks keep running.", { title: "An update is running." });
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
                    const warning = note("warn", "Compose Panel restarts during the update: the page is unavailable for a moment and you sign in again afterwards. Your stacks keep running. Wait for running actions and saves to finish first. Click the button above again to cancel.");
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
        const output = options.output === null
            ? `<p class="muted">Docker could not read the updater output. Run <code>docker logs ${UPDATER_NAME}</code> on the host.</p>`
            : `<details${open}><summary>Updater output</summary><pre class="output">${escapeHtml(options.output.replace(/\s+$/, "") || "(no output)")}</pre></details>`;
        const recovery = run.outcome === "failed" && identity
            ? `${note("error", "The panel container may not be in the expected state. Run these commands on the host to finish or redo the update.", { title: "Update failed." })}<pre class="output">${escapeHtml(recoveryText(identity))}</pre>`
            : "";
        // The updater kept the exact previous image; offer the way back after
        // any update that reached the recreate.
        const rollback = (run.outcome === "failed" || run.outcome === "updated") && identity && run.previousImage
            ? `<details${run.outcome === "failed" ? " open" : ""}><summary>Roll back to the previous image</summary><p class="muted">The previous image is kept locally as <code>${escapeHtml(ROLLBACK_TAG)}</code>. These host commands recreate the panel from it, without downloading anything or editing a file.</p><pre class="output">${escapeHtml(rollbackCommands(identity).join("\n"))}</pre></details>`
            : "";
        const imageRow = (label: string, version: string | null, id: string | null): string =>
            id ? detailRow(label, `${version ? `<span class="version">${escapeHtml(version)}</span> ` : ""}<code>${escapeHtml(id)}</code>`) : "";
        const images = imageRow("Previous image", run.previousVersion, run.previousImage) + imageRow("Target image", run.targetVersion, run.targetImage);
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
    return documentHtml("About", body, { logoutCsrf: options.csrf, access: options.access, timezone: options.timezone, scripts: ["/app.js"], nav: options.nav });
}
