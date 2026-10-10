import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";

test("browser preserves operation and log fragments exactly", async () => {
    const elements = new Map<string, { textContent: string; hidden: boolean; disabled: boolean; scrollTop: number; scrollHeight: number; events: Record<string, () => void>; addEventListener: (name: string, handler: () => void) => void }>();
    for (const id of ["op-status", "op-meta", "op-output", "op-live-note", "logs-follow", "logs-stop", "logs-status", "logs-output"]) {
        const events: Record<string, () => void> = {};
        elements.set(id, { textContent: "", hidden: false, disabled: false, scrollTop: 0, scrollHeight: 0, events, addEventListener: (name, handler) => { events[name] = handler; } });
    }
    const streams: { events: Record<string, (event: { data: string }) => void> }[] = [];
    class FakeEventSource {
        events: Record<string, (event: { data: string }) => void> = {};
        constructor() { streams.push(this); }
        addEventListener(name: string, handler: (event: { data: string }) => void) { this.events[name] = handler; }
        close() {}
    }
    const operation = { getAttribute: (name: string) => name === "data-op-status" ? "running" : "/operations/events" };
    const logs = { getAttribute: () => "/logs/events" };
    let ready!: () => void;
    runInNewContext(await Bun.file(new URL("../public/app.js", import.meta.url)).text(), {
        EventSource: FakeEventSource,
        window: { matchMedia: () => ({ matches: false }), addEventListener() {} },
        document: {
            getElementById: (id: string) => elements.get(id) ?? null,
            querySelector: (selector: string) => selector === "[data-op-stream]" ? operation : logs,
            addEventListener: (_name: string, handler: () => void) => { ready = handler; },
        },
    });
    ready();
    elements.get("logs-follow")!.events.click!();
    for (const text of ["hel", "lo\r", "\né🙂\n"]) {
        streams[0]!.events.output!({ data: JSON.stringify({ text }) });
        streams[1]!.events.chunk!({ data: JSON.stringify({ text }) });
    }
    expect(elements.get("op-output")!.textContent).toBe("hello\r\né🙂\n");
    expect(elements.get("logs-output")!.textContent).toBe("hello\r\né🙂\n");
});
