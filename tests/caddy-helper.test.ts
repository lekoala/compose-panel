import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    adaptContainsDomain,
    importConfiguredIn,
    parseHelperEnv,
    runHelperRequest,
    type HelperDeps,
    type HelperEnv,
    type HelperResponse,
} from "../src/caddy-helper.ts";
import { buildSiteFile } from "../src/caddy.ts";
import type { CommandResult } from "../src/docker.ts";

const okResult: CommandResult = { code: 0, stdout: "", stderr: "", timedOut: false, truncated: false };

interface FakeCaddyOptions {
    validate?: "ok" | "fail";
    adaptHosts?: string[] | "fail";
    reload?: Array<"ok" | "fail">;
}

function fakeCaddyRunner(options: FakeCaddyOptions = {}): { run: HelperDeps["runCaddy"]; calls: string[][] } {
    const calls: string[][] = [];
    const reloads = [...(options.reload ?? ["ok"])];
    const run: HelperDeps["runCaddy"] = async args => {
        calls.push(args);
        const [command] = args;
        if (command === "validate") {
            return options.validate === "fail" ? { ...okResult, code: 1, stderr: "invalid" } : okResult;
        }
        if (command === "adapt") {
            if (options.adaptHosts === "fail") return { ...okResult, code: 1 };
            const hosts = options.adaptHosts ?? ["app.example.com", "shop.example.com"];
            return { ...okResult, stdout: JSON.stringify({ apps: { http: { servers: { srv0: { routes: [{ match: [{ host: hosts }] }] } } } } }) };
        }
        if (command === "reload") {
            const next = reloads.shift() ?? "ok";
            return next === "ok" ? okResult : { ...okResult, code: 1, stderr: "reload failed" };
        }
        return { ...okResult, code: 1 };
    };
    return { run, calls };
}

let dir: string;
let managedDir: string;
let mainConfig: string;
let env: HelperEnv;

const MAIN_WITH_IMPORT = (managed: string): string =>
    // Real Caddyfiles use forward slashes, even for paths `join` would render
    // with backslashes on Windows.
    `{\n\tadmin localhost:2019\n}\n\nimport ${managed.replace(/\\/g, "/")}/*.caddy\n`;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "compose-panel-caddy-"));
    managedDir = join(dir, "compose-panel.d");
    await mkdir(managedDir, { recursive: true });
    mainConfig = join(dir, "Caddyfile");
    await writeFile(mainConfig, MAIN_WITH_IMPORT(managedDir));
    env = { managedDir, mainConfig, caddyBin: "caddy", commandTimeoutMs: 5000, maxOutputBytes: 262144 };
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

async function managedFiles(): Promise<string[]> {
    return (await readdir(managedDir)).filter(name => name.endsWith(".caddy")).sort();
}

describe("parseHelperEnv", () => {
    test("reads the managed directory, main config and defaults", () => {
        const parsed = parseHelperEnv({ CADDY_MANAGED_DIR: "/etc/caddy/compose-panel.d", CADDY_MAIN_CONFIG: "/etc/caddy/Caddyfile" });
        expect(parsed).toMatchObject({ managedDir: "/etc/caddy/compose-panel.d", mainConfig: "/etc/caddy/Caddyfile", caddyBin: "caddy" });
    });

    test("refuses a missing or relative directory or config", () => {
        expect(() => parseHelperEnv({ CADDY_MAIN_CONFIG: "/etc/caddy/Caddyfile" })).toThrow(/CADDY_MANAGED_DIR/);
        expect(() => parseHelperEnv({ CADDY_MANAGED_DIR: "relative", CADDY_MAIN_CONFIG: "/etc/caddy/Caddyfile" })).toThrow(/absolute/);
        expect(() => parseHelperEnv({ CADDY_MANAGED_DIR: "/etc/caddy/compose-panel.d" })).toThrow(/CADDY_MAIN_CONFIG/);
    });
});

describe("importConfiguredIn and adaptContainsDomain", () => {
    test("accepts the managed import in common spellings", () => {
        expect(importConfiguredIn(`import ${managedDir}/*.caddy\n`, managedDir)).toBe(true);
        expect(importConfiguredIn(`import "${managedDir}/*.caddy"  # managed sites\n`, managedDir)).toBe(true);
        expect(importConfiguredIn(`import ${managedDir}/*\n`, managedDir)).toBe(true);
    });

    test("refuses other directories and commented imports", () => {
        expect(importConfiguredIn("import /etc/caddy/other/*.caddy\n", managedDir)).toBe(false);
        expect(importConfiguredIn(`# import ${managedDir}/*.caddy\n`, managedDir)).toBe(false);
        expect(importConfiguredIn("", managedDir)).toBe(false);
    });

    test("matches the domain literally inside adapted JSON", () => {
        const adapted = JSON.stringify({ apps: { http: { servers: { srv0: { routes: [{ match: [{ host: ["app.example.com"] }] }] } } } } });
        expect(adaptContainsDomain(adapted, "app.example.com")).toBe(true);
        expect(adaptContainsDomain(adapted, "other.example.com")).toBe(false);
        // Dots are regex-significant: a lookalike must not match.
        expect(adaptContainsDomain(adapted, "appXexampleYcom")).toBe(false);
    });
});

describe("attach", () => {
    const attach = { action: "attach", domain: "app.example.com", stack: "web", service: "web", port: 8080 } as const;

    test("publishes the canonical file and reloads", async () => {
        const fake = fakeCaddyRunner();
        const response = await runHelperRequest({ ...attach }, env, { runCaddy: fake.run });
        expect(response).toEqual({ ok: true, action: "attach", unchanged: false });
        expect(await readFile(join(managedDir, "app.example.com.caddy"), "utf8"))
            .toBe(buildSiteFile({ domain: "app.example.com", stack: "web", service: "web", port: 8080 }));
        expect(fake.calls.map(call => call[0])).toEqual(["validate", "adapt", "reload"]);
    });

    test("repeating the same attach is a no-op without reload", async () => {
        const fake = fakeCaddyRunner();
        await runHelperRequest({ ...attach }, env, { runCaddy: fake.run });
        const calls = fake.calls.length;
        const response = await runHelperRequest({ ...attach }, env, { runCaddy: fake.run });
        expect(response).toEqual({ ok: true, action: "attach", unchanged: true });
        expect(fake.calls.length).toBe(calls);
    });

    test("refuses invalid input without touching the directory or Caddy", async () => {
        const fake = fakeCaddyRunner();
        const response = await runHelperRequest({ action: "attach", domain: "*.example.com", stack: "web", service: "web", port: 8080 }, env, { runCaddy: fake.run });
        expect(response.ok).toBe(false);
        expect((response as { code: string }).code).toBe("invalid");
        expect(await managedFiles()).toEqual([]);
        expect(fake.calls).toEqual([]);
    });

    test("refuses a foreign file and a differing managed file", async () => {
        const fake = fakeCaddyRunner();
        await writeFile(join(managedDir, "shop.example.com.caddy"), "shop.example.com {\n\treverse_proxy 127.0.0.1:8080\n}\n");
        const foreign = await runHelperRequest({ action: "attach", domain: "shop.example.com", stack: "web", service: "web", port: 8080 }, env, { runCaddy: fake.run });
        expect(foreign.ok).toBe(false);
        await runHelperRequest({ ...attach }, env, { runCaddy: fake.run });
        const changed = await runHelperRequest({ action: "attach", domain: "app.example.com", stack: "web", service: "web", port: 9090 }, env, { runCaddy: fake.run });
        expect(changed.ok).toBe(false);
        expect(await readFile(join(managedDir, "app.example.com.caddy"), "utf8")).toContain("8080");
    });

    test("refuses when the import is missing and publishes nothing", async () => {
        await writeFile(mainConfig, "# no import here\n");
        const fake = fakeCaddyRunner();
        const response = await runHelperRequest({ ...attach }, env, { runCaddy: fake.run });
        expect(response).toEqual({ ok: false, error: expect.stringContaining("import"), code: "unavailable" });
        expect(await managedFiles()).toEqual([]);
        expect(fake.calls).toEqual([]);
    });

    test("a failed validation removes the file without reloading", async () => {
        const fake = fakeCaddyRunner({ validate: "fail" });
        const response = await runHelperRequest({ ...attach }, env, { runCaddy: fake.run });
        expect(response.ok).toBe(false);
        expect(await managedFiles()).toEqual([]);
        expect(fake.calls.map(call => call[0])).toEqual(["validate"]);
    });

    test("a route missing from the adapted config removes the file", async () => {
        const fake = fakeCaddyRunner({ adaptHosts: ["other.example.com"] });
        const response = await runHelperRequest({ ...attach }, env, { runCaddy: fake.run });
        expect(response.ok).toBe(false);
        expect(await managedFiles()).toEqual([]);
        expect(fake.calls.map(call => call[0])).toEqual(["validate", "adapt"]);
    });

    test("a failed reload rolls back and reports failure", async () => {
        const fake = fakeCaddyRunner({ reload: ["fail", "ok"] });
        const response = await runHelperRequest({ ...attach }, env, { runCaddy: fake.run });
        expect(response).toEqual({ ok: false, error: expect.stringContaining("restored"), code: "failed" });
        expect(await managedFiles()).toEqual([]);
        expect(fake.calls.filter(call => call[0] === "reload")).toHaveLength(2);
    });

    test("a failed rollback reports unknown", async () => {
        const fake = fakeCaddyRunner({ reload: ["fail", "fail"] });
        const response = await runHelperRequest({ ...attach }, env, { runCaddy: fake.run });
        expect(response).toEqual({ ok: false, error: expect.stringContaining("unknown"), code: "unknown" });
    });

    test("concurrent attaches serialize behind the lock", async () => {
        const fake = fakeCaddyRunner({ adaptHosts: ["a.example.com", "b.example.com"] });
        const [first, second] = await Promise.all([
            runHelperRequest({ action: "attach", domain: "a.example.com", stack: "web", service: "web", port: 8080 }, env, { runCaddy: fake.run }),
            runHelperRequest({ action: "attach", domain: "b.example.com", stack: "web", service: "web", port: 8081 }, env, { runCaddy: fake.run }),
        ]);
        expect(first.ok).toBe(true);
        expect(second.ok).toBe(true);
        expect(await managedFiles()).toEqual(["a.example.com.caddy", "b.example.com.caddy"]);
    });

    test("a stale lock from a crashed holder does not block", async () => {
        const fake = fakeCaddyRunner();
        const lock = join(managedDir, ".lock");
        await mkdir(lock);
        const past = Date.now() - 120_000;
        await utimes(lock, new Date(past), new Date(past));
        const response = await runHelperRequest({ ...attach }, env, { runCaddy: fake.run });
        expect(response.ok).toBe(true);
    });

    test("a lock held by a live holder is waited on, never stolen", async () => {
        const fake = fakeCaddyRunner();
        const lock = join(managedDir, ".lock");
        await mkdir(lock);
        // Our own PID is alive: even an old lock directory must not be taken.
        await writeFile(join(lock, "owner"), `${process.pid}:other`, { flag: "wx" });
        const past = Date.now() - 120_000;
        await utimes(lock, new Date(past), new Date(past));
        const response = await runHelperRequest({ ...attach }, env, {
            runCaddy: fake.run,
            lockOptions: { staleMs: 50, waitMs: 150 },
        });
        expect(response).toEqual({ ok: false, error: expect.stringContaining("in progress"), code: "conflict" });
        expect(fake.calls).toEqual([]);
        expect(await managedFiles()).toEqual([]);
    });

    test("a lock left by a dead holder is reclaimed", async () => {
        const proc = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
        const dead = proc.pid;
        await proc.exited;
        const fake = fakeCaddyRunner();
        const lock = join(managedDir, ".lock");
        await mkdir(lock);
        await writeFile(join(lock, "owner"), `${dead}:crashed`, { flag: "wx" });
        const response = await runHelperRequest({ ...attach }, env, {
            runCaddy: fake.run,
            lockOptions: { staleMs: 60_000, waitMs: 1000 },
        });
        expect(response).toEqual({ ok: true, action: "attach", unchanged: false });
    });

    test("slow writers never overlap, even past the stale timeout", async () => {
        let active = 0;
        let maxActive = 0;
        const fake = fakeCaddyRunner({ adaptHosts: ["a.example.com", "b.example.com"] });
        const slow: HelperDeps["runCaddy"] = async (args, options) => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            try {
                // Longer than the stale timeout below: with stealing by age
                // alone, both writers would run their Caddy calls together.
                await Bun.sleep(120);
                return fake.run(args, options);
            } finally {
                active -= 1;
            }
        };
        const deps: HelperDeps = { runCaddy: slow, lockOptions: { staleMs: 30, waitMs: 10_000 } };
        const [first, second] = await Promise.all([
            runHelperRequest({ action: "attach", domain: "a.example.com", stack: "web", service: "web", port: 8080 }, env, deps),
            runHelperRequest({ action: "attach", domain: "b.example.com", stack: "web", service: "web", port: 8081 }, env, deps),
        ]);
        expect(first.ok).toBe(true);
        expect(second.ok).toBe(true);
        expect(maxActive).toBe(1);
        expect(await managedFiles()).toEqual(["a.example.com.caddy", "b.example.com.caddy"]);
    });
});

describe("detach", () => {
    const attach = { action: "attach", domain: "app.example.com", stack: "web", service: "web", port: 8080 } as const;

    test("removes the file and reloads", async () => {
        const fake = fakeCaddyRunner();
        await runHelperRequest({ ...attach }, env, { runCaddy: fake.run });
        const calls = fake.calls.length;
        const response = await runHelperRequest({ action: "detach", domain: "app.example.com", stack: "web" }, env, { runCaddy: fake.run });
        expect(response).toEqual({ ok: true, action: "detach" });
        expect(await managedFiles()).toEqual([]);
        expect(fake.calls.slice(calls).map(call => call[0])).toEqual(["reload"]);
    });

    test("refuses a missing, foreign or other-stack domain", async () => {
        const fake = fakeCaddyRunner();
        expect((await runHelperRequest({ action: "detach", domain: "missing.example.com", stack: "web" }, env, { runCaddy: fake.run })).ok).toBe(false);
        await writeFile(join(managedDir, "shop.example.com.caddy"), "not managed\n");
        expect((await runHelperRequest({ action: "detach", domain: "shop.example.com", stack: "web" }, env, { runCaddy: fake.run })).ok).toBe(false);
        expect(await managedFiles()).toEqual(["shop.example.com.caddy"]);
        await runHelperRequest({ ...attach }, env, { runCaddy: fake.run });
        const reloads = fake.calls.filter(call => call[0] === "reload").length;
        const other = await runHelperRequest({ action: "detach", domain: "app.example.com", stack: "other" }, env, { runCaddy: fake.run });
        expect(other.ok).toBe(false);
        expect(await managedFiles()).toContain("app.example.com.caddy");
        expect(fake.calls.filter(call => call[0] === "reload")).toHaveLength(reloads);
    });

    test("a failed reload restores the file and reports failure", async () => {
        const fake = fakeCaddyRunner({ reload: ["ok", "fail", "ok"] });
        await runHelperRequest({ ...attach }, env, { runCaddy: fake.run });
        const response = await runHelperRequest({ action: "detach", domain: "app.example.com", stack: "web" }, env, { runCaddy: fake.run });
        expect(response).toEqual({ ok: false, error: expect.stringContaining("restored"), code: "failed" });
        expect(await managedFiles()).toEqual(["app.example.com.caddy"]);
    });

    test("a failed restore reports unknown", async () => {
        const fake = fakeCaddyRunner({ reload: ["ok", "fail", "fail"] });
        await runHelperRequest({ ...attach }, env, { runCaddy: fake.run });
        const response = await runHelperRequest({ action: "detach", domain: "app.example.com", stack: "web" }, env, { runCaddy: fake.run });
        expect(response).toEqual({ ok: false, error: expect.stringContaining("unknown"), code: "unknown" });
        expect(await managedFiles()).toEqual(["app.example.com.caddy"]);
    });
});

describe("status and unknown shapes", () => {
    test("lists managed sites and flags unparseable files", async () => {
        const fake = fakeCaddyRunner();
        await runHelperRequest({ action: "attach", domain: "app.example.com", stack: "web", service: "web", port: 8080 }, env, { runCaddy: fake.run });
        await writeFile(join(managedDir, "broken.example.com.caddy"), "not managed\n");
        const response = await runHelperRequest({ action: "status" }, env, { runCaddy: fake.run });
        expect(response).toEqual({
            ok: true,
            action: "status",
            sites: [{ domain: "app.example.com", stack: "web", service: "web", port: 8080 }],
            unparseable: ["broken.example.com.caddy"],
            importConfigured: true,
        });
        expect(fake.calls).toHaveLength(3);
    });

    test("reports a missing import without failing", async () => {
        await writeFile(mainConfig, "# no import here\n");
        const fake = fakeCaddyRunner();
        const response = (await runHelperRequest({ action: "status" }, env, { runCaddy: fake.run })) as Extract<HelperResponse, { ok: true }>;
        expect(response.ok).toBe(true);
        if (response.ok && response.action === "status") expect(response.importConfigured).toBe(false);
    });

    test("refuses unknown actions and shapes", async () => {
        const fake = fakeCaddyRunner();
        for (const raw of [{ action: "reload" }, { action: "attach" }, null, "attach", { domain: "app.example.com" }]) {
            const response = await runHelperRequest(raw, env, { runCaddy: fake.run });
            expect(response.ok).toBe(false);
        }
        expect(fake.calls).toEqual([]);
        expect(await managedFiles()).toEqual([]);
    });
});

// End-to-end wiring of the stdio entry point against a fake `caddy`
// executable: protocol framing, exit codes and real file publication. Linux
// only (needs a `bash` fake binary with an executable bit). It never touches
// a real Caddy or daemon: every path stays inside disposable temp dirs.
describe.skipIf(process.platform !== "linux")("caddy helper stdio entry", () => {
    const helperPath = fileURLToPath(new URL("../src/scripts/caddy-helper.ts", import.meta.url));
    let entryDir = "";
    let entryManaged = "";
    let entryMain = "";
    let fakeBin = "";

    const FAKE_CADDY_LINES = [
        "#!/bin/bash",
        'cmd="$1"',
        'if [ "$cmd" = "validate" ]; then exit "${CADDY_FAKE_VALIDATE:-0}"; fi',
        'if [ "$cmd" = "adapt" ]; then',
        '  if [ "$CADDY_FAKE_ADAPT" = "fail" ]; then exit 1; fi',
        '  hosts_json=""',
        '  for h in $CADDY_FAKE_HOSTS; do hosts_json="$hosts_json\\"$h\\","; done',
        '  hosts_json="[${hosts_json%,}]"',
        "  echo '{\"apps\":{\"http\":{\"servers\":{\"srv0\":{\"routes\":[{\"match\":[{\"host\":'\"$hosts_json\"'}]}]}}}}}'",
        "  exit 0",
        "fi",
        'if [ "$cmd" = "reload" ]; then',
        '  if [ -n "$CADDY_FAKE_RELOAD_SEQ" ]; then',
        '    n=$(cat "$CADDY_FAKE_COUNTER" 2>/dev/null || echo 0)',
        '    code=$(echo "$CADDY_FAKE_RELOAD_SEQ" | cut -d, -f$((n + 1)))',
        '    echo $((n + 1)) > "$CADDY_FAKE_COUNTER"',
        '    exit "${code:-0}"',
        "  fi",
        '  exit "${CADDY_FAKE_RELOAD:-0}"',
        "fi",
        "exit 1",
        "",
    ];

    beforeEach(async () => {
        entryDir = await mkdtemp(join(tmpdir(), "compose-panel-helper-entry-"));
        entryManaged = join(entryDir, "compose-panel.d");
        await mkdir(entryManaged, { recursive: true });
        entryMain = join(entryDir, "Caddyfile");
        await writeFile(entryMain, `{\n\tadmin localhost:2019\n}\n\nimport ${entryManaged}/*.caddy\n`);
        fakeBin = join(entryDir, "caddy");
        await writeFile(fakeBin, FAKE_CADDY_LINES.join("\n"));
        await chmod(fakeBin, 0o755);
    });

    afterEach(async () => {
        await rm(entryDir, { recursive: true, force: true });
    });

    async function invoke(requestLine: string, extraEnv: Record<string, string> = {}): Promise<{ code: number; stdout: string }> {
        const proc = Bun.spawn([process.execPath, helperPath], {
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
            env: {
                CADDY_MANAGED_DIR: entryManaged,
                CADDY_MAIN_CONFIG: entryMain,
                CADDY_BIN: fakeBin,
                CADDY_FAKE_HOSTS: "app.example.com",
                ...extraEnv,
            },
        });
        const writer = proc.stdin;
        writer.write(new TextEncoder().encode(requestLine));
        writer.end();
        const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
        return { code, stdout };
    }

    test("answers status over stdio", async () => {
        const { code, stdout } = await invoke(`{"action":"status"}\n`);
        expect(code).toBe(0);
        expect(JSON.parse(stdout)).toEqual({ ok: true, action: "status", sites: [], unparseable: [], importConfigured: true });
    });

    test("attaches end to end and publishes the file", async () => {
        const { code, stdout } = await invoke(`{"action":"attach","domain":"app.example.com","stack":"web","service":"web","port":8080}\n`);
        expect(code).toBe(0);
        expect(JSON.parse(stdout)).toEqual({ ok: true, action: "attach", unchanged: false });
        expect(await readFile(join(entryManaged, "app.example.com.caddy"), "utf8"))
            .toBe(buildSiteFile({ domain: "app.example.com", stack: "web", service: "web", port: 8080 }));
    });

    test("refuses without applying when the import is missing", async () => {
        await writeFile(entryMain, "# no import here\n");
        const { code, stdout } = await invoke(`{"action":"attach","domain":"app.example.com","stack":"web","service":"web","port":8080}\n`);
        expect(code).toBe(0);
        expect(JSON.parse(stdout)).toMatchObject({ ok: false, code: "unavailable" });
        expect(await readdir(entryManaged)).toEqual([]);
    });

    test("rejects an oversized request and invalid JSON", async () => {
        const big = await invoke(`${JSON.stringify({ action: "status", pad: "x".repeat(9000) })}\n`);
        expect(big.code).toBe(2);
        expect(JSON.parse(big.stdout).ok).toBe(false);
        const broken = await invoke("not json\n");
        expect(broken.code).toBe(2);
        expect(JSON.parse(broken.stdout).ok).toBe(false);
    });
});
