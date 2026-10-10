import type { ComposeService } from "./compose-state.ts";
import type { OperationAction, OperationView } from "./operations.ts";
import type { AuditEntry } from "./audit.ts";

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
    /** Signed-in user name shown next to the sign-out button. */
    user?: string;
    /** Same-origin scripts to load with defer (e.g. "/app.js"). */
    scripts?: string[];
    /** Standalone centered page without header and footer (sign-in, signed out). */
    bare?: boolean;
}

export function documentHtml(title: string, body: string, options: DocumentOptions = {}): string {
    // 'body' must contain ONLY trusted markup assembled with escapeHtml().
    const user = options.user ? `<span class="user">${escapeHtml(options.user)}</span>` : "";
    const logout = options.logoutCsrf
        ? `<div class="session">${user}<form method="post" action="/logout" class="logout"><input type="hidden" name="csrf" value="${escapeHtml(options.logoutCsrf)}"><button type="submit" class="btn btn-quiet">Sign out</button></form></div>`
        : "";
    const scripts = (options.scripts ?? []).map(src => `<script src="${escapeHtml(src)}" defer></script>`).join("");
    return `<!doctype html>
<html lang="en">
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
    <footer>Your Compose files and Docker stay the source of truth: every stack shown here can still be managed with the <code>docker compose</code> CLI.</footer>
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
    user?: string;
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
</form>`, { logoutCsrf: options.csrf, user: options.user, scripts: ["/app.js"] });
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

function healthBadge(health: string | null): string {
    if (!health) return `<span class="muted">—</span>`;
    const cls = health === "healthy" ? "state-done" : health === "unhealthy" ? "state-failed" : "state-stopped";
    return `<span class="state ${cls}">${escapeHtml(health)}</span>`;
}

export function servicesSection(services: ComposeService[], state: string): string {
    let content: string;
    if (services.length > 0) {
        const rows = services
            .map(service => `<tr><td>${escapeHtml(service.name)}</td><td>${serviceBadge(service)}</td><td>${healthBadge(service.health)}</td></tr>`)
            .join("");
        content = `<div class="table-wrap"><table class="table"><thead><tr><th>Service</th><th>Container</th><th>Health check</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    } else if (state === "not-created") {
        content = `<p class="muted">No containers yet. Use <em>Up</em> to create them.</p>`;
    } else {
        content = `<p class="muted">No container information available.</p>`;
    }
    return `<section class="card"><h2>Services</h2>${content}</section>`;
}

const OPERATIONS: { action: OperationAction; label: string; help: string; style: string; needsDeployment: boolean }[] = [
    { action: "up", label: "Up", help: "Create or update the containers so they match the Compose file. Use this after editing.", style: "btn-primary", needsDeployment: false },
    { action: "pull-up", label: "Pull + up", help: "Download newer versions of the images first, then run Up.", style: "", needsDeployment: false },
    { action: "restart", label: "Restart", help: "Restart the existing containers. Does not apply file changes.", style: "", needsDeployment: true },
    { action: "stop", label: "Stop", help: "Stop the containers without removing them. Up starts them again.", style: "", needsDeployment: true },
    { action: "down", label: "Down", help: "Stop and remove the containers and networks. Volumes and images are kept.", style: "btn-danger", needsDeployment: true },
];

export const OPERATION_LABELS: Record<OperationAction, string> = Object.fromEntries(OPERATIONS.map(op => [op.action, op.label])) as Record<OperationAction, string>;

export function operationControls(name: string, csrf: string, options: { busy: boolean; deployed: boolean }): string {
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
            ? `<p class="muted">This stack is not deployed yet, so only <em>Up</em> and <em>Pull + up</em> are available.</p>`
            : "";
    return `<section class="card"><h2>Actions</h2>`
        + `<p class="muted">Actions run on the server and keep going if you close this page. Only one action or save runs at a time per stack.</p>`
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

export function logsPanel(name: string, tailLines: number): string {
    const stream = `/stacks/${encodeURIComponent(name)}/logs/events`;
    return `<section class="card logs" data-logs-stream="${stream}"><h2>Logs</h2>`
        + `<p class="muted">Shows the last ${tailLines} lines of every service, then new lines as they arrive. Following stops when you click <em>Stop following</em> or leave the page.</p>`
        + `<div class="toolbar"><button type="button" class="btn" id="logs-follow">Follow logs</button><button type="button" class="btn" id="logs-stop" disabled>Stop following</button></div>`
        + `<p id="logs-status" class="muted" role="status"></p>`
        + `<pre class="output" id="logs-output"></pre>`
        + `</section>`;
}

export interface AuditPageOptions {
    csrf: string;
    user?: string;
    periods: string[];
    selected: string | null;
    entries: AuditEntry[];
}

const AUDIT_RESULT_CLASS: Record<string, string> = {
    success: "state-done",
    failure: "state-failed",
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
        ? `<form method="get" action="/audit" class="toolbar"><label class="muted">Period <select name="period">${periodOptions}</select></label><button type="submit" class="btn">Show</button></form>`
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
            return `<tr><td><time datetime="${escapeHtml(entry.ts ?? "")}">${escapeHtml(when)}</time></td>`
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
        { logoutCsrf: options.csrf, user: options.user },
    );
}

export function htmlResponse(body: string, status = 200): Response {
    return new Response(body, {
        status,
        headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
            "X-Frame-Options": "DENY",
            "Vary": "Cookie",
            "Content-Security-Policy": "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        },
    });
}
