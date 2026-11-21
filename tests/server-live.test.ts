import { describe, expect, test } from "bun:test";

/**
 * Focused browser-cycle check for the Server Live refresh in `public/app.js`:
 * activation -> immediate fetch -> DOM update -> scheduled fetch -> pause while
 * hidden -> resume -> deactivate -> stop on 401. A tiny in-memory DOM stands in
 * for the browser; there is no rendering engine and no full DOM suite here.
 */

class FakeNode {
    tagName: string;
    className = "";
    textContent = "";
    innerHTML = "";
    checked = false;
    children: FakeNode[] = [];
    private attributes = new Map<string, string>();
    private listeners = new Map<string, ((event?: unknown) => void)[]>();

    constructor(tagName = "div") {
        this.tagName = tagName;
    }

    get firstChild(): FakeNode | null {
        return this.children[0] ?? null;
    }

    appendChild(node: FakeNode): FakeNode {
        this.children.push(node);
        return node;
    }

    removeChild(node: FakeNode): FakeNode {
        const index = this.children.indexOf(node);
        if (index >= 0) this.children.splice(index, 1);
        return node;
    }

    setAttribute(name: string, value: string): void {
        this.attributes.set(name, value);
    }

    getAttribute(name: string): string | null {
        return this.attributes.get(name) ?? null;
    }

    removeAttribute(name: string): void {
        this.attributes.delete(name);
    }

    addEventListener(type: string, handler: (event?: unknown) => void): void {
        const list = this.listeners.get(type) ?? [];
        list.push(handler);
        this.listeners.set(type, list);
    }

    dispatch(type: string): void {
        for (const handler of [...(this.listeners.get(type) ?? [])]) handler();
    }
}

class FakeDocument {
    title = "";
    hidden = false;
    documentElement = new FakeNode("html");
    private byId = new Map<string, FakeNode>();
    private listeners = new Map<string, ((event?: unknown) => void)[]>();

    constructor(
        public readonly id: string,
        private readonly toolbar: FakeNode,
    ) {
        for (const elementId of [
            "server-live",
            "server-live-status",
            "live-running",
            "live-attention",
            "live-attention-rows",
            "live-exited",
            "live-exited-count",
            "live-exited-rows",
            "live-stats",
            "live-stacks",
            "live-read-at",
        ]) {
            this.byId.set(elementId, new FakeNode("div"));
        }
    }

    getElementById(id: string): FakeNode | null {
        return this.byId.get(id) ?? null;
    }

    querySelector(selector: string): FakeNode | null {
        return selector === "[data-server-live]" ? this.toolbar : null;
    }

    querySelectorAll(): FakeNode[] {
        return [];
    }

    createElementNS(_ns: string, tag: string): FakeNode {
        return new FakeNode(tag);
    }

    createElement(tag: string): FakeNode {
        return new FakeNode(tag);
    }

    addEventListener(type: string, handler: (event?: unknown) => void): void {
        const list = this.listeners.get(type) ?? [];
        list.push(handler);
        this.listeners.set(type, list);
    }

    dispatch(type: string): void {
        for (const handler of [...(this.listeners.get(type) ?? [])]) handler();
    }
}

const PAYLOAD = {
    readAt: Date.now(),
    runningContainers: 3,
    attentionCount: 1,
    statsHtml:
        `<tr><td><a href="/containers/${"a".repeat(64)}">web-1</a></td>` +
        `<td><a href="/stacks/web">web</a></td>` +
        `<td class="num">55.5%</td>` +
        `<td class="num"><span title="of 1 GiB">100 MiB</span><svg class="bar" aria-hidden="true"></svg></td>` +
        `<td class="num col-optional">9.8%</td>` +
        `<td class="col-optional"><code>1MB / 2MB</code></td>` +
        `<td class="col-optional"><code>0B / 0B</code></td>` +
        `<td class="num col-optional">5</td></tr>`,
    stacksHtml: `<tr><td><a href="/stacks/web">web</a></td><td class="num">55.5%</td><td class="num">100 MiB</td><td class="num">1</td></tr>`,
    attentionHtml: `<tr><td><a href="/containers/${"b".repeat(64)}">db-1</a></td><td><span class="state state-failed">Unhealthy</span></td><td><a href="/stacks/db">db</a></td></tr>`,
    exitedHtml: `<tr><td><a href="/containers/${"c".repeat(64)}">build-step-9</a></td><td><span class="muted">—</span></td></tr>`,
    exitedCount: 1,
    notes: [],
};

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("server live refresh (public/app.js)", () => {
    test("activation, DOM update, pause/resume, deactivation and stop on 401", async () => {
        const toolbar = new FakeNode("div");
        toolbar.setAttribute("data-server-stats", "/server/stats");
        toolbar.setAttribute("data-live-interval", "1000");
        const doc = new FakeDocument("cycle", toolbar);

        let calls = 0;
        let unauthorized = false;
        let payload: Record<string, unknown> = PAYLOAD;
        const urls: string[] = [];
        const fetchImpl = async (input?: unknown) => {
            calls += 1;
            urls.push(String(input));
            return unauthorized ? { status: 401, ok: false, json: async () => ({}) } : { status: 200, ok: true, json: async () => payload };
        };

        const scope = globalThis as unknown as Record<string, unknown>;
        const originals = ["document", "window", "fetch"].map((key) => [key, Object.getOwnPropertyDescriptor(scope, key)] as const);
        try {
            scope.document = doc;
            scope.window = { addEventListener() {} };
            scope.fetch = fetchImpl;

            // A variable specifier keeps TypeScript from resolving the browser
            // script as a typed module; it is a plain IIFE with no exports.
            const appSpecifier = ["..", "public", "app.js"].join("/");
            await import(appSpecifier);
            doc.dispatch("DOMContentLoaded");

            const toggle = doc.getElementById("server-live")!;
            const status = doc.getElementById("server-live-status")!;
            // The page echoes the total it displayed, so the stack bars keep
            // their scale without a docker info call on every refresh.
            doc.getElementById("live-stacks")!.setAttribute("data-mem-total", "8589934592");

            // Off by default: nothing is fetched.
            expect(calls).toBe(0);

            // Activation: one immediate fetch, then the dynamic zones are updated.
            toggle.checked = true;
            toggle.dispatch("change");
            await wait(20);
            expect(calls).toBe(1);
            expect(urls[0]).toBe("/server/stats?mem=8589934592");
            expect(doc.getElementById("live-running")!.textContent).toBe("3");
            // Zones are replaced by the exact server-rendered fragment, never
            // rebuilt in the browser: one renderer, one escaping boundary.
            expect(doc.getElementById("live-stats")!.innerHTML).toBe(PAYLOAD.statsHtml);
            expect(doc.getElementById("live-stacks")!.innerHTML).toBe(PAYLOAD.stacksHtml);
            expect(doc.getElementById("live-attention-rows")!.innerHTML).toBe(PAYLOAD.attentionHtml);
            // Stopped-with-an-error containers fill their own folded list.
            expect(doc.getElementById("live-exited-rows")!.innerHTML).toBe(PAYLOAD.exitedHtml);
            expect(doc.getElementById("live-exited-count")!.textContent).toBe("1");
            expect(doc.getElementById("live-exited")!.getAttribute("hidden")).toBeNull();
            const measuredAt = doc.getElementById("live-read-at")!.getAttribute("datetime");
            expect(measuredAt).toBe(new Date(PAYLOAD.readAt).toISOString());
            const fullStatus = status.textContent;
            expect(fullStatus.length).toBeGreaterThan(0);

            // Sequential scheduling: a second fetch happens after the interval.
            await wait(1200);
            expect(calls).toBe(2);

            // A transient stats failure keeps the last rows visible while the
            // counters that could still be read are updated. The rows are from
            // the earlier collection, so the page must not date them as fresh.
            payload = {
                ...PAYLOAD,
                readAt: PAYLOAD.readAt + 3_600_000,
                runningContainers: 4,
                statsHtml: null,
                stacksHtml: null,
                attentionHtml: null,
                exitedHtml: null,
                exitedCount: null,
            };
            await wait(1200);
            expect(calls).toBe(3);
            expect(doc.getElementById("live-running")!.textContent).toBe("4");
            expect(doc.getElementById("live-stats")!.innerHTML).toBe(PAYLOAD.statsHtml);
            expect(doc.getElementById("live-exited-count")!.textContent).toBe("1");
            expect(doc.getElementById("live-read-at")!.getAttribute("datetime")).toBe(measuredAt);
            const partialStatus = status.textContent;
            expect(partialStatus).not.toBe(fullStatus);

            // A repeated partial failure still does not move the measurement time.
            await wait(1200);
            expect(calls).toBe(4);
            expect(doc.getElementById("live-read-at")!.getAttribute("datetime")).toBe(measuredAt);

            // Hidden: polling pauses, no new request.
            doc.hidden = true;
            doc.dispatch("visibilitychange");
            const afterHide = calls;
            await wait(1200);
            expect(calls).toBe(afterHide);

            // Visible again: an immediate fetch resumes and a full collection
            // dates the measurements again.
            const freshReadAt = PAYLOAD.readAt + 7_200_000;
            payload = { ...PAYLOAD, readAt: freshReadAt };
            doc.hidden = false;
            doc.dispatch("visibilitychange");
            await wait(20);
            expect(calls).toBe(afterHide + 1);
            expect(doc.getElementById("live-read-at")!.getAttribute("datetime")).toBe(new Date(freshReadAt).toISOString());
            expect(status.textContent).not.toBe(partialStatus);

            // Deactivation stops the loop.
            toggle.checked = false;
            toggle.dispatch("change");
            const afterStop = calls;
            await wait(1200);
            expect(calls).toBe(afterStop);

            // Re-activate, then a 401 ends polling instead of retrying forever.
            toggle.checked = true;
            toggle.dispatch("change");
            await wait(20);
            unauthorized = true;
            await wait(1200);
            const afterAuth = calls;
            expect(toggle.checked).toBe(false);
            expect(status.textContent).toContain("Session ended");
            await wait(1200);
            expect(calls).toBe(afterAuth);
        } finally {
            // Browser fixtures share globals with the HTTP tests in this process.
            const toggle = doc.getElementById("server-live")!;
            toggle.checked = false;
            toggle.dispatch("change");
            for (const [key, descriptor] of originals) {
                if (descriptor) Object.defineProperty(scope, key, descriptor);
                else delete scope[key];
            }
        }

        for (const [key, descriptor] of originals) {
            expect(Object.getOwnPropertyDescriptor(scope, key)).toEqual(descriptor);
        }
    }, 15000);
});
