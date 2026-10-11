import type { ComposeService } from "./compose-state.ts";
import type { OperationAction, OperationView } from "./operations.ts";
import type { AuditEntry } from "./audit.ts";
import type { ImageVersion, ServiceUpdate } from "./updates.ts";
import type { AccessReport, AccessStatus } from "./access.ts";
import { matchesContainerFilter, type ClassifiedContainer, type ContainerCategory, type ContainerDetails, type ContainerFilter } from "./container-state.ts";
import type { AttentionItem, AttentionReason, ClassifiedStat, DiskUsage, DiskUsageRow, EngineInfo, Insights, StackUsage } from "./insights.ts";
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

export type NoteKind = "info" | "success" | "warn" | "error";

/** A message box. `text` is escaped; it is never interpreted as markup. */
export function note(kind: NoteKind, text: string, options: { title?: string; id?: string } = {}): string {
    const role = kind === "error" ? ` role="alert"` : "";
    const id = options.id ? ` id="${escapeHtml(options.id)}"` : "";
    const title = options.title ? `<strong>${escapeHtml(options.title)}</strong> ` : "";
    return `<div class="note note-${kind}"${id}${role}>${title}${escapeHtml(text)}</div>`;
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
}

export function documentHtml(title: string, body: string, options: DocumentOptions = {}): string {
    // 'body' must contain ONLY trusted markup assembled with escapeHtml().
    const logout = options.logoutCsrf
        ? `<div class="session"><form method="post" action="/logout" class="logout"><input type="hidden" name="csrf" value="${escapeHtml(options.logoutCsrf)}"><button type="submit" class="btn btn-quiet">Sign out</button></form></div>`
        : "";
    const scripts = (options.scripts ?? []).map(src => `<script src="${escapeHtml(src)}" defer></script>`).join("");
    const timezone = options.timezone ? ` data-timezone="${escapeHtml(options.timezone)}"` : "";
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
  <link rel="icon" href="/favicon.ico" sizes="48x48">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  ${scripts}
</head>
<body>
  ${options.bare ? `<main class="bare">${body}</main>` : `<div class="shell">
    <header><a href="/" class="brand"><img src="/favicon.svg" alt="" width="20" height="20">Compose Panel</a>${logout}</header>
    <main>${body}</main>
    <footer>Compose Panel ${escapeHtml(VERSION)}${options.logoutCsrf ? ` · <a href="/server">Server</a> · <a href="/containers">Containers</a> · <a href="/audit">Activity log</a> · <a href="/access">Access &amp; security</a>` : ""}${options.access ? ` · ${escapeHtml(options.access)}` : ""}</footer>
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
    composeFilename: string;
    composeSource: string;
    composeHash: string;
    envSource: string;
    envHash: string;
    envExists: boolean;
    error?: { title: string; message: string } | null;
}

export function editPage(options: EditPageOptions): string {
    const error = options.error ? note("error", options.error.message, { title: options.error.title }) : "";
    const stackHref = `/stacks/${encodeURIComponent(options.name)}`;
    const envHint = options.envExists
        ? "Variables for this stack. Values are secret: they are never logged and are hidden from error messages."
        : "This stack has no .env file. One is created only if you type something here.";
    return documentHtml(`Edit ${options.name}`, `<p class="crumbs"><a href="${stackHref}">← ${escapeHtml(options.name)}</a></p>
<h1>Edit files</h1>
<p class="lead">Changes are checked with <code>docker compose config</code> before anything is written. If the check fails, nothing changes on disk. Each save keeps a backup of the previous version. Saving does <strong>not</strong> restart anything: use <em>Up</em> on the stack page to apply the changes.</p>
${error}
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
</form>`, { logoutCsrf: options.csrf, access: options.access, timezone: options.timezone, scripts: ["/app.js"] });
}

const STATE_LABELS: Record<string, string> = {
    running: "Running",
    stopped: "Stopped",
    "not-created": "Not deployed",
    unknown: "Unknown",
};

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

/** "1.27.1 → 1.27.2"; when both sides read the same, the digests tell them apart. */
function updateSides(update: ServiceUpdate): [string, string] {
    const from = versionText(update.from);
    const to = versionText(update.to);
    if (from !== to) return [from, to];
    return [`${from} (${update.from.digest ?? "?"})`, `${to} (${update.to.digest ?? "?"})`];
}

export function updateText(update: ServiceUpdate): string {
    return updateSides(update).join(" → ");
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

export function servicesSection(services: ComposeService[], state: string, updates: Record<string, ServiceUpdate> = {}): string {
    let content: string;
    if (services.length > 0) {
        // Only show the health column when at least one service declares a
        // health check; otherwise it is an empty column with no information.
        const showHealth = services.some(service => service.health !== null);
        const rows = services
            .map(service => {
                const health = showHealth ? `<td class="col-optional">${healthBadge(service.health)}</td>` : "";
                return `<tr><td>${escapeHtml(service.name)}</td><td>${serviceBadge(service)}</td>${health}<td>${imageCell(service, updates[service.name])}</td></tr>`;
            })
            .join("");
        const healthHead = showHealth ? `<th class="col-optional">Health check</th>` : "";
        content = `<div class="table-wrap"><table class="table"><thead><tr><th>Service</th><th>Container</th>${healthHead}<th>Image</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    } else if (state === "not-created") {
        content = `<p class="muted">No containers yet. Use <em>Up</em> to create them.</p>`;
    } else {
        content = `<p class="muted">No container information available.</p>`;
    }
    return `<section class="card"><h2>Services</h2>${content}</section>`;
}

const OPERATIONS: { action: OperationAction; label: string; help: string; style: string; needsDeployment: boolean }[] = [
    { action: "up", label: "Up", help: "Create or update this stack's containers so they match the Compose file and the local images. Use this after editing or after Pull.", style: "btn-primary", needsDeployment: false },
    { action: "pull", label: "Pull", help: "Check this stack's images for updates and download them. No container is touched: services with a newer image are then marked “Update ready”.", style: "", needsDeployment: false },
    { action: "pull-up", label: "Pull + up", help: "Pull this stack's images, then Up, in one step: services with a newer image are recreated right away.", style: "", needsDeployment: false },
    { action: "restart", label: "Restart", help: "Restart all containers in this stack. Does not apply Compose file changes.", style: "", needsDeployment: true },
    { action: "stop", label: "Stop", help: "Stop this stack's containers without removing them. Up starts them again.", style: "", needsDeployment: true },
    { action: "down", label: "Down", help: "Stop and remove this stack's containers and networks. Volumes and images are kept.", style: "btn-danger", needsDeployment: true },
];

export const OPERATION_LABELS: Record<OperationAction, string> = Object.fromEntries(OPERATIONS.map(op => [op.action, op.label])) as Record<OperationAction, string>;

export function operationControls(name: string, csrf: string, options: { busy: boolean; deployed: boolean; updatesReady?: string[] }): string {
    const action = `/stacks/${encodeURIComponent(name)}/operations`;
    const rows = OPERATIONS.map(op => {
        const blocked = options.busy || (op.needsDeployment && !options.deployed);
        const disabled = blocked ? " disabled" : "";
        // Only actions that need a deployment are locked by it; the busy lock
        // is released by app.js when the running action finishes.
        const lock = op.needsDeployment && !options.deployed ? ` data-needs-deployment` : "";
        const form = (label: string) => `<form method="post" action="${action}" class="op-form"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="action" value="${op.action}"><button type="submit" class="btn ${op.style}"${disabled}${lock} data-op-button data-busy-label="Starting…">${escapeHtml(label)}</button></form>`;
        if (op.action === "down" && options.deployed) {
            // Destructive: a disclosure asks for a second, explicit click. Works without JS.
            return `<details class="op-confirm"><summary class="op-row"><span class="btn ${op.style}">${op.label}…</span><span class="op-help">${escapeHtml(op.help)}</span></summary>`
                + `<div class="op-confirm-panel">${note("warn", `This stops and removes every container and network of ${name}. Volumes and images are kept, and Up recreates the containers. Click Down… again to cancel.`)}`
                + `${form("Yes, remove the containers")}</div></details>`;
        }
        return `<div class="op-row">${form(op.label)}<p class="op-help">${escapeHtml(op.help)}</p></div>`;
    }).join("");
    const status = options.busy
        ? note("info", "An action is running. The buttons unlock when it finishes.", { id: "op-busy-note" })
        : !options.deployed
            ? `<p class="muted">This stack is not deployed yet, so only <em>Up</em>, <em>Pull</em> and <em>Pull + up</em> are available.</p>`
            : options.updatesReady && options.updatesReady.length > 0
                ? note("info", `Update ready for ${options.updatesReady.join(", ")}: Up recreates ${options.updatesReady.length === 1 ? "it" : "them"} with the newer image. The other services are not affected by the image change. Details under Services.`)
                : "";
    return `<section class="card"><h2>Actions</h2>`
        + `<p class="muted">These actions apply to this stack only. They run on the server and keep going if you close this page. Only one action or save runs at a time per stack.</p>`
        + `${status}<div class="op-list">${rows}</div></section>`;
}

const OPERATION_STATUS_LABELS: Record<string, string> = {
    running: "Running",
    succeeded: "Succeeded",
    failed: "Failed",
    unknown: "Outcome unknown",
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
export function operationDetails(operation: Pick<OperationView, "exitCode" | "timedOut" | "truncated" | "startedAt" | "endedAt">): string {
    const parts: string[] = [];
    if (operation.endedAt !== null) parts.push(`took ${formatDuration(operation.endedAt - operation.startedAt)}`);
    if (operation.exitCode !== null) parts.push(`exit code ${operation.exitCode}`);
    if (operation.timedOut) parts.push("stopped at the time limit — check the services to see what actually happened");
    if (operation.truncated) parts.push("output shortened (only the most recent part is kept)");
    return parts.join(" · ");
}

export function operationPanel(operation: OperationView | null, stack?: string): string {
    if (!operation) return "";
    const stackHref = stack !== undefined ? `/stacks/${encodeURIComponent(stack)}` : "/";
    const stream = stack !== undefined ? ` data-op-stream="${stackHref}/operations/events"` : "";
    const started = new Date(operation.startedAt).toISOString();
    const details = operationDetails(operation);
    return `<section class="card operation"${stream} data-op-status="${escapeHtml(operation.status)}" data-op-started="${operation.startedAt}">`
        + `<h2>Last action: ${escapeHtml(OPERATION_LABELS[operation.action] ?? operation.action)}</h2>`
        + `<p class="op-summary"><span class="state state-${escapeHtml(operation.status)}" id="op-status" aria-live="polite">${escapeHtml(operationStatusLabel(operation.status))}</span>`
        + ` <span class="muted">started <time datetime="${started}" data-local-time>${started.slice(11, 19)} UTC</time></span>`
        + `<span class="muted" id="op-meta">${details ? ` · ${escapeHtml(details)}` : ""}</span></p>`
        + `<pre class="output" id="op-output">${escapeHtml(operation.output)}</pre>`
        + `<p class="muted" id="op-live-note" hidden>Live output. Closing this page does not stop the action.</p>`
        + `<div class="note note-success" id="op-refresh" hidden>Finished. <a href="${stackHref}">Reload the page</a> to see the updated service status.</div>`
        + `</section>`;
}

export function logsPanel(name: string, tailLines: number, timezone = ""): string {
    const base = `/stacks/${encodeURIComponent(name)}/logs`;
    const zoneHint = timezone
        ? ` Times are shown in <strong>${escapeHtml(timezone)}</strong>.`
        : ` Times are shown in your browser's time zone.`;
    return `<section class="card logs" data-logs-snapshot="${base}" data-logs-stream="${base}/events"><h2>Logs</h2>`
        + `<p class="muted">Shows the last ${tailLines} lines of every service. <em>Follow live</em> then keeps new lines arriving. Following stops when you click <em>Stop following</em> or leave the page.${zoneHint}</p>`
        + `<div class="toolbar"><a class="btn" id="logs-latest" href="${base}">Latest ${tailLines} lines</a><button type="button" class="btn" id="logs-refresh">Refresh</button><button type="button" class="btn" id="logs-follow">Follow live</button><button type="button" class="btn" id="logs-stop" disabled>Stop following</button></div>`
        + `<p id="logs-status" class="muted" role="status">Not following.</p>`
        + `<pre class="output" id="logs-output"></pre>`
        + `</section>`;
}

export interface AuditPageOptions {
    csrf: string;
    access?: string;
    timezone?: string;
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
            const action = entry.action ? escapeHtml(entry.action) : `<span class="muted">—</span>`;
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
        { logoutCsrf: options.csrf, access: options.access, timezone: options.timezone, scripts: ["/app.js"] },
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
    return documentHtml("Access & security", body, { logoutCsrf: options.csrf, access: options.access, timezone: options.timezone, scripts: ["/app.js"] });
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
    return documentHtml("Containers", body, { logoutCsrf: options.csrf, access: options.access, timezone: options.timezone, scripts: ["/app.js"] });
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
        const name = stat.name || stat.id.slice(0, 12);
        const memory = stat.memUsedBytes === null
            ? `<span class="muted">—</span>`
            : escapeHtml(stat.memLimitBytes === null
                ? formatBytes(stat.memUsedBytes)
                : `${formatBytes(stat.memUsedBytes)} / ${formatBytes(stat.memLimitBytes)}`);
        return `<tr><td><a href="/containers/${encodeURIComponent(stat.id)}">${escapeHtml(name)}</a></td>`
            + `<td>${stackCell(stat.container)}</td>`
            + `<td>${escapeHtml(formatPercent(stat.cpuPercent))}</td>`
            + `<td>${memory}</td>`
            + `<td>${escapeHtml(formatPercent(stat.memPercent))}</td>`
            + `<td><code>${escapeHtml(stat.netIo || "—")}</code></td>`
            + `<td><code>${escapeHtml(stat.blockIo || "—")}</code></td>`
            + `<td>${stat.pids === null ? `<span class="muted">—</span>` : stat.pids}</td></tr>`;
    }).join("");
}

function stackRows(stacks: StackUsage[]): string {
    return stacks.map(usage => `<tr><td><a href="/stacks/${encodeURIComponent(usage.stack)}">${escapeHtml(usage.stack)}</a></td>`
        + `<td>${escapeHtml(formatPercent(usage.cpuPercent))}</td>`
        + `<td>${escapeHtml(formatBytes(usage.memUsedBytes))}</td>`
        + `<td>${usage.containers}</td></tr>`).join("");
}

function attentionRows(items: AttentionItem[]): string {
    return items.map(item => {
        const cls = item.reason === "unhealthy" ? "state-failed" : "state-stopped";
        const stack = item.stack ? `<a href="/stacks/${encodeURIComponent(item.stack)}">${escapeHtml(item.stack)}</a>` : `<span class="muted">—</span>`;
        return `<tr><td><a href="/containers/${encodeURIComponent(item.id)}">${escapeHtml(item.name)}</a></td>`
            + `<td><span class="state ${cls}">${escapeHtml(ATTENTION_LABELS[item.reason])}</span></td><td>${stack}</td></tr>`;
    }).join("");
}

function diskRows(rows: DiskUsageRow[]): string {
    return rows.map(row => `<tr><td>${escapeHtml(row.type)}</td>`
        + `<td>${row.totalCount === null ? `<span class="muted">—</span>` : row.totalCount}</td>`
        + `<td>${row.active === null ? `<span class="muted">—</span>` : row.active}</td>`
        + `<td>${escapeHtml(row.size || "—")}</td>`
        + `<td>${escapeHtml(row.reclaimable || "—")}</td></tr>`).join("");
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
    const readAtIso = new Date(insights.readAt).toISOString();
    const readAt = `<time datetime="${escapeHtml(readAtIso)}" data-local-time="full">${escapeHtml(readAtIso.slice(0, 19).replace("T", " "))} UTC</time>`;

    const engineCard = `<section class="card"><h2>Docker Engine diagnostics</h2>`
        + `<p class="muted">Facts Docker reports about the machine running the daemon, which may be a VM. This is not live host monitoring. Snapshot as of ${readAt}.</p>`
        + (insights.info
            ? `<div class="stats" aria-label="Docker Engine summary">`
                + `<div class="stat"><span class="stat-value">${insights.info.cpus ?? "—"}</span><span class="stat-label">Engine CPUs</span></div>`
                + `<div class="stat"><span class="stat-value">${escapeHtml(formatBytes(insights.info.memoryTotalBytes))}</span><span class="stat-label">Engine memory</span></div>`
                + `<div class="stat"><span class="stat-value">${insights.info.containersRunning ?? "—"}</span><span class="stat-label">Running containers</span></div>`
                + `<div class="stat"><span class="stat-value">${insights.attention === null ? "—" : insights.attention.length}</span><span class="stat-label">Needs attention</span></div>`
                + `</div>`
                + engineFacts(insights.info)
            : `<p class="muted">Docker Engine details are unavailable.</p>`)
        + `</section>`;

    const topContent = insights.stats === null
        ? `<p class="muted">Container usage is unavailable.</p>`
        : insights.stats.length === 0
            ? `<p class="muted">No running containers.</p>`
            : `<div class="table-wrap"><table class="table"><thead><tr><th>Container</th><th>Stack</th><th>CPU</th><th>Memory</th><th class="col-optional">Mem %</th><th class="col-optional">Network I/O</th><th class="col-optional">Block I/O</th><th class="col-optional">PIDs</th></tr></thead><tbody>`
                + statRows([...insights.stats].sort((a, b) => (b.cpuPercent ?? -1) - (a.cpuPercent ?? -1)))
                + `</tbody></table></div>`
                + `<p class="muted">Reported by <code>docker stats</code>, read once on load. Network and block I/O are cumulative counters, not rates.</p>`;
    const topCard = `<section class="card"><h2>Top containers by CPU</h2>${topContent}</section>`;

    const stacksContent = insights.stacks === null
        ? `<p class="muted">Per-stack usage is unavailable.</p>`
        : insights.stacks.length === 0
            ? `<p class="muted">No managed running containers.</p>`
            : `<div class="table-wrap"><table class="table"><thead><tr><th>Stack</th><th>CPU (cumulated)</th><th>Memory (summed)</th><th>Containers</th></tr></thead><tbody>`
                + stackRows(insights.stacks)
                + `</tbody></table></div>`
                + `<p class="muted">CPU is summed across the stack's containers and may exceed 100 %: Docker's scale is per core.</p>`;
    const stacksCard = `<section class="card"><h2>Per-stack usage</h2>${stacksContent}</section>`;

    const attentionContent = insights.attention === null
        ? `<p class="muted">Container health could not be checked.</p>`
        : insights.attention.length === 0
            ? `<p class="muted">No current issues.</p>`
            : `<div class="table-wrap"><table class="table"><thead><tr><th>Container</th><th>Issue</th><th>Stack</th></tr></thead><tbody>${attentionRows(insights.attention)}</tbody></table></div>`
                + `<p class="muted">A snapshot of the current state, with no history. An exited job with an error may be harmless.</p>`;
    const attentionCard = `<section class="card"><h2>Needs attention</h2>${attentionContent}</section>`;

    let diskCard: string;
    if (options.disk === null) {
        diskCard = `<p class="muted">Docker-managed storage is read on demand because it can be expensive on a large host.</p>`
            + `<p><a class="btn" href="/server?disk=1">Load disk usage</a></p>`;
    } else if (options.disk.rows === null) {
        diskCard = note("warn", options.disk.note ?? "Docker disk usage is unavailable.")
            + `<p><a class="btn" href="/server?disk=1">Try again</a></p>`;
    } else {
        diskCard = `<div class="table-wrap"><table class="table"><thead><tr><th>Type</th><th>Items</th><th>Active</th><th>Size</th><th>Reclaimable</th></tr></thead><tbody>${diskRows(options.disk.rows)}</tbody></table></div>`
            + `<p class="muted">Docker-managed storage only. Not total host disk usage. Snapshot as of ${readAt}.</p>`;
    }
    const diskSection = `<section class="card"><h2>Docker disk usage</h2>${diskCard}</section>`;

    const body = `<p class="crumbs"><a href="/">← All stacks</a></p>`
        + `<div class="page-head"><h1>Server</h1></div>`
        + `<p class="lead">Docker's own diagnostics for this engine: what runs and what consumes resources. Read only. The wider host view — load, memory, uptime, filesystems and system updates — is not available here.</p>`
        + insights.notes.map(text => note("warn", text)).join("")
        + engineCard
        + topCard
        + stacksCard
        + attentionCard
        + diskSection;
    return documentHtml("Server", body, { logoutCsrf: options.csrf, access: options.access, timezone: options.timezone, scripts: ["/app.js"] });
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
    return documentHtml(name, body, { logoutCsrf: options.csrf, access: options.access, timezone: options.timezone, scripts: ["/app.js"] });
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
