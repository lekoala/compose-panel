import { escapeHtml, documentHtml, htmlResponse } from "./html.ts";
import { listStacks, readStackCompose, resolveRoot, StackError } from "./stacks.ts";

const rawRoot = process.env.STACKS_DIR;
if (!rawRoot) throw new Error("STACKS_DIR is required (absolute path to the stacks).");
const root = await resolveRoot(rawRoot);
const port = Number(process.env.PORT ?? "5081");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT.");

function routeError(error: unknown): Response {
    const status = error instanceof StackError ? error.status : 500;
    if (!(error instanceof StackError)) console.error("Internal error", error);
    const message = error instanceof StackError ? error.message : "Internal error.";
    return htmlResponse(documentHtml("Error", `<h1>Error</h1><p>${escapeHtml(message)}</p><p><a href="/">Back</a></p>`), status);
}

// IMPORTANT: hardcoded loopback bind. Authentication does not exist yet.
const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(request) {
        const url = new URL(request.url);
        if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET" } });
        if (url.pathname === "/health/live") {
            return new Response("ok", { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
        }
        if (url.pathname === "/styles.css") {
            return new Response(Bun.file(new URL("../public/style.css", import.meta.url)), {
                headers: { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
            });
        }
        try {
            if (url.pathname === "/") {
                const stacks = await listStacks(root);
                const rows = stacks.length
                    ? stacks.map(stack => `<li><a href="/stacks/${encodeURIComponent(stack.name)}">${escapeHtml(stack.name)}</a><small>${escapeHtml(stack.composeFile)}</small></li>`).join("")
                    : `<li>No recognized Compose stack.</li>`;
                return htmlResponse(documentHtml("Stacks", `<h1>Stacks</h1><p>Read-only — no Docker command is executed.</p><ul class="stack-list">${rows}</ul>`));
            }
            const match = /^\/stacks\/([^/]+)$/.exec(url.pathname);
            if (match) {
                let name: string;
                try { name = decodeURIComponent(match[1]!); }
                catch { throw new StackError("Invalid name encoding."); }
                const stack = await readStackCompose(root, name);
                return htmlResponse(documentHtml(stack.name,
                    `<p><a href="/">← All stacks</a></p><h1>${escapeHtml(stack.name)}</h1><p>${escapeHtml(stack.filename)} · read-only</p><pre>${escapeHtml(stack.source)}</pre>`));
            }
            return htmlResponse(documentHtml("Not found", "<h1>Page not found</h1>"), 404);
        } catch (error) {
            return routeError(error);
        }
    },
});
console.info(`Compose Panel (read-only, local only) on http://127.0.0.1:${server.port}`);
