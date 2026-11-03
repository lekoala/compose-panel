import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";

class FakeElement {
    className = "";
    hidden = false;
    disabled = false;
    scrollTop = 0;
    scrollHeight = 0;
    events: Record<string, (event?: { data: string }) => void> = {};
    children: FakeElement[] = [];
    private text = "";
    get textContent(): string {
        return this.text + this.children.map((child) => child.textContent).join("");
    }
    set textContent(value: string) {
        this.text = value;
        this.children = [];
    }
    get firstChild(): FakeElement | null {
        return this.children[0] ?? null;
    }
    appendChild(child: FakeElement): void {
        this.children.push(child);
    }
    removeChild(child: FakeElement): void {
        this.children = this.children.filter((item) => item !== child);
    }
    addEventListener(name: string, handler: (event?: { data: string }) => void): void {
        this.events[name] = handler;
    }
}

function fakeElement(): FakeElement {
    return new FakeElement();
}

/** Load public/app.js in a fresh context with a minimal DOM. */
async function loadApp(timezone: string | null = null): Promise<{
    elements: Map<string, FakeElement>;
    streams: { events: Record<string, (event: { data: string }) => void> }[];
}> {
    const elements = new Map<string, FakeElement>();
    for (const id of ["op-status", "op-meta", "op-output", "op-live-note", "logs-follow", "logs-stop", "logs-status", "logs-output"]) {
        elements.set(id, fakeElement());
    }
    const streams: { events: Record<string, (event: { data: string }) => void> }[] = [];
    class FakeEventSource {
        events: Record<string, (event: { data: string }) => void> = {};
        constructor() {
            streams.push(this);
        }
        addEventListener(name: string, handler: (event: { data: string }) => void) {
            this.events[name] = handler;
        }
        close() {}
    }
    const operation = { getAttribute: (name: string) => (name === "data-op-status" ? "running" : "/operations/events") };
    const logs = { getAttribute: () => "/logs/events" };
    let ready!: () => void;
    runInNewContext(await Bun.file(new URL("../public/app.js", import.meta.url)).text(), {
        EventSource: FakeEventSource,
        window: { matchMedia: () => ({ matches: false }), addEventListener() {} },
        document: {
            documentElement: { getAttribute: (name: string) => (name === "data-timezone" ? timezone : null) },
            getElementById: (id: string) => elements.get(id) ?? null,
            createElement: () => new FakeElement(),
            querySelector: (selector: string) =>
                selector === "[data-op-stream]" ? operation : selector === "[data-logs-stream]" ? logs : null,
            addEventListener: (_name: string, handler: () => void) => {
                ready = handler;
            },
        },
    });
    ready();
    return { elements, streams };
}

test("browser preserves operation and log fragments exactly", async () => {
    const { elements, streams } = await loadApp();
    elements.get("logs-follow")!.events.click!();
    for (const text of ["hel", "lo\r", "\né🙂\n"]) {
        streams[0]!.events.output!({ data: JSON.stringify({ text }) });
        streams[1]!.events.chunk!({ data: JSON.stringify({ text }) });
    }
    expect(elements.get("op-output")!.textContent).toBe("hello\r\né🙂\n");
    expect(elements.get("logs-output")!.textContent).toBe("hello\r\né🙂\n");
});

test("log timestamps are rewritten in the configured zone", async () => {
    const { elements, streams } = await loadApp("Europe/Brussels");
    elements.get("logs-follow")!.events.click!();
    // The timestamp is deliberately split across two SSE frames.
    streams[1]!.events.chunk!({ data: JSON.stringify({ text: "web-1  | 2026-10-10T12:34:5" }) });
    streams[1]!.events.chunk!({ data: JSON.stringify({ text: "6.789Z hello\n" }) });
    expect(elements.get("logs-output")!.textContent).toBe("web-1  | 2026-10-10 14:34:56 hello\n");
});

test("the reader's own zone is used when no zone is configured", async () => {
    const { elements, streams } = await loadApp();
    elements.get("logs-follow")!.events.click!();
    const stamp = "2026-10-10T12:34:56.789Z";
    const expected = new Intl.DateTimeFormat("sv-SE", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
    }).format(new Date(stamp));
    streams[1]!.events.chunk!({ data: JSON.stringify({ text: "svc  | " + stamp + " hi\n" }) });
    expect(elements.get("logs-output")!.textContent).toBe("svc  | " + expected + " hi\n");
});

test("log lines become rows with the prefix apart and repeated prefixes muted", async () => {
    const { elements, streams } = await loadApp("UTC");
    elements.get("logs-follow")!.events.click!();
    const text = [
        "onedev  | 2026-11-03T15:48:53.1Z Exception in thread",
        "onedev  | 2026-11-03T15:48:53.2Z   at org.example.Main.run(Main.java:1)",
        "db-1    | 2026-11-03T15:48:53.3Z ready",
        "no prefix at all",
        "",
    ].join("\n");
    streams[1]!.events.chunk!({ data: JSON.stringify({ text }) });
    const rows = elements.get("logs-output")!.children;
    expect(rows.map((row) => row.children.map((part) => part.className))).toEqual([
        ["log-prefix", "log-message", "log-eol"],
        ["log-prefix log-same", "log-message", "log-eol"],
        ["log-prefix", "log-message", "log-eol"],
        ["log-message", "log-eol"],
    ]);
    expect(rows[1]!.children[1]!.textContent).toBe("  at org.example.Main.run(Main.java:1)");
});

test("trimming old log rows keeps the first visible prefix shown", async () => {
    const { elements, streams } = await loadApp("UTC");
    elements.get("logs-follow")!.events.click!();
    const line = `web-1  | 2026-11-03T15:48:53Z ${"x".repeat(1024)}\n`;
    streams[1]!.events.chunk!({ data: JSON.stringify({ text: line.repeat(300) }) });
    const output = elements.get("logs-output")!;
    expect(output.textContent.length).toBeLessThanOrEqual(256 * 1024);
    expect(output.children.length).toBeLessThan(300);
    expect(output.children[0]!.children[0]!.className).toBe("log-prefix");
    expect(output.children[1]!.children[0]!.className).toBe("log-prefix log-same");
});
