import { describe, expect, test } from "bun:test";
import type { CommandResult, DockerRunner } from "../src/docker.ts";
import { HostMaintenance, MaintenanceDisabledError } from "../src/host-maintenance.ts";
import { MaintenanceBusyError, StackLocks } from "../src/locks.ts";
import { MAINTENANCE_MIN_AGE_FILTER, isMaintenanceScope, maintenanceArgv, parseReclaimedBytes } from "../src/maintenance.ts";

const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "", timedOut: false, truncated: false });

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
    const started = Date.now();
    while (!predicate()) {
        if (Date.now() - started > timeoutMs) throw new Error("condition not reached");
        await Bun.sleep(5);
    }
}

function manager(runner: DockerRunner, locks = new StackLocks(), maxBytes = 1024) {
    return { maintenance: new HostMaintenance(locks, runner, { timeoutMs: 1000, maxBytes }), locks };
}

describe("maintenance argument arrays", () => {
    test("every scope is a fixed Docker argument array with a one-week floor", () => {
        expect(maintenanceArgv("build-cache")).toEqual(["builder", "prune", "-f", "--filter", MAINTENANCE_MIN_AGE_FILTER]);
        expect(maintenanceArgv("dangling-images")).toEqual(["image", "prune", "-f", "--filter", MAINTENANCE_MIN_AGE_FILTER]);
        expect(maintenanceArgv("unused-images")).toEqual(["image", "prune", "-a", "-f", "--filter", MAINTENANCE_MIN_AGE_FILTER]);
    });

    test("no scope can remove volumes, containers or networks", () => {
        for (const scope of ["build-cache", "dangling-images", "unused-images"] as const) {
            const argv = maintenanceArgv(scope).join(" ");
            expect(argv).not.toContain("system");
            expect(argv).not.toContain("volume");
            expect(argv).not.toContain("container");
            expect(argv).not.toContain("network");
        }
    });

    test("unknown scopes are refused by name", () => {
        expect(isMaintenanceScope("unused-images")).toBe(true);
        expect(isMaintenanceScope("all")).toBe(false);
        expect(isMaintenanceScope("images --volumes")).toBe(false);
        expect(isMaintenanceScope("")).toBe(false);
    });
});

describe("reclaimed size parsing", () => {
    test("reads Docker's summary line", () => {
        // Docker prints decimal units: 1.5GB is 1.5 billion bytes, not 1.5 GiB.
        expect(parseReclaimedBytes("Deleted Images:\nfoo\n\nTotal reclaimed space: 1.5GB\n")).toBe(1_500_000_000);
        expect(parseReclaimedBytes("Total reclaimed space: 0B")).toBe(0);
        expect(parseReclaimedBytes("Total reclaimed space: 640.5MB")).toBe(640_500_000);
        expect(parseReclaimedBytes("Total reclaimed space: 2.5MiB")).toBe(Math.round(2.5 * 1024 ** 2));
    });

    test("an absent or unusable line is null, never zero", () => {
        expect(parseReclaimedBytes("")).toBeNull();
        expect(parseReclaimedBytes("Total reclaimed space: a lot")).toBeNull();
        expect(parseReclaimedBytes("Total reclaimed space: 12XB")).toBeNull();
    });
});

describe("host maintenance", () => {
    test("runs the fixed command and reports the outcome", async () => {
        const calls: string[][] = [];
        const finished: string[] = [];
        const locks = new StackLocks();
        const maintenance = new HostMaintenance(
            locks,
            async (args) => {
                calls.push(args);
                return ok("Deleted build cache objects\n\nTotal reclaimed space: 2.5MB\n");
            },
            { timeoutMs: 1000, maxBytes: 1024, onFinish: (view) => finished.push(view.status) },
        );

        const started = maintenance.start("build-cache");
        expect(started.status).toBe("running");
        await waitFor(() => maintenance.last()?.status !== "running");

        expect(calls).toEqual([maintenanceArgv("build-cache")]);
        const view = maintenance.last()!;
        expect(view.status).toBe("succeeded");
        expect(view.exitCode).toBe(0);
        expect(view.reclaimedBytes).toBe(2_500_000);
        expect(view.output).toContain("Total reclaimed space");
        expect(finished).toEqual(["succeeded"]);
        // The engine lock is released after a confirmed exit.
        expect(locks.hasActive()).toBe(false);
    });

    test("pins the build cache to the local default builder", async () => {
        let env: Record<string, string> | undefined;
        const { maintenance } = manager(async (_args, options) => {
            env = options?.env;
            return ok();
        });
        maintenance.start("build-cache");
        await waitFor(() => maintenance.last()?.status !== "running");
        // A remote Buildx builder must never be selected by the inherited
        // environment; the default builder is the local docker driver.
        expect(env?.BUILDX_BUILDER).toBe("default");
    });

    test("a failing command is reported as failed, without inventing a size", async () => {
        const { maintenance } = manager(async () => ({
            code: 1,
            stdout: "",
            stderr: "permission denied",
            timedOut: false,
            truncated: false,
        }));
        maintenance.start("dangling-images");
        await waitFor(() => maintenance.last()?.status !== "running");
        expect(maintenance.last()!.status).toBe("failed");
        expect(maintenance.last()!.exitCode).toBe(1);
        expect(maintenance.last()!.reclaimedBytes).toBeNull();
        expect(maintenance.last()!.output).toContain("permission denied");
    });

    test("a timeout is unknown, never success or failure", async () => {
        const { maintenance, locks } = manager(async () => ({
            code: 0,
            stdout: "Total reclaimed space: 1MB",
            stderr: "",
            timedOut: true,
            truncated: false,
        }));
        maintenance.start("unused-images");
        await waitFor(() => maintenance.last()?.status !== "running");
        expect(maintenance.last()!.status).toBe("unknown");
        expect(locks.hasActive()).toBe(false);
    });

    test("an unconfirmed exit keeps the engine lock and reports unknown", async () => {
        const { maintenance, locks } = manager(async () => ({
            code: 0,
            stdout: "",
            stderr: "",
            timedOut: false,
            truncated: false,
            terminationUnconfirmed: true,
        }));
        maintenance.start("unused-images");
        await waitFor(() => maintenance.last()?.status !== "running");
        expect(maintenance.last()!.status).toBe("unknown");
        expect(locks.maintenanceActive()).toBe(true);
        expect(() => maintenance.start("build-cache")).toThrow(MaintenanceBusyError);
    });

    test("one maintenance run at a time", async () => {
        let release: (() => void) | null = null;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const { maintenance } = manager(async () => {
            await gate;
            return ok();
        });
        maintenance.start("build-cache");
        expect(() => maintenance.start("dangling-images")).toThrow(MaintenanceBusyError);
        release!();
        await waitFor(() => maintenance.last()?.status !== "running");
    });

    test("a stack lock blocks maintenance, and maintenance blocks stack locks", async () => {
        const locks = new StackLocks();
        const { maintenance } = manager(async () => {
            await Bun.sleep(20);
            return ok();
        }, locks);

        const releaseStack = locks.tryAcquire("demo")!;
        expect(() => maintenance.start("build-cache")).toThrow(MaintenanceBusyError);
        releaseStack();

        maintenance.start("build-cache");
        expect(locks.tryAcquire("demo")).toBeNull();
        await expect(locks.run("demo", async () => undefined)).rejects.toBeInstanceOf(MaintenanceBusyError);
        expect(locks.hasActive()).toBe(true);
        await waitFor(() => maintenance.last()?.status !== "running");
        expect(locks.tryAcquire("demo")).not.toBeNull();
    });

    test("output is capped and marked truncated", async () => {
        const { maintenance } = manager(async () => ok("x".repeat(5000)), new StackLocks(), 128);
        maintenance.start("build-cache");
        await waitFor(() => maintenance.last()?.status !== "running");
        const view = maintenance.last()!;
        expect(view.truncated).toBe(true);
        expect(Buffer.byteLength(view.output, "utf8")).toBeLessThanOrEqual(128);
    });

    test("shutdown refuses new runs and waits for the current one", async () => {
        const { maintenance } = manager(async () => {
            await Bun.sleep(25);
            return ok();
        });
        maintenance.start("build-cache");
        await maintenance.shutdown(1000);
        expect(maintenance.last()!.status).toBe("succeeded");
        expect(() => maintenance.start("build-cache")).toThrow(MaintenanceDisabledError);
    });
});
