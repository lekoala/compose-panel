import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AuditError, AuditLog } from "../src/audit.ts";

async function tempDir(): Promise<string> {
    return mkdtemp(join(tmpdir(), "compose-panel-audit-"));
}

const DAY = 24 * 60 * 60 * 1000;

describe("AuditLog", () => {
    test("appends NDJSON and reads it back in order", async () => {
        const dir = await tempDir();
        try {
            let now = Date.parse("2024-03-01T10:00:00.000Z");
            const audit = new AuditLog({ dir, now: () => now });
            await audit.record({ event: "login", result: "failure", actor: "direct", username: "bob" });
            now += 1000;
            await audit.record({ event: "login", result: "success", actor: "direct" });

            const entries = await audit.readPeriod("2024-03-01");
            expect(entries.length).toBe(2);
            expect(entries[0]!.event).toBe("login");
            expect(entries[0]!.result).toBe("failure");
            expect(entries[0]!.username).toBe("bob");
            expect(entries[1]!.result).toBe("success");
            expect(entries[0]!.ts).toBe("2024-03-01T10:00:00.000Z");

            const raw = await readFile(join(dir, "2024-03-01.log"), "utf8");
            expect(raw.endsWith("\n")).toBe(true);
            expect(raw.trim().split("\n").length).toBe(2);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test("rotates by day and prunes to retainFiles", async () => {
        const dir = await tempDir();
        try {
            let now = Date.parse("2024-03-01T00:00:00.000Z");
            const audit = new AuditLog({ dir, retainFiles: 2, now: () => now });
            await audit.record({ event: "login", result: "success" });
            now += DAY;
            await audit.record({ event: "login", result: "success" });
            now += DAY;
            await audit.record({ event: "login", result: "success" });

            const periods = await audit.listPeriods();
            expect(periods).toEqual(["2024-03-03", "2024-03-02"]);
            expect(existsSync(join(dir, "2024-03-01.log"))).toBe(false);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test("supports monthly rotation", async () => {
        const dir = await tempDir();
        try {
            let now = Date.parse("2024-01-15T00:00:00.000Z");
            const audit = new AuditLog({ dir, rotation: "month", now: () => now });
            await audit.record({ event: "login", result: "success" });
            now = Date.parse("2024-02-15T00:00:00.000Z");
            await audit.record({ event: "login", result: "success" });
            expect(await audit.listPeriods()).toEqual(["2024-02", "2024-01"]);
            expect((await audit.readPeriod("2024-02")).length).toBe(1);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test("bounds the read to the most recent lines", async () => {
        const dir = await tempDir();
        try {
            const audit = new AuditLog({ dir, maxReadLines: 3, now: () => Date.parse("2024-03-01T00:00:00.000Z") });
            for (let i = 0; i < 10; i += 1) await audit.record({ event: "s", result: "r", detail: `n${i}` });
            const entries = await audit.readPeriod("2024-03-01");
            expect(entries.map((entry) => entry.detail)).toEqual(["n7", "n8", "n9"]);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test("skips malformed lines instead of failing", async () => {
        const dir = await tempDir();
        try {
            await writeFile(
                join(dir, "2024-03-01.log"),
                `${JSON.stringify({ ts: "2024-03-01T00:00:00.000Z", event: "ok", result: "success" })}\nnot json\n`,
            );
            const audit = new AuditLog({ dir });
            const entries = await audit.readPeriod("2024-03-01");
            expect(entries.length).toBe(1);
            expect(entries[0]!.event).toBe("ok");
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test("strips newlines and truncates oversized fields", async () => {
        const dir = await tempDir();
        try {
            const audit = new AuditLog({ dir, now: () => Date.parse("2024-03-01T00:00:00.000Z") });
            await audit.record({ event: "login", result: "failure", detail: "a\nb\r\nc", stack: "x".repeat(1000) });
            const entries = await audit.readPeriod("2024-03-01");
            expect(entries[0]!.detail).toBe("a b c");
            expect(entries[0]!.stack!.length).toBeLessThan(1000);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test("refuses to write through a symlinked log file", async () => {
        const dir = await tempDir();
        try {
            const target = join(dir, "target.txt");
            await writeFile(target, "original");
            try {
                await symlink(target, join(dir, "2024-03-01.log"));
            } catch (error) {
                // Windows without developer mode cannot create symlinks.
                if ((error as NodeJS.ErrnoException).code === "EPERM") return;
                throw error;
            }
            const errors: unknown[] = [];
            const audit = new AuditLog({ dir, now: () => Date.parse("2024-03-01T00:00:00.000Z"), onError: (error) => errors.push(error) });
            await audit.record({ event: "login", result: "success" });
            expect(errors.length).toBe(1);
            expect(errors[0]).toBeInstanceOf(AuditError);
            expect(await readFile(target, "utf8")).toBe("original");
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test("refuses an invalid period and missing periods are empty", async () => {
        const dir = await tempDir();
        try {
            const audit = new AuditLog({ dir });
            await expect(audit.readPeriod("2024-3-1")).rejects.toBeInstanceOf(AuditError);
            await expect(audit.readPeriod("../../etc/passwd")).rejects.toBeInstanceOf(AuditError);
            expect(await audit.readPeriod("2024-03-01")).toEqual([]);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test("caps a period file and closes it with a single marker, also across restarts", async () => {
        const dir = await tempDir();
        try {
            const now = () => Date.parse("2024-03-01T10:00:00.000Z");
            const options = { dir, now, maxFileBytes: 4096, noisyPerMinute: 1_000_000 };
            const audit = new AuditLog(options);
            for (let i = 0; i < 200; i += 1) await audit.record({ event: "save", result: "success", detail: "x".repeat(100) });
            // A restarted panel must not write a second marker.
            const restarted = new AuditLog(options);
            await restarted.record({ event: "save", result: "success" });
            const raw = await readFile(join(dir, "2024-03-01.log"), "utf8");
            expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(4096);
            expect(raw.split('"result":"suspended"').length - 1).toBe(1);
            const entries = await audit.readPeriod("2024-03-01");
            expect(entries.at(-1)!.result).toBe("suspended");
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test("rate-caps noisy events and summarizes what was left out", async () => {
        const dir = await tempDir();
        try {
            let now = Date.parse("2024-03-01T10:00:00.000Z");
            const audit = new AuditLog({ dir, now: () => now, noisyPerMinute: 3 });
            for (let i = 0; i < 10; i += 1) await audit.record({ event: "login", result: "failure" }, { noisy: true });
            // Normal events are never dropped by the noisy cap.
            await audit.record({ event: "save", result: "success" });
            now += 60_000;
            await audit.record({ event: "login", result: "success" });
            const entries = await audit.readPeriod("2024-03-01");
            expect(entries.filter((entry) => entry.result === "failure").length).toBe(3);
            expect(entries.some((entry) => entry.event === "save")).toBe(true);
            const summary = entries.find((entry) => entry.result === "suppressed");
            expect(summary?.detail).toContain("7 more");
            expect(entries.at(-1)!.result).toBe("success");
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test("disabled log is a no-op", async () => {
        const dir = await tempDir();
        try {
            const audit = new AuditLog({ dir, enabled: false });
            await audit.record({ event: "login", result: "success" });
            expect(await audit.listPeriods()).toEqual([]);
            expect(await audit.readPeriod("2024-03-01")).toEqual([]);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});

describe("AuditLog managed paths and retention", () => {
    const NOW = Date.parse("2026-10-10T12:00:00.000Z");

    /** Directory link; a junction on Windows (no privilege needed), a symlink elsewhere. */
    async function linkDir(target: string, path: string): Promise<boolean> {
        try {
            await symlink(target, path, "junction");
            return true;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EPERM") return false;
            throw error;
        }
    }

    test("refuses a symlinked folder between the root and the audit folder", async () => {
        const root = await tempDir();
        try {
            const outside = join(root, "outside");
            await mkdir(outside);
            if (!(await linkDir(outside, join(root, ".compose-panel")))) return;
            const errors: unknown[] = [];
            const audit = new AuditLog({
                dir: join(root, ".compose-panel", "audit"),
                root,
                now: () => NOW,
                onError: (error) => errors.push(error),
            });
            await audit.record({ event: "login", result: "failure" });
            expect(errors.length).toBe(1);
            expect(errors[0]).toBeInstanceOf(AuditError);
            expect(existsSync(join(outside, "audit"))).toBe(false);

            // Reads refuse the same path, even once something exists behind it.
            await mkdir(join(outside, "audit"));
            await writeFile(join(outside, "audit", "2026-10-10.log"), `${JSON.stringify({ ts: "x", event: "planted", result: "x" })}\n`);
            await expect(audit.readPeriod("2026-10-10")).rejects.toBeInstanceOf(AuditError);
            expect(await audit.listPeriods()).toEqual([]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("refuses a symlinked audit folder for reads", async () => {
        const root = await tempDir();
        try {
            const outside = join(root, "outside");
            await mkdir(outside);
            await writeFile(join(outside, "2026-10-10.log"), `${JSON.stringify({ ts: "x", event: "planted", result: "x" })}\n`);
            if (!(await linkDir(outside, join(root, "audit")))) return;
            const audit = new AuditLog({ dir: join(root, "audit"), now: () => NOW, onError: () => {} });
            await expect(audit.readPeriod("2026-10-10")).rejects.toBeInstanceOf(AuditError);
            expect(await audit.listPeriods()).toEqual([]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("creates the default layout below its root", async () => {
        const root = await tempDir();
        try {
            const audit = new AuditLog({ dir: join(root, ".compose-panel", "audit"), root, now: () => NOW });
            await audit.record({ event: "login", result: "success" });
            expect((await audit.readPeriod("2026-10-10")).length).toBe(1);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("rejects an audit folder outside its root", () => {
        expect(() => new AuditLog({ dir: "/var/audit", root: "/srv/stacks" })).toThrow(AuditError);
    });

    test("retention removes only regular <period>.log files", async () => {
        const dir = await tempDir();
        try {
            await writeFile(join(dir, "2000-01-01.txt"), "unrelated");
            await writeFile(join(dir, "2000-01-01.log.bak"), "unrelated");
            await writeFile(join(dir, "2000-01-01log"), "unrelated");
            await mkdir(join(dir, "2000-01-02.log"));
            await writeFile(join(dir, "2000-01-03.log"), "");
            const audit = new AuditLog({ dir, retainFiles: 1, now: () => NOW });
            await audit.record({ event: "login", result: "success" });

            const names = (await readdir(dir)).sort();
            expect(names).toEqual(["2000-01-01.log.bak", "2000-01-01.txt", "2000-01-01log", "2000-01-02.log", "2026-10-10.log"]);
            expect(await audit.listPeriods()).toEqual(["2026-10-10"]);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
