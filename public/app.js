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
            // Unlock the actions; those that need a deployment stay locked
            // until a reload shows the new state.
            each("[data-op-button]", function (button) {
                if (!button.hasAttribute("data-needs-deployment")) button.disabled = false;
            });
        }
    }

    function wireLogs(section) {
        var url = section.getAttribute("data-logs-stream");
        var follow = document.getElementById("logs-follow");
        var stop = document.getElementById("logs-stop");
        var status = document.getElementById("logs-status");
        var output = document.getElementById("logs-output");
        var source = null;
        if (!url || typeof EventSource === "undefined") return;
        if (!follow || !stop || !output) return;
        follow.addEventListener("click", function () {
            var opened = false;
            if (source) return;
            output.textContent = "";
            setStatus("Connecting…");
            follow.disabled = true;
            stop.disabled = false;
            source = new EventSource(url);
            source.addEventListener("replay", function (e) {
                var payload = null;
                opened = true;
                try {
                    payload = JSON.parse(e.data);
                } catch { payload = null; }
                output.textContent = payload && typeof payload.text === "string" ? payload.text : "";
                output.scrollTop = output.scrollHeight;
                setStatus(payload && payload.truncated
                    ? "Following live. Older lines were dropped to stay within the size limit."
                    : "Following live.");
            });
            source.addEventListener("chunk", function (e) {
                try { appendText(output, JSON.parse(e.data).text, MAX_OUTPUT_CHARS); } catch { /* invalid frame */ }
            });
            source.addEventListener("end", function (e) {
                setStatus(e.data || "The log stream ended.");
                shutdown();
            });
            source.onerror = function () {
                if (source && source.readyState === 2) {
                    // CLOSED: the server refused the stream (not a dropped connection).
                    setStatus(opened
                        ? "The connection was closed. Click Follow logs to reconnect."
                        : "Could not start following logs. Reload the page: any problem with Docker or this stack is shown at the top.");
                    shutdown();
                    return;
                }
                setStatus("Connection lost. Reconnecting…");
            };
        });
        stop.addEventListener("click", function () {
            setStatus("Stopped following.");
            shutdown();
        });
        window.addEventListener("pagehide", shutdown);
        function setStatus(text) {
            if (status) status.textContent = text;
        }
        function shutdown() {
            if (source) {
                try { source.close(); } catch { /* ignore */ }
                source = null;
            }
            follow.disabled = false;
            stop.disabled = true;
        }
    }

    /* Show times in the reader's own time zone instead of UTC. */
    function localizeTimes() {
        each("time[data-local-time]", function (el) {
            var date = new Date(el.getAttribute("datetime"));
            if (isNaN(date.getTime())) return;
            el.textContent = el.getAttribute("data-local-time") === "full" ? date.toLocaleString() : date.toLocaleTimeString();
        });
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
            var hint = document.createElement("p");
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

    document.addEventListener("DOMContentLoaded", function () {
        var op = document.querySelector("[data-op-stream]");
        var logs = document.querySelector("[data-logs-stream]");
        var editor = document.querySelector("[data-edit-form]");
        localizeTimes();
        wireBusyButtons();
        wireAutoSubmit();
        if (op) wireOperation(op);
        if (logs) wireLogs(logs);
        if (editor) wireEditor(editor);
    });
})();
