import { expect, test } from "bun:test";
import { serverLiveView, serverPage } from "../src/features/server/views.ts";
import type { ClassifiedStat, EngineInfo, Insights } from "../src/insights.ts";

const INFO: EngineInfo = {
    operatingSystem: "Linux",
    osType: "linux",
    architecture: "x86_64",
    kernelVersion: "6.8.0",
    engineVersion: "27.0.0",
    cpus: 4,
    memoryTotalBytes: 8 * 1024 ** 3,
    containers: 3,
    containersRunning: 1,
    containersPaused: 0,
    containersStopped: 2,
    images: 5,
    driver: "overlay2",
};

function stat(overrides: Partial<ClassifiedStat> = {}): ClassifiedStat {
    return {
        id: "a".repeat(64),
        name: "web-1",
        cpuPercent: 12.5,
        memUsedBytes: 1024 ** 2,
        memLimitBytes: 1024 ** 3,
        memPercent: 1,
        netIo: "1B / 2B",
        blockIo: "0B / 0B",
        pids: 3,
        container: null,
        ...overrides,
    };
}

function insights(overrides: Partial<Insights> = {}): Insights {
    return {
        info: INFO,
        stats: [stat()],
        stacks: [{ stack: "web", cpuPercent: 12.5, memUsedBytes: 1024 ** 2, containers: 1 }],
        attention: [],
        exited: [],
        runningContainers: 1,
        notes: [],
        readAt: 1_700_000_000_000,
        ...overrides,
    };
}

/** The tbody content, which is exactly what the Live refresh replaces. */
function tbody(html: string, id: string): string {
    const match = new RegExp(`<tbody id="${id}"[^>]*>([\\s\\S]*?)</tbody>`).exec(html);
    if (!match) throw new Error(`tbody ${id} not found`);
    return match[1]!;
}

test("the first render and the live refresh share their rows", () => {
    const view = insights();
    const page = serverPage({ csrf: "token", insights: view, disk: null, maintenance: { last: null } });
    const live = serverLiveView(view, INFO.memoryTotalBytes);
    expect(tbody(page, "live-stats")).toBe(live.statsHtml!);
    expect(tbody(page, "live-stacks")).toBe(live.stacksHtml!);
    expect(tbody(page, "live-attention-rows")).toBe(live.attentionHtml!);
    expect(tbody(page, "live-exited-rows")).toBe(live.exitedHtml!);
});

test("live fragments escape container, stack and attention names", () => {
    const hostile = '<img src=x onerror="alert(1)">';
    const view = insights({
        stats: [stat({ name: hostile })],
        stacks: [{ stack: hostile, cpuPercent: 1, memUsedBytes: 1, containers: 1 }],
        attention: [{ id: "b".repeat(64), name: hostile, reason: "unhealthy", stack: hostile }],
        exited: [],
    });
    const live = serverLiveView(view, null);
    const markup = [live.statsHtml, live.stacksHtml, live.attentionHtml].join("");
    expect(markup).not.toContain("<img");
    expect(markup).toContain("&lt;img");
});

test("an unavailable section stays null so the browser keeps the last rows", () => {
    const live = serverLiveView(insights({ stats: null, stacks: null, attention: null, exited: null, runningContainers: null }), null);
    expect(live.statsHtml).toBeNull();
    expect(live.stacksHtml).toBeNull();
    expect(live.attentionHtml).toBeNull();
    expect(live.exitedHtml).toBeNull();
    expect(live.exitedCount).toBeNull();
    expect(live.attentionCount).toBeNull();
    expect(live.runningContainers).toBeNull();
});

test("an empty section renders its empty-state row, never a missing zone", () => {
    const live = serverLiveView(insights({ stats: [], stacks: [], attention: [], exited: [] }), null);
    // Structural, not copy: one row whose single cell covers every column.
    expect(live.statsHtml).toMatch(/^<tr><td colspan="8" class="muted">[^<]*<\/td><\/tr>$/);
    expect(live.stacksHtml).toMatch(/^<tr><td colspan="4" class="muted">[^<]*<\/td><\/tr>$/);
    expect(live.attentionHtml).toMatch(/^<tr><td colspan="3" class="muted">[^<]*<\/td><\/tr>$/);
    expect(live.exitedHtml).toBe("");
    expect(live.exitedCount).toBe(0);
    expect(live.attentionCount).toBe(0);
});
