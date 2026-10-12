/* Compose Panel live updates: operation output, log follow over SSE, and small
 * form conveniences. Vanilla JS only, progressive enhancement: every page works
 * without it. All server text is inserted via textContent, never HTML. */
(function () {
    "use strict";

    var MAX_OUTPUT_CHARS = 256 * 1024;

    /* Append text and keep the view pinned to the end only if the reader was
     * already there, so scrolling up to read earlier lines is not interrupted. */
    function appendText(pre, text, maxChars) {
        var distance = pre.scrollHeight - pre.scrollTop - pre.clientHeight;
        var stick = !(distance > 24);
        pre.textContent += text;
        if (pre.textContent.length > maxChars) {
            pre.textContent = pre.textContent.slice(pre.textContent.length - maxChars);
        }
        if (stick) pre.scrollTop = pre.scrollHeight;
    }

    function each(selector, fn) {
        if (typeof document.querySelectorAll !== "function") return;
        Array.prototype.forEach.call(document.querySelectorAll(selector), fn);
    }

    var FAVICON_IDLE = "/favicon.svg";
    var BASE_TITLE = document.title;

    /* Fixed display zone from COMPOSE_PANEL_TIMEZONE (data-timezone on <html>).
     * Empty means the reader's own browser zone. Stored times stay UTC; this is
     * presentation only. */
    var ZONE = (document.documentElement && document.documentElement.getAttribute("data-timezone")) || "";
    var zoneFormatters = null;

    function formatters() {
        var dateOpts, timeOpts;
        if (!zoneFormatters) {
            dateOpts = { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false };
            timeOpts = { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false };
            if (ZONE) { dateOpts.timeZone = ZONE; timeOpts.timeZone = ZONE; }
            zoneFormatters = {
                dateTime: new Intl.DateTimeFormat("sv-SE", dateOpts),
                time: new Intl.DateTimeFormat("sv-SE", timeOpts),
            };
        }
        return zoneFormatters;
    }

    /* Docker emits RFC3339 UTC timestamps in every log line; rewrite each to the
     * display zone. Unknown patterns are left untouched. */
    var LOG_TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
    function localizeLogText(text) {
        var dateTime = formatters().dateTime;
        return text.replace(LOG_TIMESTAMP, function (stamp) {
            var date = new Date(stamp);
            return isNaN(date.getTime()) ? stamp : dateTime.format(date);
        });
    }

    function activeIcon() {
        var dark = false;
        try {
            dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
        } catch { /* keep the light variant */ }
        return dark ? "/icon-active-on-dark.svg" : "/icon-active-on-light.svg";
    }

    /* Swap the tab icon while an operation runs. Firefox animates the SVG;
     * other browsers show its first frame, so the title also gets a marker. */
    function setBusy(busy) {
        var link = document.getElementById("favicon-svg");
        if (link) link.setAttribute("href", busy ? activeIcon() : FAVICON_IDLE);
        document.title = busy ? "● " + BASE_TITLE : BASE_TITLE;
    }

    var STATUS_LABELS = { running: "Running", succeeded: "Succeeded", failed: "Failed", unknown: "Outcome unknown" };

    function duration(ms) {
        var s = Math.max(0, Math.round(ms / 1000));
        return s < 60 ? s + " s" : Math.floor(s / 60) + " min " + (s % 60) + " s";
    }

    /* Keep in sync with operationDetails() in src/html.ts. */
    function details(snap) {
        var parts = [];
        if (typeof snap.endedAt === "number" && typeof snap.startedAt === "number") parts.push("took " + duration(snap.endedAt - snap.startedAt));
        if (snap.exitCode !== null && snap.exitCode !== undefined) parts.push("exit code " + snap.exitCode);
        if (snap.timedOut) parts.push("stopped at the time limit — check the services to see what actually happened");
        if (snap.truncated) parts.push("output shortened (only the most recent part is kept)");
        return parts.join(" · ");
    }

    function wireOperation(section) {
        var url = section.getAttribute("data-op-stream");
        var status = document.getElementById("op-status");
        var meta = document.getElementById("op-meta");
        var output = document.getElementById("op-output");
        var note = document.getElementById("op-live-note");
        var refresh = document.getElementById("op-refresh");
        var busyNote = document.getElementById("op-busy-note");
        var initialStatus = section.getAttribute("data-op-status");
        var source = null;
        var open = true;
        if (!url || typeof EventSource === "undefined") return;
        if (!status || !output) return;
        if (initialStatus !== "running") return; // Historical output is already rendered.
        if (note) note.hidden = false;
        setBusy(true);
        source = new EventSource(url);
        source.addEventListener("snapshot", function (e) {
            var snap = null;
            try {
                snap = JSON.parse(e.data);
                if (typeof snap.output === "string") output.textContent = snap.output;
                renderStatus(snap);
            } catch { /* keep the server-rendered content */ }
        });
        source.addEventListener("output", function (e) {
            try { appendText(output, JSON.parse(e.data).text, MAX_OUTPUT_CHARS); } catch { /* invalid frame */ }
        });
        source.addEventListener("done", function (e) {
            try { renderStatus(JSON.parse(e.data)); } catch { /* ignore */ }
            finish();
        });
        source.onerror = function () {
            // EventSource retries on its own; the server also times out idle streams.
            // No 401 handling here (EventSource never exposes the status): an
            // expired session closes the stream server-side at the next
            // heartbeat, which surfaces as an error and a retry that stays
            // unauthenticated until the reader signs in again.
        };
        function renderStatus(snap) {
            var state = snap.status || "unknown";
            var text;
            status.textContent = STATUS_LABELS[state] || state;
            status.className = "state state-" + state;
            if (meta) {
                text = details(snap);
                meta.textContent = text ? " · " + text : "";
            }
            if (state !== "running") finish();
        }
        function finish() {
            if (!open) return;
            open = false;
            try { source.close(); } catch { /* ignore */ }
            setBusy(false);
            if (note) note.hidden = true;
            if (busyNote) busyNote.hidden = true;
            if (refresh) refresh.hidden = false;
            // Unlock the actions; those blocked by the stack state stay locked
            // until a reload shows the new state.
            each("[data-op-button]", function (button) {
                if (!button.hasAttribute("data-state-locked")) button.disabled = false;
            });
        }
    }

    function wireLogs(section) {
        var snapshot = section.getAttribute("data-logs-snapshot");
        var url = section.getAttribute("data-logs-stream");
        var service = document.getElementById("logs-service");
        var tail = document.getElementById("logs-tail");
        var refresh = document.getElementById("logs-refresh");
        var follow = document.getElementById("logs-follow");
        var stop = document.getElementById("logs-stop");
        var status = document.getElementById("logs-status");
        var output = document.getElementById("logs-output");
        var source = null;
        var carry = "";
        if (!url || typeof EventSource === "undefined") return;
        if (!follow || !stop || !output) return;

        function setStatus(text) {
            if (status) status.textContent = text;
        }

        /* Current selection, as the server validates it (ADR 0020). */
        function selection() {
            var params = [];
            if (service && service.value) params.push("service=" + encodeURIComponent(service.value));
            if (tail && tail.value) params.push("tail=" + encodeURIComponent(tail.value));
            return params.length > 0 ? "?" + params.join("&") : "";
        }

        /* History: the last lines, one bounded request, no process left running. */
        function loadSnapshot() {
            if (!snapshot || typeof fetch !== "function") return;
            setStatus("Loading recent lines…");
            fetch(snapshot + selection(), { headers: { "Accept": "text/plain" } })
                .then(function (response) { return response.text(); })
                .then(function (text) {
                    if (source) return;
                    output.textContent = localizeLogText(text);
                    output.scrollTop = output.scrollHeight;
                    setStatus("Not following.");
                })
                .catch(function () {
                    if (source) return;
                    setStatus("Could not read the logs. Reload the page to try again.");
                });
        }

        function shutdown(reloadSnapshot) {
            if (carry) {
                appendText(output, localizeLogText(carry), MAX_OUTPUT_CHARS);
                carry = "";
            }
            if (source) {
                try { source.close(); } catch { /* ignore */ }
                source = null;
            }
            follow.disabled = false;
            if (refresh) refresh.disabled = false;
            stop.disabled = true;
            if (reloadSnapshot) loadSnapshot();
        }

        function openFollow() {
            var opened = false;
            if (source) return;
            output.textContent = "";
            setStatus("Connecting…");
            follow.disabled = true;
            if (refresh) refresh.disabled = true;
            stop.disabled = false;
            source = new EventSource(url + selection());
            source.addEventListener("replay", function (e) {
                var payload = null;
                opened = true;
                try {
                    payload = JSON.parse(e.data);
                } catch { payload = null; }
                carry = "";
                output.textContent = payload && typeof payload.text === "string" ? localizeLogText(payload.text) : "";
                output.scrollTop = output.scrollHeight;
                setStatus(payload && payload.truncated
                    ? "Following live. Older lines were dropped to stay within the size limit."
                    : "Following live.");
            });
            source.addEventListener("chunk", function (e) {
                // Buffer partial lines so a timestamp split across SSE frames is
                // reassembled and localized only once.
                var incoming;
                var newline;
                try { incoming = JSON.parse(e.data).text; } catch { return; }
                if (typeof incoming !== "string") return;
                carry += incoming;
                newline = carry.lastIndexOf("\n");
                if (newline >= 0) {
                    appendText(output, localizeLogText(carry.slice(0, newline + 1)), MAX_OUTPUT_CHARS);
                    carry = carry.slice(newline + 1);
                }
            });
            source.addEventListener("end", function (e) {
                setStatus(e.data || "The log stream ended.");
                shutdown(false);
            });
            source.onerror = function () {
                if (source && source.readyState === 2) {
                    // CLOSED: the server refused the stream (not a dropped connection).
                    setStatus(opened
                        ? "The connection was closed. Click Follow live to reconnect."
                        : "Could not start following logs. Reload the page: any problem with Docker or this stack is shown at the top.");
                    shutdown(false);
                    return;
                }
                setStatus("Connection lost. Reconnecting…");
            };
        }

        follow.addEventListener("click", openFollow);
        if (refresh) refresh.addEventListener("click", function () { if (!source) loadSnapshot(); });
        stop.addEventListener("click", function () {
            setStatus("Stopped following.");
            shutdown(false);
        });
        /* A new selection applies to the next read: stop the current follow
         * rather than mixing selections in one stream. */
        function reselect() {
            if (source) {
                setStatus("Selection changed. Follow live again for the new selection.");
                shutdown(false);
            }
        }
        if (service) service.addEventListener("change", reselect);
        if (tail) tail.addEventListener("change", reselect);
        window.addEventListener("pagehide", function () { shutdown(false); });
        // Show history on open, without starting a permanent follow.
        loadSnapshot();
    }

    /* Read-only log snapshot for one container: a single bounded fetch, re-run
     * on demand. There is no follow and no action on the container. */
    function wireContainerLogs(section) {
        var url = section.getAttribute("data-container-logs");
        var output = document.getElementById("container-logs-output");
        var status = document.getElementById("container-logs-status");
        var refresh = document.getElementById("container-logs-refresh");
        if (!url || !output || typeof fetch !== "function") return;
        function load() {
            if (status) status.textContent = "Loading recent lines…";
            fetch(url, { headers: { "Accept": "text/plain" } })
                .then(function (response) { return response.text(); })
                .then(function (text) {
                    output.textContent = localizeLogText(text);
                    output.scrollTop = output.scrollHeight;
                    if (status) status.textContent = "Read only: the panel never follows or restarts this container.";
                })
                .catch(function () {
                    if (status) status.textContent = "Could not read the logs. Reload the page to try again.";
                });
        }
        if (refresh) refresh.addEventListener("click", load);
        load();
    }

    /* Show times in the panel's display zone (or the reader's own) instead of UTC. */
    function localizeTime(el) {
        var date = new Date(el.getAttribute("datetime"));
        if (isNaN(date.getTime())) return;
        var format = formatters();
        el.textContent = el.getAttribute("data-local-time") === "full" ? format.dateTime.format(date) : format.time.format(date);
    }

    function localizeTimes() {
        each("time[data-local-time]", localizeTime);
    }

    /* Mark the clicked button as busy and block a double submit. */
    function wireBusyButtons() {
        each("form", function (form) {
            var button = form.querySelector("button[data-busy-label]");
            if (!button) return;
            form.addEventListener("submit", function () {
                // Defer so the browser still submits the form normally.
                setTimeout(function () {
                    button.disabled = true;
                    button.textContent = button.getAttribute("data-busy-label");
                }, 0);
            });
        });
    }

    /* Warn before leaving the editor with unsaved changes; Ctrl/Cmd+S saves. */
    function wireEditor(form) {
        var dirty = false;
        var submitting = false;
        var hint;
        form.addEventListener("input", function () { dirty = true; });
        form.addEventListener("submit", function () { submitting = true; });
        window.addEventListener("beforeunload", function (e) {
            if (dirty && !submitting) {
                e.preventDefault();
                e.returnValue = "";
            }
        });
        form.addEventListener("keydown", function (e) {
            if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
                e.preventDefault();
                if (typeof form.requestSubmit === "function") form.requestSubmit();
            }
        });
        Array.prototype.forEach.call(form.querySelectorAll("textarea[data-code]"), wireIndent);
        Array.prototype.forEach.call(form.querySelectorAll("textarea[data-sensitive]"), maskSensitive);
        var actions = form.querySelector(".form-actions");
        if (actions) {
            hint = document.createElement("p");
            hint.className = "muted keys";
            hint.textContent = "Tab indents. Press Esc, then Tab, to leave a field. Ctrl+S (⌘S) saves.";
            actions.parentNode.insertBefore(hint, actions.nextSibling);
        }
    }

    /* Tab inserts two spaces (YAML forbids tab indentation). Esc releases the
     * next Tab so keyboard users can still leave the field. */
    function wireIndent(area) {
        var release = false;
        area.addEventListener("keydown", function (e) {
            if (e.key === "Escape") { release = true; return; }
            if (e.key !== "Tab" || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || release) {
                if (e.key !== "Shift") release = false;
                return;
            }
            e.preventDefault();
            // execCommand keeps the browser's undo history; fall back if unsupported.
            if (!document.execCommand || !document.execCommand("insertText", false, "  ")) {
                area.setRangeText("  ", area.selectionStart, area.selectionEnd, "end");
                area.dispatchEvent(new Event("input", { bubbles: true }));
            }
        });
        area.addEventListener("blur", function () { release = false; });
    }

    /* Hide secret values until asked, e.g. when the screen is shared. The field
     * is only hidden, not removed, so the form still submits it unchanged. */
    function maskSensitive(area) {
        if (!area.value) return;
        var lines = area.value.split("\n").filter(function (line) { return line.trim() !== ""; }).length;
        var button = document.createElement("button");
        button.type = "button";
        button.className = "btn reveal";
        button.textContent = "Show values (" + lines + " line" + (lines === 1 ? "" : "s") + ")";
        area.hidden = true;
        area.parentNode.insertBefore(button, area);
        button.addEventListener("click", function () {
            area.hidden = false;
            button.remove();
            area.focus();
        });
    }

    /* Navigation drawer: the sidebar renders closed everywhere. On wide
     * screens it is opened (the toggle is hidden there by CSS); on small
     * screens it stays a native <details> disclosure opening as an overlay,
     * with Escape and outside-tap dismissal as enhancement. Without
     * JavaScript the menu stays usable, collapsed into its toggle. */
    function wireNavDrawer() {
        var sidebar = document.querySelector("details.sidebar");
        if (!sidebar) return;
        var mobile = null;
        try {
            mobile = window.matchMedia("(max-width: 52rem)");
        } catch { mobile = null; }
        if (!mobile) return;
        function syncNavigation() {
            sidebar.open = !mobile.matches;
        }
        if (typeof mobile.addEventListener === "function") mobile.addEventListener("change", syncNavigation);
        else if (typeof mobile.addListener === "function") mobile.addListener(syncNavigation);
        syncNavigation();
        // Dismissal only applies where the toggle exists: on desktop the
        // menu has no visible way to reopen once closed.
        document.addEventListener("keydown", function (e) {
            if (e.key !== "Escape" || !mobile.matches || !sidebar.open) return;
            sidebar.open = false;
        });
        document.addEventListener("click", function (e) {
            if (!mobile.matches || !sidebar.open) return;
            if (sidebar.contains(e.target)) return;
            sidebar.open = false;
        });
    }

    // Runs immediately (this script is deferred, so the DOM is parsed):
    // wide screens must not flash a closed sidebar.
    wireNavDrawer();

    /* Local filter for the navigation stack list and the stacks table. Hides
     * non-matching entries; without JavaScript every entry is simply shown. */
    function wireNavSearch() {
        var input = document.querySelector("[data-nav-search]");
        var list = document.getElementById("nav-list");
        var empty = document.getElementById("nav-empty");
        if (!input) return;
        var items = list ? Array.prototype.slice.call(list.querySelectorAll("li")) : [];
        var rows = [];
        each("tbody tr a.stack-name", function (link) {
            var row = link.closest ? link.closest("tr") : null;
            if (row) rows.push(row);
        });
        function apply() {
            var query = input.value.trim().toLowerCase();
            var shown = 0;
            items.forEach(function (item) {
                var match = query === "" || item.textContent.toLowerCase().indexOf(query) !== -1;
                item.hidden = !match;
                if (match) shown += 1;
            });
            if (empty) empty.hidden = query === "" || shown !== 0;
            rows.forEach(function (row) {
                var name = (row.querySelector("a.stack-name") || row).textContent.toLowerCase();
                row.hidden = query !== "" && name.indexOf(query) === -1;
            });
        }
        input.addEventListener("input", apply);
        input.addEventListener("search", apply);
    }

    /* A select marked data-auto-submit submits its form on change; the
     * fallback button is only needed without JavaScript. */
    function wireAutoSubmit() {
        each("select[data-auto-submit]", function (select) {
            var form = select.form;
            if (!form) return;
            var fallback = form.querySelector("[data-auto-submit-fallback]");
            if (fallback) fallback.hidden = true;
            select.addEventListener("change", function () { form.submit(); });
        });
    }

    /* Live refresh of the Server page. Only the dynamic zones rendered by the
     * server are rebuilt from a bounded JSON endpoint; the static engine facts
     * and the Docker disk-usage snapshot are never touched. Sequential
     * setTimeout (not setInterval) so a slow read cannot overlap the next one,
     * paused while the tab is hidden, aborted on disable or page hide. No
     * history is kept; every value is inserted via textContent, never HTML. */
    var SERVER_CATEGORY = { managed: "Managed", external: "External Compose", standalone: "Standalone" };
    var SERVER_ISSUE = { "unhealthy": "Unhealthy", "restarting": "Restarting", "exited-nonzero": "Exited with an error" };

    function element(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = text;
        return node;
    }

    function anchor(href, text) {
        var link = element("a");
        link.href = href;
        link.textContent = text;
        return link;
    }

    function codeCell(text) {
        var td = element("td");
        td.appendChild(element("code", null, text));
        return td;
    }

    function emptyRow(columns, text) {
        var td = element("td", "muted", text);
        td.setAttribute("colspan", String(columns));
        var row = element("tr");
        row.appendChild(td);
        return row;
    }

    function setRows(tbody, nodes) {
        while (tbody.firstChild) tbody.removeChild(tbody.firstChild);
        Array.prototype.forEach.call(nodes, function (node) { tbody.appendChild(node); });
    }

    function formatBytesValue(bytes) {
        if (bytes === null || bytes === undefined || !isFinite(bytes)) return "—";
        if (bytes < 1024) return Math.round(bytes) + " B";
        var units = ["KiB", "MiB", "GiB", "TiB", "PiB"];
        var value = bytes / 1024, unit = 0;
        while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
        return (value >= 10 ? Math.round(value) : value.toFixed(1)) + " " + units[unit];
    }

    function formatPercentValue(value) {
        if (value === null || value === undefined || !isFinite(value)) return "—";
        return Math.round(value * 10) / 10 + "%";
    }

    function stackCell(stat) {
        if (!stat.category) return element("span", "muted", "Unattributed");
        if (stat.stack) return anchor("/stacks/" + encodeURIComponent(stat.stack), stat.stack);
        return element("span", "muted", SERVER_CATEGORY[stat.category] || stat.category);
    }

    function statRow(stat) {
        var row = element("tr");
        var nameCell = element("td");
        nameCell.appendChild(anchor("/containers/" + encodeURIComponent(stat.id), stat.name || (stat.id ? stat.id.slice(0, 12) : "—")));
        row.appendChild(nameCell);
        var stackTd = element("td");
        stackTd.appendChild(stackCell(stat));
        row.appendChild(stackTd);
        row.appendChild(element("td", null, formatPercentValue(stat.cpuPercent)));
        var memory = (stat.memUsedBytes === null || stat.memUsedBytes === undefined)
            ? "—"
            : (stat.memLimitBytes === null || stat.memLimitBytes === undefined
                ? formatBytesValue(stat.memUsedBytes)
                : formatBytesValue(stat.memUsedBytes) + " / " + formatBytesValue(stat.memLimitBytes));
        row.appendChild(element("td", null, memory));
        row.appendChild(element("td", null, formatPercentValue(stat.memPercent)));
        row.appendChild(codeCell(stat.netIo || "—"));
        row.appendChild(codeCell(stat.blockIo || "—"));
        row.appendChild(element("td", null, stat.pids === null || stat.pids === undefined ? "—" : String(stat.pids)));
        return row;
    }

    function stackRow(usage) {
        var row = element("tr");
        var stackTd = element("td");
        stackTd.appendChild(anchor("/stacks/" + encodeURIComponent(usage.stack), usage.stack));
        row.appendChild(stackTd);
        row.appendChild(element("td", null, formatPercentValue(usage.cpuPercent)));
        row.appendChild(element("td", null, formatBytesValue(usage.memUsedBytes)));
        row.appendChild(element("td", null, String(usage.containers)));
        return row;
    }

    function attentionRow(item) {
        var row = element("tr");
        var nameTd = element("td");
        nameTd.appendChild(anchor("/containers/" + encodeURIComponent(item.id), item.name));
        row.appendChild(nameTd);
        var issueTd = element("td");
        issueTd.appendChild(element("span", "state " + (item.reason === "unhealthy" ? "state-failed" : "state-stopped"), SERVER_ISSUE[item.reason] || item.reason));
        row.appendChild(issueTd);
        var stackTd = element("td");
        if (item.stack) stackTd.appendChild(anchor("/stacks/" + encodeURIComponent(item.stack), item.stack));
        else stackTd.appendChild(element("span", "muted", "—"));
        row.appendChild(stackTd);
        return row;
    }

    function applyServer(payload) {
        if (payload.runningContainers !== null && payload.runningContainers !== undefined) {
            const running = document.getElementById("live-running");
            if (running) running.textContent = String(payload.runningContainers);
        }
        if (payload.attention !== null && payload.attention !== undefined) {
            const attentionCount = document.getElementById("live-attention");
            if (attentionCount) attentionCount.textContent = String(payload.attention.length);
            const attentionBody = document.getElementById("live-attention-rows");
            if (attentionBody) {
                setRows(attentionBody, payload.attention.length > 0 ? payload.attention.map(attentionRow) : [emptyRow(3, "No current issues.")]);
            }
        }
        if (payload.stats !== null && payload.stats !== undefined) {
            const statsBody = document.getElementById("live-stats");
            if (statsBody) {
                const sorted = payload.stats.slice().sort(function (a, b) {
                    return (b.cpuPercent === null ? -1 : b.cpuPercent) - (a.cpuPercent === null ? -1 : a.cpuPercent);
                });
                setRows(statsBody, sorted.length > 0 ? sorted.map(statRow) : [emptyRow(8, "No running containers.")]);
            }
        }
        if (payload.stacks !== null && payload.stacks !== undefined) {
            const stacksBody = document.getElementById("live-stacks");
            if (stacksBody) {
                setRows(stacksBody, payload.stacks.length > 0 ? payload.stacks.map(stackRow) : [emptyRow(4, "No managed running containers.")]);
            }
        }
        const timeEl = document.getElementById("live-read-at");
        if (payload.readAt && timeEl) {
            timeEl.setAttribute("datetime", new Date(payload.readAt).toISOString());
            localizeTime(timeEl);
        }
    }

    function wireServerLive(section) {
        var url = section.getAttribute("data-server-stats");
        var toggle = document.getElementById("server-live");
        var status = document.getElementById("server-live-status");
        if (!url || !toggle || typeof fetch !== "function") return;
        var interval = parseInt(section.getAttribute("data-live-interval"), 10);
        if (!isFinite(interval) || interval < 1000) interval = 15000;
        var enabled = false, timer = null, controller = null, lastSuccess = "";

        function setStatus(text) { if (status) status.textContent = text; }
        function clearTimer() { if (timer) { clearTimeout(timer); timer = null; } }
        function abortInFlight() { if (controller) { try { controller.abort(); } catch (e) { /* ignore */ } controller = null; } }
        function stop() { enabled = false; clearTimer(); abortInFlight(); }

        function schedule() {
            clearTimer();
            if (!enabled || document.hidden) return;
            timer = setTimeout(tick, interval);
        }

        function tick() {
            if (!enabled || document.hidden) return;
            controller = new AbortController();
            fetch(url, { headers: { "Accept": "application/json" }, signal: controller.signal })
                .then(function (response) {
                    if (response.status === 401) {
                        // The session ended: stop instead of polling forever.
                        stop();
                        toggle.checked = false;
                        setStatus("Session ended. Reload the page to sign in again.");
                        return null;
                    }
                    if (!response.ok) throw new Error("status " + response.status);
                    return response.json();
                })
                .then(function (payload) {
                    if (!payload) return;
                    applyServer(payload);
                    lastSuccess = new Date().toLocaleTimeString();
                    setStatus("Live · updated " + lastSuccess);
                    schedule();
                })
                .catch(function (error) {
                    if (error && error.name === "AbortError") return;
                    // Keep the last successful values visible, clearly marked as old.
                    setStatus(lastSuccess
                        ? "Live update failed · last successful refresh " + lastSuccess
                        : "Live update failed.");
                    schedule();
                });
        }

        toggle.addEventListener("change", function () {
            if (toggle.checked) { enabled = true; tick(); }
            else { stop(); setStatus("Manual refresh"); }
        });
        document.addEventListener("visibilitychange", function () {
            if (document.hidden) { clearTimer(); abortInFlight(); }
            else if (enabled) { tick(); }
        });
        window.addEventListener("pagehide", stop);
    }

    /* Self-update (ADR 0018): the panel goes away while its container is
     * recreated. Poll the health probe and reload once it answers again after
     * an outage, or after a while if it never went down (the updater is still
     * verifying, or it refused). Without JS, reload the page by hand. */
    function wireSelfUpdateWait() {
        var startedAt = Date.now();
        var wentDown = false;
        function tick() {
            fetch("/health/live", { cache: "no-store" })
                .then(function (response) {
                    if (!response.ok) throw new Error("status " + response.status);
                    if (wentDown || Date.now() - startedAt > 20000) { window.location.reload(); return; }
                    setTimeout(tick, 2000);
                })
                .catch(function () {
                    wentDown = true;
                    setTimeout(tick, 2000);
                });
        }
        setTimeout(tick, 2000);
    }

    document.addEventListener("DOMContentLoaded", function () {
        var op = document.querySelector("[data-op-stream]");
        var logs = document.querySelector("[data-logs-stream]");
        var containerLogs = document.querySelector("[data-container-logs]");
        var editor = document.querySelector("[data-edit-form]");
        var serverLive = document.querySelector("[data-server-live]");
        localizeTimes();
        wireBusyButtons();
        wireAutoSubmit();
        wireNavSearch();
        if (op) wireOperation(op);
        if (logs) wireLogs(logs);
        if (containerLogs) wireContainerLogs(containerLogs);
        if (editor) wireEditor(editor);
        if (serverLive) wireServerLive(serverLive);
        if (document.querySelector("[data-self-update-wait]")) wireSelfUpdateWait();
    });
})();
