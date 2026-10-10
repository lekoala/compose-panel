/* Compose Panel live updates: operation output and log follow over SSE.
 * Vanilla JS only. All server text is inserted via textContent, never HTML. */
(function () {
    "use strict";

    function appendText(pre, text, maxChars) {
        pre.textContent += text;
        if (pre.textContent.length > maxChars) {
            pre.textContent = pre.textContent.slice(pre.textContent.length - maxChars);
        }
        pre.scrollTop = pre.scrollHeight;
    }

    var FAVICON_IDLE = "/favicon.svg";

    function activeIcon() {
        var dark = false;
        try {
            dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
        } catch { /* keep the light variant */ }
        return dark ? "/icon-active-on-dark.svg" : "/icon-active-on-light.svg";
    }

    /* Swap the tab icon while an operation runs. Firefox animates the SVG;
     * other browsers show its first frame — still a distinct busy signal. */
    function setFavicon(href) {
        var link = document.getElementById("favicon-svg");
        if (link) link.setAttribute("href", href);
    }

    function wireOperation(section) {
        var url = section.getAttribute("data-op-stream");
        var status = document.getElementById("op-status");
        var meta = document.getElementById("op-meta");
        var output = document.getElementById("op-output");
        var note = document.getElementById("op-live-note");
        var initialStatus = section.getAttribute("data-op-status");
        var source = null;
        var open = true;
        if (!url || typeof EventSource === "undefined") return;
        if (!status || !output) return;
        if (initialStatus !== "running") return; // Historical output is already rendered.
        if (note) note.hidden = false;
        setFavicon(activeIcon());
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
            appendText(output, e.data + "\n", 256 * 1024);
        });
        source.addEventListener("done", function (e) {
            try { renderStatus(JSON.parse(e.data)); } catch { /* ignore */ }
            close();
        });
        source.onerror = function () {
            // EventSource retries on its own; the server also times out idle streams.
        };
        function renderStatus(snap) {
            var parts = [];
            status.textContent = snap.status || "unknown";
            status.className = "state state-" + (snap.status || "unknown");
            if (meta) {
                if (snap.exitCode !== null && snap.exitCode !== undefined) parts.push("exit " + snap.exitCode);
                if (snap.timedOut) parts.push("timed out (outcome unknown)");
                if (snap.truncated) parts.push("output truncated");
                meta.textContent = parts.length ? " · " + parts.join(" · ") : "";
            }
            if (snap.status && snap.status !== "running") close();
        }
        function close() {
            if (!open) return;
            open = false;
            try { source.close(); } catch { /* ignore */ }
            setFavicon(FAVICON_IDLE);
            if (note) note.hidden = true;
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
            if (source) return;
            output.textContent = "";
            setStatus("Following…");
            follow.disabled = true;
            stop.disabled = false;
            source = new EventSource(url);
            source.addEventListener("replay", function (e) {
                var payload = null;
                try {
                    payload = JSON.parse(e.data);
                } catch { payload = null; }
                output.textContent = payload && typeof payload.text === "string" ? payload.text : "";
                if (payload && payload.truncated) setStatus("Following… (earlier entries truncated)");
            });
            source.addEventListener("chunk", function (e) {
                appendText(output, e.data + "\n", 256 * 1024);
            });
            source.addEventListener("end", function (e) {
                setStatus(e.data || "Follow ended.");
                shutdown();
            });
            source.onerror = function () {
                setStatus("Connection lost — retrying…");
            };
        });
        stop.addEventListener("click", function () {
            setStatus("Stopped.");
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

    document.addEventListener("DOMContentLoaded", function () {
        var op = document.querySelector("[data-op-stream]");
        if (op) wireOperation(op);
        var logs = document.querySelector("[data-logs-stream]");
        if (logs) wireLogs(logs);
    });
})();
