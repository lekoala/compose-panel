import { CONTAINER_CATEGORY_LABELS, documentHtml, escapeHtml, infoTip, note, type NavigationOptions } from "../../html.ts";
import type { ClassifiedContainer } from "../../container-state.ts";
import type { MaintenanceView } from "../../host-maintenance.ts";
import {
    statDisplayName,
    type AttentionItem,
    type AttentionReason,
    type ClassifiedStat,
    type DiskUsage,
    type DiskUsageRow,
    type EngineInfo,
    type Insights,
    type StackUsage,
} from "../../insights.ts";
import { MAINTENANCE_SCOPES, type MaintenanceScope } from "../../maintenance.ts";
import { formatBytes, formatPercent } from "../../web/format.ts";

const ATTENTION_LABELS: Record<AttentionReason, string> = {
    unhealthy: "Unhealthy",
    restarting: "Restarting",
    "exited-nonzero": "Exited with an error",
};

/** A stack link for a managed container, else the category, else a dash. */
function stackCell(container: ClassifiedContainer | null): string {
    if (!container) return `<span class="muted">Unattributed</span>`;
    if (container.stack) return `<a href="/stacks/${encodeURIComponent(container.stack)}">${escapeHtml(container.stack)}</a>`;
    return `<span class="muted">${escapeHtml(CONTAINER_CATEGORY_LABELS[container.category])}</span>`;
}

/** Empty-state row shared by the first render and the Live refresh. */
function emptyRow(columns: number, text: string): string {
    return `<tr><td colspan="${columns}" class="muted">${escapeHtml(text)}</td></tr>`;
}

function statRows(stats: ClassifiedStat[]): string {
    return stats
        .map((stat) => {
            // Used memory is the figure that matters; the limit is a hover detail
            // (Mem % already gives the proportion).
            const limit = stat.memLimitBytes === null ? "" : ` title="of ${escapeHtml(formatBytes(stat.memLimitBytes))}"`;
            const memory =
                stat.memUsedBytes === null
                    ? `<span class="muted">—</span>`
                    : `<span${limit}>${escapeHtml(formatBytes(stat.memUsedBytes))}</span>${usageBar(stat.memPercent === null ? null : stat.memPercent / 100)}`;
            return (
                `<tr><td><a href="/containers/${encodeURIComponent(stat.id)}">${escapeHtml(statDisplayName(stat))}</a></td>` +
                `<td>${stackCell(stat.container)}</td>` +
                `<td class="num">${escapeHtml(formatPercent(stat.cpuPercent))}</td>` +
                `<td class="num">${memory}</td>` +
                `<td class="num col-optional">${escapeHtml(formatPercent(stat.memPercent))}</td>` +
                `<td class="col-optional"><code>${escapeHtml(stat.netIo || "—")}</code></td>` +
                `<td class="col-optional"><code>${escapeHtml(stat.blockIo || "—")}</code></td>` +
                `<td class="num col-optional">${stat.pids === null ? `<span class="muted">—</span>` : stat.pids}</td></tr>`
            );
        })
        .join("");
}

/**
 * Rows for the Live stats table, shared with the first render. null means "not
 * obtained"; the caller keeps the last rows instead of replacing them.
 */
export function serverStatsRows(stats: ClassifiedStat[] | null): string | null {
    if (stats === null) return null;
    if (stats.length === 0) return emptyRow(8, "No running containers.");
    return statRows([...stats].sort((a, b) => (b.cpuPercent ?? -1) - (a.cpuPercent ?? -1)));
}

/**
 * A thin usage bar under a number. Inline SVG with the width as an attribute,
 * so the CSP (no inline styles) allows it; colors come from CSS. Decorative:
 * the number next to it carries the value, so the SVG is hidden from screen
 * readers. Nothing when the fraction is unknown.
 */
export function usageBar(fraction: number | null): string {
    if (fraction === null || !Number.isFinite(fraction)) return "";
    const value = Math.min(Math.max(fraction, 0), 1);
    const width = Math.round(value * 1000) / 10;
    const high = value >= 0.9 ? " bar-high" : "";
    return `<svg class="bar${high}" viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true" focusable="false"><rect class="bar-track" width="100" height="4" rx="2"/><rect class="bar-fill" width="${width}" height="4" rx="2"/></svg>`;
}

function stackRows(stacks: StackUsage[], memoryTotalBytes: number | null): string {
    return stacks
        .map(
            (usage) =>
                `<tr><td><a href="/stacks/${encodeURIComponent(usage.stack)}">${escapeHtml(usage.stack)}</a></td>` +
                `<td class="num">${escapeHtml(formatPercent(usage.cpuPercent))}</td>` +
                `<td class="num">${escapeHtml(formatBytes(usage.memUsedBytes))}${usageBar(memoryTotalBytes ? usage.memUsedBytes / memoryTotalBytes : null)}</td>` +
                `<td class="num">${usage.containers}</td></tr>`,
        )
        .join("");
}

/** Rows for the Live stack table; null keeps the last rows. */
export function serverStackRows(stacks: StackUsage[] | null, memoryTotalBytes: number | null): string | null {
    if (stacks === null) return null;
    if (stacks.length === 0) return emptyRow(4, "No managed running containers.");
    return stackRows(stacks, memoryTotalBytes);
}

function attentionRows(items: AttentionItem[]): string {
    return items
        .map((item) => {
            const cls = item.reason === "unhealthy" ? "state-failed" : "state-stopped";
            const stack = item.stack
                ? `<a href="/stacks/${encodeURIComponent(item.stack)}">${escapeHtml(item.stack)}</a>`
                : `<span class="muted">—</span>`;
            return (
                `<tr><td><a href="/containers/${encodeURIComponent(item.id)}">${escapeHtml(item.name)}</a></td>` +
                `<td><span class="state ${cls}">${escapeHtml(ATTENTION_LABELS[item.reason])}</span></td><td>${stack}</td></tr>`
            );
        })
        .join("");
}

/** Rows for the Live attention table; null keeps the last rows. */
export function serverAttentionRows(items: AttentionItem[] | null): string | null {
    if (items === null) return null;
    if (items.length === 0) return emptyRow(3, "No current issues.");
    return attentionRows(items);
}

function exitedRows(items: AttentionItem[]): string {
    return items
        .map((item) => {
            const stack = item.stack
                ? `<a href="/stacks/${encodeURIComponent(item.stack)}">${escapeHtml(item.stack)}</a>`
                : `<span class="muted">—</span>`;
            return `<tr><td><a href="/containers/${encodeURIComponent(item.id)}">${escapeHtml(item.name)}</a></td><td>${stack}</td></tr>`;
        })
        .join("");
}

/** Exited-with-error rows for the Live refresh; null keeps the last rows. */
function serverExitedRows(items: AttentionItem[] | null): string | null {
    if (items === null) return null;
    return items.length === 0 ? "" : exitedRows(items);
}

/**
 * Stopped-with-an-error containers, folded under Needs attention. Kept in the
 * page even when empty (hidden) so the Live refresh can fill it.
 */
function exitedSection(items: AttentionItem[] | null): string {
    const list = items ?? [];
    const hidden = list.length === 0 ? " hidden" : "";
    return (
        `<details class="exited" id="live-exited"${hidden}><summary>Stopped with an error (<span id="live-exited-count">${list.length}</span>)</summary>` +
        `<div class="table-wrap"><table class="table"><thead><tr><th>Container</th><th>Stack</th></tr></thead><tbody id="live-exited-rows">${serverExitedRows(list) ?? ""}</tbody></table></div></details>`
    );
}

function diskRows(rows: DiskUsageRow[]): string {
    return rows
        .map(
            (row) =>
                `<tr><td>${escapeHtml(row.type)}</td>` +
                `<td>${row.totalCount === null ? `<span class="muted">—</span>` : row.totalCount}</td>` +
                `<td>${row.active === null ? `<span class="muted">—</span>` : row.active}</td>` +
                `<td class="num">${escapeHtml(row.size || "—")}</td>` +
                `<td class="num">${escapeHtml(row.reclaimable || "—")}${usageBar(row.sizeBytes && row.reclaimableBytes !== null ? row.reclaimableBytes / row.sizeBytes : null)}</td></tr>`,
        )
        .join("");
}

function engineFacts(info: EngineInfo): string {
    return (
        `<div class="table-wrap"><table class="table"><thead><tr><th>Operating system</th><th class="col-optional">Kernel</th><th>Architecture</th><th>Engine</th><th class="col-optional">Storage driver</th></tr></thead><tbody><tr>` +
        `<td>${escapeHtml(info.operatingSystem ?? "—")}</td>` +
        `<td class="col-optional">${escapeHtml(info.kernelVersion ?? "—")}</td>` +
        `<td>${escapeHtml(info.architecture ?? "—")}</td>` +
        `<td>${escapeHtml(info.engineVersion ?? "—")}</td>` +
        `<td class="col-optional">${escapeHtml(info.driver ?? "—")}</td></tr></tbody></table></div>`
    );
}

const MAINTENANCE_CARDS: Record<MaintenanceScope, { title: string; button: string; confirm: string; warning: string }> = {
    "build-cache": {
        title: "Build cache",
        button: "Prune build cache…",
        confirm: "Yes, prune the build cache",
        warning:
            "Build cache entries older than 7 days are removed. The next builds are slower until the cache is rebuilt. Cache kept by a separate Buildx builder or collected by BuildKit garbage collection is not covered.",
    },
    "dangling-images": {
        title: "Dangling images",
        button: "Prune dangling images…",
        confirm: "Yes, prune dangling images",
        warning:
            "Untagged images older than 7 days that no container references are removed. They must be rebuilt or downloaded if they are needed again.",
    },
    "unused-images": {
        title: "Unused images",
        button: "Prune unused images…",
        confirm: "Yes, prune unused images",
        warning:
            "Every image older than 7 days that no container references is removed, including tagged images. Future deployments, service recreations and rollbacks may need to download or rebuild them, including the panel's own rollback image. A stopped container keeps its image.",
    },
};

export interface ServerPageOptions {
    csrf: string;
    access?: string;
    timezone?: string;
    nav?: NavigationOptions;
    insights: Insights;
    /** Disk usage when requested with ?disk=1; null shows the on-demand link. */
    disk: DiskUsage | null;
    /** Last maintenance run in this process, if any. The card is always shown. */
    maintenance: { last: MaintenanceView | null };
    /** Fixed server-side feedback after a redirect, already trusted copy. */
    notice?: string;
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

    const engineCard =
        `<section class="card"><h2>Docker engine${infoTip("As Docker sees it: this can be a virtual machine rather than the physical server.")}</h2>` +
        (insights.info
            ? `<div class="stats" aria-label="Docker Engine summary">` +
              `<div class="stat"><span class="stat-value">${insights.info.cpus ?? "—"}</span><span class="stat-label">CPUs</span></div>` +
              `<div class="stat"><span class="stat-value">${escapeHtml(formatBytes(insights.info.memoryTotalBytes))}</span><span class="stat-label">Memory</span></div>` +
              `<div class="stat"><span class="stat-value" id="live-running">${insights.runningContainers ?? "—"}</span><span class="stat-label">Running containers</span></div>` +
              `<div class="stat"><span class="stat-value" id="live-attention">${insights.attention === null ? "—" : insights.attention.length}</span><span class="stat-label">Needs attention</span></div>` +
              `</div>` +
              engineFacts(insights.info)
            : `<p class="muted">Engine details are unavailable.</p>`) +
        `</section>`;

    const topCard =
        `<section class="card"><h2>Top containers by CPU${infoTip("Network and block I/O are totals since each container started.")}</h2>` +
        `<div class="table-wrap"><table class="table"><thead><tr><th>Container</th><th>Stack</th><th class="num">CPU</th><th class="num">Memory</th><th class="num col-optional">Mem %</th><th class="col-optional">Network I/O</th><th class="col-optional">Block I/O</th><th class="num col-optional">PIDs</th></tr></thead><tbody id="live-stats">` +
        (serverStatsRows(insights.stats) ?? emptyRow(8, "Container usage is unavailable.")) +
        `</tbody></table></div>` +
        `</section>`;

    const stacksCard =
        `<section class="card"><h2>Usage by stack${infoTip("CPU adds up the stack's containers. 100 % is one core, so it can go higher.")}</h2>` +
        `<div class="table-wrap"><table class="table"><thead><tr><th>Stack</th><th class="num">CPU</th><th class="num">Memory</th><th class="num">Containers</th></tr></thead><tbody id="live-stacks"${insights.info?.memoryTotalBytes ? ` data-mem-total="${insights.info.memoryTotalBytes}"` : ""}>` +
        (serverStackRows(insights.stacks, insights.info?.memoryTotalBytes ?? null) ?? emptyRow(4, "Per-stack usage is unavailable.")) +
        `</tbody></table></div>` +
        `</section>`;

    const attentionCard =
        `<section class="card"><h2>Needs attention${infoTip("Unhealthy or restarting right now. Containers that stopped with an error are listed below: a finished job often ends that way.")}</h2>` +
        `<div class="table-wrap"><table class="table"><thead><tr><th>Container</th><th>Issue</th><th>Stack</th></tr></thead><tbody id="live-attention-rows">` +
        (serverAttentionRows(insights.attention) ?? emptyRow(3, "Container health could not be checked.")) +
        `</tbody></table></div>` +
        exitedSection(insights.exited) +
        `</section>`;

    let diskCard: string;
    if (options.disk === null) {
        diskCard = `<p><a class="btn" href="/server?disk=1">Show disk usage</a></p>`;
    } else if (options.disk.rows === null) {
        diskCard =
            note("warn", options.disk.note ?? "Docker disk usage is unavailable.") +
            `<p><a class="btn" href="/server?disk=1">Try again</a></p>`;
    } else {
        const readAt =
            options.disk.readAt === null
                ? ""
                : `<p class="muted">Read ${timeTag(options.disk.readAt)} · <a href="/server?disk=1">Read again</a></p>`;
        diskCard =
            `<div class="table-wrap"><table class="table"><thead><tr><th>Type</th><th>Items</th><th>Active</th><th class="num">Size</th><th class="num">Reclaimable</th></tr></thead><tbody>${diskRows(options.disk.rows)}</tbody></table></div>` +
            readAt;
    }
    const diskSection = `<section class="card"><h2>Docker disk usage${infoTip("Images, containers, volumes and build cache only, not the whole disk.")}</h2>${diskCard}</section>`;

    const last = options.maintenance.last;
    const running = last?.status === "running";
    let status = `<p class="muted">No maintenance has run since the panel started.</p>`;
    if (last) {
        const card = MAINTENANCE_CARDS[last.scope];
        if (last.status === "running") {
            status =
                note("info", `${card.title}: pruning is running. This page does not update by itself.`) +
                `<p class="muted">Started ${timeTag(last.startedAt)}.</p>` +
                `<form method="get" action="/server"><button type="submit" class="btn btn-quiet">Refresh status</button></form>`;
        } else {
            const reclaimed =
                last.reclaimedBytes === null ? "Docker did not report a reclaimed size." : `${formatBytes(last.reclaimedBytes)} reclaimed.`;
            const kind = last.status === "succeeded" ? "success" : last.status === "failed" ? "error" : "warn";
            const text =
                last.status === "succeeded"
                    ? `${card.title} pruned. ${reclaimed}`
                    : last.status === "failed"
                      ? `${card.title} failed with exit code ${last.exitCode ?? "—"}. Some data may already have been removed: check Docker disk usage before retrying.`
                      : `${card.title}: the outcome is unknown because Docker did not confirm the end of the command. Check Docker disk usage before retrying.`;
            status =
                note(kind, text) +
                `<p class="muted">Started ${timeTag(last.startedAt)}` +
                (last.endedAt === null ? "" : ` · ended ${timeTag(last.endedAt)}`) +
                (last.timedOut ? " · reached its deadline" : "") +
                (last.truncated ? " · output truncated" : "") +
                `</p>` +
                `<form method="get" action="/server"><button type="submit" class="btn btn-quiet">Refresh status</button></form>` +
                (last.output.length === 0
                    ? ""
                    : `<details><summary>Command output</summary><pre class="output">${escapeHtml(last.output.replace(/\s+$/, "") || "(no output)")}</pre></details>`);
        }
    }
    const forms = MAINTENANCE_SCOPES.map((scope) => {
        const card = MAINTENANCE_CARDS[scope];
        return (
            `<details class="confirm"><summary><span class="btn btn-danger">${escapeHtml(card.button)}</span></summary>` +
            `<div class="confirm-panel">${note("warn", card.warning)}` +
            `<form method="post" action="/server/maintenance" class="form inline-form">` +
            `<input type="hidden" name="csrf" value="${escapeHtml(options.csrf)}">` +
            `<input type="hidden" name="scope" value="${scope}">` +
            `<input type="hidden" name="confirm" value="1">` +
            `<button type="submit" class="btn btn-danger" data-busy-label="Starting…"${running ? " disabled" : ""}>${escapeHtml(card.confirm)}</button>` +
            `</form></div></details>`
        );
    }).join("");
    const maintenanceCard =
        `<section class="card" id="maintenance"><h2>Docker maintenance${infoTip("Fixed prune commands for this Docker engine. Volumes are never removed and nothing runs on a schedule.")}</h2>` +
        `<p class="muted">Prune old Docker data on the engine this panel is connected to. Running and stopped containers keep their images; volumes are never removed. Each scope only removes data older than 7 days, and a run keeps running if you close the page.</p>` +
        status +
        forms +
        `</section>`;

    const body =
        `<p class="crumbs"><a href="/">← All stacks</a></p>` +
        `<div class="page-head"><h1>Server${infoTip("Only what Docker reports. Server load, uptime, filesystems and system updates are not shown.")}</h1></div>` +
        `<div class="server-toolbar" data-server-live data-server-stats="/server/stats" data-live-interval="15000">` +
        `<label class="live-toggle"><input type="checkbox" id="server-live"> Live (every 15 s)</label>` +
        `<span class="muted">Updated <time id="live-read-at" datetime="${escapeHtml(new Date(insights.readAt).toISOString())}" data-local-time="full">${escapeHtml(new Date(insights.readAt).toISOString().slice(0, 19).replace("T", " "))} UTC</time></span>` +
        `<span id="server-live-status" class="muted" role="status" aria-live="polite"></span>` +
        `<a class="btn btn-quiet" href="/server">Refresh</a>` +
        `</div>` +
        `<p class="lead">What runs on this Docker engine and what it uses.</p>` +
        (options.notice ? note("info", options.notice) : "") +
        insights.notes.map((text) => note("warn", text)).join("") +
        engineCard +
        topCard +
        stacksCard +
        attentionCard +
        diskSection +
        maintenanceCard;
    return documentHtml("Server", body, {
        logoutCsrf: options.csrf,
        access: options.access,
        timezone: options.timezone,
        scripts: ["/app.js"],
        nav: options.nav,
    });
}

/**
 * The dynamic zones of the Server page, rendered by the same functions as the
 * first render. A new column is therefore added once. A null section is a
 * collection failure: the browser keeps the last good rows instead of losing
 * data it already displayed. Counters are separate so an unavailable table
 * never makes the page look empty.
 */
export interface ServerLiveView {
    readAt: number;
    runningContainers: number | null;
    attentionCount: number | null;
    statsHtml: string | null;
    stacksHtml: string | null;
    attentionHtml: string | null;
    exitedHtml: string | null;
    exitedCount: number | null;
}

/**
 * `memoryTotalBytes` is the total already displayed by the page: the refresh
 * deliberately avoids `docker info`, and the stack memory bars must keep the
 * same scale. It only sizes a decorative bar and is never used for a decision.
 */
export function serverLiveView(insights: Insights, memoryTotalBytes: number | null): ServerLiveView {
    return {
        readAt: insights.readAt,
        runningContainers: insights.runningContainers,
        attentionCount: insights.attention === null ? null : insights.attention.length,
        statsHtml: serverStatsRows(insights.stats),
        stacksHtml: serverStackRows(insights.stacks, memoryTotalBytes),
        attentionHtml: serverAttentionRows(insights.attention),
        exitedHtml: serverExitedRows(insights.exited),
        exitedCount: insights.exited === null ? null : insights.exited.length,
    };
}
