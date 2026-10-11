import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../src/docker.ts";
import { createComposeProvider } from "../src/compose-provider.ts";

// Isolated child-process integration: no Docker executable or daemon is used.
test.skipIf(process.platform !== "linux")("timeout escalates against a child ignoring SIGTERM", async () => {
    let pid = 0;
    const started = Date.now();
    try {
        const result = await runCommand(process.execPath, ["-e", "process.on('SIGTERM', () => {}); process.stdout.write(String(process.pid)); setInterval(() => {}, 1000)"], {
            timeoutMs: 500, onChunk: text => { pid = Number(text); },
        });
        expect(result.timedOut).toBe(true);
        expect(result.terminationUnconfirmed).toBe(false);
        expect(result.code).not.toBe(0);
        expect(Date.now() - started).toBeLessThan(2500);
        expect(pid).toBeGreaterThan(0);
        expect(() => process.kill(pid, 0)).toThrow();
    } finally {
        if (pid > 0) { try { process.kill(pid, "SIGKILL"); } catch { /* already reaped */ } }
    }
});

test.skipIf(process.platform !== "linux")("provider follows a fixture with exact UTF-8 and confirms resistant child exit on abort", async () => {
    const directory = await mkdtemp(join(tmpdir(), "compose-panel-process-"));
    const executable = join(directory, "fixture-docker");
    let pid = 0;
    try {
        await writeFile(executable, `#!${process.execPath}\nprocess.on('SIGTERM', () => {});
process.stdout.write(JSON.stringify(process.argv.slice(2)) + '\\n' + process.pid + '\\n');
const bytes = Buffer.from('é🙂');
process.stdout.write(bytes.subarray(0, 1));
setTimeout(() => process.stdout.write(bytes.subarray(1, 4)), 30);
setTimeout(() => process.stdout.write(bytes.subarray(4)), 60);
setInterval(() => {}, 1000);
`);
        await chmod(executable, 0o700);
        const controller = new AbortController();
        const provider = createComposeProvider({ dockerPath: executable, runner: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false, truncated: false }) });
        let output = "";
        const watchdog = setTimeout(() => controller.abort(), 2000);
        try {
            const result = await provider.followLogs({ project: "fixture", cwd: directory, composeFile: join(directory, "compose.yaml"), tailLines: 5 }, text => {
                output += text;
                const lines = output.split("\n");
                pid = Number(lines[1]) || pid;
                if (output.endsWith("é🙂")) controller.abort();
            }, controller.signal);
            expect(output.endsWith("é🙂")).toBe(true);
            expect(JSON.parse(output.split("\n")[0]!)).toEqual([
                "compose", "-p", "fixture", "--project-directory", directory,
                "-f", join(directory, "compose.yaml"), "logs", "--follow", "--tail", "5", "--timestamps",
            ]);
            expect(result.terminationUnconfirmed).toBe(false);
            expect(result.code).not.toBe(0);
            expect(pid).toBeGreaterThan(0);
            expect(() => process.kill(pid, 0)).toThrow();
        } finally { clearTimeout(watchdog); }
    } finally {
        if (pid > 0) { try { process.kill(pid, "SIGKILL"); } catch { /* already reaped */ } }
        await rm(directory, { recursive: true, force: true });
    }
});

test.skipIf(process.platform !== "linux")("escalation reaches an orphaned plugin-like child holding the pipes", async () => {
    let helperPid = 0;
    const helper = "process.on('SIGTERM', () => {}); process.stdout.write('helper:' + process.pid + '\\n'); setInterval(() => {}, 1000)";
    const parent = `Bun.spawn([process.execPath, '-e', ${JSON.stringify(helper)}], { stdout: 'inherit', stderr: 'inherit' }); setInterval(() => {}, 1000)`;
    try {
        const result = await runCommand(process.execPath, ["-e", parent], {
            timeoutMs: 500,
            onChunk: text => { helperPid = Number(/helper:(\d+)/.exec(text)?.[1]) || helperPid; },
        });
        expect(result.timedOut).toBe(true);
        expect(result.terminationUnconfirmed).toBe(false);
        expect(helperPid).toBeGreaterThan(0);
        // Orphan zombies may briefly await the WSL init reaper. They have
        // exited and cannot execute mutations; a running/sleeping child fails.
        // The pipes close while the killed helper is still exiting (files are
        // released before it turns zombie), so allow that short window. A
        // helper reaped between open and read gives ESRCH instead of ENOENT.
        const state = async () => {
            const stat = await readFile(`/proc/${helperPid}/stat`, "utf8").catch(error => {
                const code = (error as NodeJS.ErrnoException).code;
                if (code === "ENOENT" || code === "ESRCH") return null;
                throw error;
            });
            return stat === null ? "gone" : stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
        };
        let current = await state();
        for (const until = Date.now() + 2000; current !== "gone" && current !== "Z" && Date.now() < until;) {
            await Bun.sleep(20);
            current = await state();
        }
        expect(["gone", "Z"]).toContain(current);
    } finally {
        if (helperPid > 0) { try { process.kill(helperPid, "SIGKILL"); } catch { /* already reaped */ } }
    }
});
