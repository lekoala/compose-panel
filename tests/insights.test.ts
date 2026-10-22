import { describe, expect, test } from "bun:test";
import {
    INSIGHTS_INVALID,
    INSIGHTS_SLOW,
    INSIGHTS_UNAVAILABLE,
    InsightsParseError,
    attachStats,
    buildAttention,
    buildExited,
    buildStacks,
    createDiskUsageCache,
    exitCodeFromStatus,
    loadDiskUsage,
    loadInsights,
    parseDockerInfo,
    parseDockerStats,
    parseHumanBytes,
    parsePercent,
    parseSystemDf,
    statDisplayName,
} from "../src/insights.ts";
import type { ClassifiedContainer } from "../src/container-state.ts";
import type { ContainerInspector } from "../src/containers.ts";
import type { CommandResult } from "../src/docker.ts";

const ok = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: "", timedOut: false, truncated: false });

function container(overrides: Partial<ClassifiedContainer> = {}): ClassifiedContainer {
    return {
        id: "a".repeat(64),
        name: "demo-web-1",
        image: "nginx:alpine",
        state: "running",
        status: "Up 2 hours",
        health: null,
        createdAt: "",
        runningFor: "",
        ports: "",
        project: "demo",
        service: "web",
        configFiles: [],
        workingDir: null,
        category: "managed",
        stack: "demo",
        ...overrides,
    };
}

function fakeInspector(overrides: Partial<Record<"info" | "stats" | "diskUsage", () => Promise<CommandResult>>> = {}): ContainerInspector {
    const empty = async () => ok("");
    return {
        engine: "docker",
        list: empty,
        inspect: empty,
        logs: empty,
        info: overrides.info ?? (async () => ok("{}")),
        stats: overrides.stats ?? empty,
        diskUsage: overrides.diskUsage ?? empty,
    };
}

const INFO = JSON.stringify({
    OperatingSystem: "Ubuntu 22.04.5 LTS",
    OSType: "linux",
    Architecture: "aarch64",
    KernelVersion: "5.15.0-107-generic",
    ServerVersion: "27.3.1",
    NCPU: 4,
    MemTotal: 24_000_000_000,
    Containers: 6,
    ContainersRunning: 4,
    ContainersPaused: 0,
    ContainersStopped: 2,
    Images: 9,
    Driver: "overlay2",
});

function statsLine(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
        Container: "demo-web-1",
        Name: "demo-web-1",
        ID: "a".repeat(64),
        CPUPerc: "12.50%",
        MemUsage: "100MiB / 1GiB",
        MemPerc: "9.77%",
        NetIO: "1MB / 2MB",
        BlockIO: "0B / 0B",
        PIDs: "5",
        ...overrides,
    });
}

describe("parseHumanBytes", () => {
    test("handles decimal and binary units", () => {
        expect(parseHumanBytes("2.631GB")).toBe(2_631_000_000);
        expect(parseHumanBytes("100MiB")).toBe(100 * 1024 ** 2);
        expect(parseHumanBytes("0B")).toBe(0);
        expect(parseHumanBytes("1.5GiB")).toBe(1.5 * 1024 ** 3);
        expect(parseHumanBytes("512MB")).toBe(512_000_000);
    });

    test("returns null for unknown or empty values", () => {
        expect(parseHumanBytes("N/A")).toBeNull();
        expect(parseHumanBytes("")).toBeNull();
        expect(parseHumanBytes("12")).toBeNull();
        expect(parseHumanBytes("10XB")).toBeNull();
    });
});

describe("parsePercent", () => {
    test("parses percentages with and without the sign", () => {
        expect(parsePercent("12.34%")).toBe(12.34);
        expect(parsePercent("0%")).toBe(0);
        expect(parsePercent("150")).toBe(150);
        expect(parsePercent("")).toBeNull();
        expect(parsePercent("abc")).toBeNull();
    });
});

describe("parseDockerStats", () => {
    test("parses one JSON object per line and splits memory", () => {
        const parsed = parseDockerStats(`${statsLine()}\n`);
        expect(parsed).toHaveLength(1);
        expect(parsed[0]!.id).toBe("a".repeat(64));
        expect(parsed[0]!.cpuPercent).toBe(12.5);
        expect(parsed[0]!.memUsedBytes).toBe(100 * 1024 ** 2);
        expect(parsed[0]!.memLimitBytes).toBe(1024 ** 3);
        expect(parsed[0]!.pids).toBe(5);
    });

    test("takes the name from Name: with --no-trunc, Container is the full ID", () => {
        const parsed = parseDockerStats(statsLine({ Container: "a".repeat(64), Name: "onedev-server-1" }));
        expect(parsed[0]!.name).toBe("onedev-server-1");
    });

    test("falls back to the id when no name is reported", () => {
        const parsed = parseDockerStats(statsLine({ Container: "", Name: "" }));
        expect(parsed[0]!.name).toBe("a".repeat(12));
    });

    test("returns an empty list for empty output", () => {
        expect(parseDockerStats("")).toEqual([]);
    });

    test("throws on malformed output", () => {
        expect(() => parseDockerStats("not json")).toThrow(InsightsParseError);
        expect(() => parseDockerStats(JSON.stringify({ Container: "x" }))).toThrow(InsightsParseError);
    });
});

describe("parseSystemDf", () => {
    const line = (overrides: Record<string, unknown> = {}): string =>
        JSON.stringify({ Type: "Images", TotalCount: "9", Active: "4", Size: "8.2GB", Reclaimable: "3.1GB (37%)", ...overrides });

    test("parses lines and the reclaimable percentage suffix", () => {
        const parsed = parseSystemDf(`${line()}\n${line({ Type: "Build Cache", Size: "1.4GB", Reclaimable: "1.4GB (100%)" })}\n`);
        expect(parsed).toHaveLength(2);
        expect(parsed[0]!.size).toBe("8.2GB");
        expect(parsed[0]!.sizeBytes).toBe(8_200_000_000);
        expect(parsed[0]!.reclaimableBytes).toBe(3_100_000_000);
        expect(parsed[1]!.type).toBe("Build Cache");
    });

    test("returns an empty list for empty output and throws on garbage", () => {
        expect(parseSystemDf("")).toEqual([]);
        expect(() => parseSystemDf("nope")).toThrow(InsightsParseError);
    });
});

describe("parseDockerInfo", () => {
    test("projects only the whitelisted fields", () => {
        const info = parseDockerInfo(INFO);
        expect(info.cpus).toBe(4);
        expect(info.architecture).toBe("aarch64");
        expect(info.memoryTotalBytes).toBe(24_000_000_000);
        expect(info.containersRunning).toBe(4);
        expect(info.engineVersion).toBe("27.3.1");
    });

    test("never exposes sensitive fields present in the raw object", () => {
        const raw = JSON.stringify({
            OperatingSystem: "Ubuntu",
            RegistryConfig: { IndexConfigs: { secret: { Username: "leak" } } },
            HttpProxy: "http://proxy.internal",
            Env: ["AWS_SECRET_ACCESS_KEY=leak"],
        });
        const info = parseDockerInfo(raw);
        expect(Object.keys(info)).not.toContain("RegistryConfig");
        expect(JSON.stringify(info)).not.toContain("leak");
    });

    test("missing fields become null; invalid JSON throws", () => {
        const info = parseDockerInfo("{}");
        expect(info.cpus).toBeNull();
        expect(info.operatingSystem).toBeNull();
        expect(() => parseDockerInfo("not json")).toThrow(InsightsParseError);
        expect(() => parseDockerInfo("")).toThrow(InsightsParseError);
    });
});

describe("exitCodeFromStatus / buildAttention", () => {
    test("reads the exit code from the status text", () => {
        expect(exitCodeFromStatus("Exited (137) 5 minutes ago")).toBe(137);
        expect(exitCodeFromStatus("Exited (0) 2 hours ago")).toBe(0);
        expect(exitCodeFromStatus("Up 2 hours")).toBeNull();
    });

    const mixed = () => [
        container({ id: "1".repeat(64), name: "unhealthy", health: "unhealthy" }),
        container({ id: "2".repeat(64), name: "restarting", state: "restarting" }),
        container({ id: "3".repeat(64), name: "failed-job", state: "exited", status: "Exited (1) 5 minutes ago" }),
        container({ id: "4".repeat(64), name: "clean-job", state: "exited", status: "Exited (0) 5 minutes ago" }),
        container({ id: "5".repeat(64), name: "fine" }),
    ];

    test("attention is what is wrong now: unhealthy or restarting", () => {
        expect(buildAttention(mixed()).map((item) => item.name)).toEqual(["unhealthy", "restarting"]);
    });

    test("non-zero exits are listed apart, never as attention", () => {
        expect(buildExited(mixed()).map((item) => item.name)).toEqual(["failed-job"]);
    });
});

describe("statDisplayName", () => {
    const stat = (name: string, listName: string | null) => ({
        ...parseDockerStats(statsLine({ Container: "a".repeat(64), Name: name }))[0]!,
        container: listName === null ? null : container({ id: "a".repeat(64), name: listName }),
    });

    test("prefers the container list name, then Docker stats, never a full ID", () => {
        expect(statDisplayName(stat("a".repeat(64), "web-1"))).toBe("web-1");
        expect(statDisplayName(stat("stats-name", null))).toBe("stats-name");
        expect(statDisplayName(stat("a".repeat(64), null))).toBe("a".repeat(12));
    });
});

describe("attachStats / buildStacks", () => {
    const containers = [
        container({ id: "a".repeat(64), name: "demo-web-1", category: "managed", stack: "demo" }),
        container({ id: "b".repeat(64), name: "watchtower", category: "external", stack: null, project: "watchtower" }),
    ];

    test("joins stats with their container, leaving unknown ones unattached", () => {
        const stats = parseDockerStats(
            [
                statsLine(),
                statsLine({ ID: "b".repeat(64), Container: "watchtower", CPUPerc: "40%", MemUsage: "50MiB / 1GiB" }),
                statsLine({ ID: "c".repeat(64), Container: "ghost", CPUPerc: "5%", MemUsage: "1MiB / 1GiB" }),
            ].join("\n"),
        );
        const attached = attachStats(containers, stats);
        expect(attached.map((stat) => stat.container?.name ?? null)).toEqual(["demo-web-1", "watchtower", null]);
    });

    test("aggregates only managed stacks and sorts by CPU", () => {
        const stats = parseDockerStats(
            [
                statsLine({ ID: "a".repeat(64), CPUPerc: "12.5%", MemUsage: "100MiB / 1GiB" }),
                statsLine({ ID: "b".repeat(64), Container: "watchtower", CPUPerc: "40%", MemUsage: "50MiB / 1GiB" }),
            ].join("\n"),
        );
        const stacks = buildStacks(containers, stats);
        expect(stacks).toEqual([{ stack: "demo", cpuPercent: 12.5, memUsedBytes: 100 * 1024 ** 2, containers: 1 }]);
    });

    test("returns null attribution when the container list is unavailable", () => {
        expect(buildStacks(null, parseDockerStats(statsLine()))).toBeNull();
    });
});

describe("loadInsights", () => {
    test("reads info and stats independently", async () => {
        const inspector = fakeInspector({
            info: async () => ok(INFO),
            stats: async () => ok(statsLine()),
        });
        const insights = await loadInsights(inspector, [container()]);
        expect(insights.info?.cpus).toBe(4);
        expect(insights.stats).toHaveLength(1);
        expect(insights.stacks).toEqual([{ stack: "demo", cpuPercent: 12.5, memUsedBytes: 100 * 1024 ** 2, containers: 1 }]);
        expect(insights.attention).toEqual([]);
        expect(insights.notes).toEqual([]);
    });

    test("keeps info when stats fails, and reports a note", async () => {
        const inspector = fakeInspector({
            info: async () => ok(INFO),
            stats: async () => ({ ...ok(""), code: 1 }),
        });
        const insights = await loadInsights(inspector, [container()]);
        expect(insights.info?.cpus).toBe(4);
        expect(insights.stats).toBeNull();
        expect(insights.stacks).toBeNull();
        expect(insights.attention).toEqual([]);
        expect(insights.notes).toEqual([INSIGHTS_UNAVAILABLE]);
    });

    test("keeps stats when info fails", async () => {
        const inspector = fakeInspector({
            info: async () => ({ ...ok(""), timedOut: true }),
            stats: async () => ok(statsLine()),
        });
        const insights = await loadInsights(inspector, [container()]);
        expect(insights.info).toBeNull();
        expect(insights.stats).toHaveLength(1);
        expect(insights.notes).toEqual([INSIGHTS_SLOW]);
    });

    test("deduplicates notes when both collections fail the same way", async () => {
        const inspector = fakeInspector({
            info: async () => ({ ...ok(""), code: 1 }),
            stats: async () => ({ ...ok(""), code: 1 }),
        });
        const insights = await loadInsights(inspector, null);
        expect(insights.notes).toEqual([INSIGHTS_UNAVAILABLE]);
    });

    test("reports invalid output as a note, not zero", async () => {
        const inspector = fakeInspector({
            info: async () => ok("not json"),
            stats: async () => ok("not json"),
        });
        const insights = await loadInsights(inspector, [container()]);
        expect(insights.info).toBeNull();
        expect(insights.stats).toBeNull();
        expect(insights.notes).toEqual([INSIGHTS_INVALID]);
    });

    test("attention is null when the container list could not be read", async () => {
        const inspector = fakeInspector({ stats: async () => ok(statsLine()) });
        const insights = await loadInsights(inspector, null);
        expect(insights.attention).toBeNull();
        expect(insights.stacks).toBeNull();
        if (insights.stats === null) throw new Error("stats should be present");
        expect(insights.stats[0]!.container).toBeNull();
    });
});

describe("loadDiskUsage / cache", () => {
    const df = JSON.stringify({ Type: "Images", TotalCount: "9", Active: "4", Size: "8.2GB", Reclaimable: "3.1GB (37%)" });

    test("reads on demand and reports a note on failure", async () => {
        const good = fakeInspector({ diskUsage: async () => ok(df) });
        expect((await loadDiskUsage(good)).rows).toHaveLength(1);

        const bad = fakeInspector({ diskUsage: async () => ({ ...ok(""), code: 1 }) });
        const failed = await loadDiskUsage(bad);
        expect(failed.rows).toBeNull();
        expect(failed.note).toBe(INSIGHTS_UNAVAILABLE);
    });

    test("serves from cache within the TTL and rereads after it", async () => {
        let calls = 0;
        const inspector = fakeInspector({
            diskUsage: async () => {
                calls += 1;
                return ok(df);
            },
        });
        const cache = createDiskUsageCache();
        await cache.read(inspector, 1000, 300_000);
        await cache.read(inspector, 2000, 300_000);
        expect(calls).toBe(1);
        await cache.read(inspector, 1000 + 300_001, 300_000);
        expect(calls).toBe(2);
    });

    test("does not cache a failure, so a later attempt retries", async () => {
        let calls = 0;
        const inspector = fakeInspector({
            diskUsage: async () => {
                calls += 1;
                return { ...ok(""), code: 1 };
            },
        });
        const cache = createDiskUsageCache();
        await cache.read(inspector, 0, 300_000);
        await cache.read(inspector, 1, 300_000);
        expect(calls).toBe(2);
    });
});
