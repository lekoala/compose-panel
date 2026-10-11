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

    constructor(public readonly id: string, private readonly toolbar: FakeNode) {
        for (const elementId of ["server-live", "server-live-status", "live-running", "live-attention", "live-attention-rows", "live-stats", "live-stacks", "live-read-at"]) {
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
    stats: [{ id: "a".repeat(64), name: "web-1", cpuPercent: 55.5, memUsedBytes: 100 * 1024 ** 2, memLimitBytes: 1024 ** 3, memPercent: 9.8, netIo: "1MB / 2MB", blockIo: "0B / 0B", pids: 5, stack: "web", category: "managed" }],
    stacks: [{ stack: "web", cpuPercent: 55.5, memUsedBytes: 100 * 1024 ** 2, containers: 1 }],
    attention: [{ id: "b".repeat(64), name: "db-1", reason: "exited-nonzero", stack: "db" }],
    notes: [],
};

function wait(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

describe("server live refresh (public/app.js)", () => {
    test("activation, DOM update, pause/resume, deactivation and stop on 401", async () => {
        const toolbar = new FakeNode("div");
        toolbar.setAttribute("data-server-stats", "/server/stats");
        toolbar.setAttribute("data-live-interval", "1000");
        const doc = new FakeDocument("cycle", toolbar);

        let calls = 0;
        let unauthorized = false;
        const fetchImpl = async () => {
            calls += 1;
            return unauthorized
                ? { status: 401, ok: false, json: async () => ({}) }
                : { status: 200, ok: true, json: async () => PAYLOAD };
        };

        const scope = globalThis as unknown as Record<string, unknown>;
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

        // Off by default: nothing is fetched.
        expect(calls).toBe(0);

        // Activation: one immediate fetch, then the dynamic zones are updated.
        toggle.checked = true;
        toggle.dispatch("change");
        await wait(20);
        expect(calls).toBe(1);
        expect(doc.getElementById("live-running")!.textContent).toBe("3");
        expect(doc.getElementById("live-stats")!.children).toHaveLength(1);
        expect(doc.getElementById("live-attention-rows")!.children).toHaveLength(1);
        expect(status.textContent).toContain("updated");

        // Sequential scheduling: a second fetch happens after the interval.
        await wait(1200);
        expect(calls).toBe(2);

        // Hidden: polling pauses, no new request.
        doc.hidden = true;
        doc.dispatch("visibilitychange");
        const afterHide = calls;
        await wait(1200);
        expect(calls).toBe(afterHide);

        // Visible again: an immediate fetch resumes.
        doc.hidden = false;
        doc.dispatch("visibilitychange");
        await wait(20);
        expect(calls).toBe(afterHide + 1);

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
    }, 15000);
});
