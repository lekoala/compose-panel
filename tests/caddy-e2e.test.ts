// End-to-end test of the Caddy helper against a REAL, disposable Caddy
// (ADR 0030). Opt-in and Linux only: set COMPOSE_PANEL_TEST_CADDY_BIN to a
// Caddy binary (`bun run test:caddy:wsl` downloads a pinned release).
//
// Never touches a host Caddy: the instance runs from a temp directory with its
// own Caddyfile, storage, random admin/HTTP/HTTPS ports and an internal CA,
// and is stopped afterwards. Real `caddy adapt|validate|reload` runs through
// the production runner; only the "reload fails" cases wrap it to fail one
// reload on purpose, so the rollback itself is still real.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCaddyRunner, parseHelperEnv, runHelperRequest, type HelperDeps, type HelperEnv } from "../src/caddy-helper.ts";

const CADDY_BIN = process.env.COMPOSE_PANEL_TEST_CADDY_BIN ?? "";

function freePort(): number {
    const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const { port } = listener;
    listener.stop(true);
    return port;
}

describe.skipIf(process.platform !== "linux" || CADDY_BIN === "")("caddy helper against a real Caddy", () => {
    let dir = "";
    let managedDir = "";
    let mainConfig = "";
    let env: HelperEnv;
    let runCaddy: HelperDeps["runCaddy"];
    let caddy: ReturnType<typeof Bun.spawn> | null = null;
    let upstream: ReturnType<typeof Bun.serve>;
    let adminPort = 0;
    let httpsPort = 0;
    const savedEnv = { XDG_DATA_HOME: process.env.XDG_DATA_HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };

    async function startCaddy(): Promise<void> {
        caddy = Bun.spawn([CADDY_BIN, "run", "--config", mainConfig, "--adapter", "caddyfile"], {
            cwd: dir,
            stdout: "ignore",
            stderr: "ignore",
        });
        for (let i = 0; i < 100; i += 1) {
            const ready = await fetch(`http://127.0.0.1:${adminPort}/config/`)
                .then((r) => r.ok)
                .catch(() => false);
            if (ready) return;
            await Bun.sleep(100);
        }
        throw new Error("The disposable Caddy did not start.");
    }

    async function stopCaddy(): Promise<void> {
        if (!caddy) return;
        caddy.kill();
        await caddy.exited;
        caddy = null;
    }

    /** Hosts in the configuration Caddy is running right now. */
    async function runningHosts(): Promise<string[]> {
        const config = await (await fetch(`http://127.0.0.1:${adminPort}/config/`)).text();
        return [...config.matchAll(/"host":\[([^\]]*)\]/g)].flatMap((match) => JSON.parse(`[${match[1]}]`) as string[]);
    }

    /** One HTTPS request through Caddy for a host, trusting nothing but the
     * loopback address (internal CA, so verification is skipped). */
    async function through(host: string): Promise<string> {
        const proc = Bun.spawn(
            ["curl", "-sk", "--max-time", "5", "--resolve", `${host}:${httpsPort}:127.0.0.1`, `https://${host}:${httpsPort}/`],
            { stdout: "pipe", stderr: "ignore" },
        );
        const [body] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
        return body;
    }

    async function managedFiles(): Promise<string[]> {
        return (await readdir(managedDir)).sort();
    }

    const attach = { action: "attach", domain: "app.example.com", stack: "web", service: "web" } as const;

    beforeAll(async () => {
        dir = await mkdtemp(join(tmpdir(), "compose-panel-caddy-e2e-"));
        managedDir = join(dir, "compose-panel.d");
        mainConfig = join(dir, "Caddyfile");
        // Every `caddy` subprocess inherits this: nothing lands in the real
        // user's data or config directories.
        process.env.XDG_DATA_HOME = join(dir, "xdg-data");
        process.env.XDG_CONFIG_HOME = join(dir, "xdg-config");
        upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("upstream-ok") });
        adminPort = freePort();
        httpsPort = freePort();
        const httpPort = freePort();
        await mkdir(managedDir);
        await writeFile(
            mainConfig,
            `{
\tadmin 127.0.0.1:${adminPort}
\tpersist_config off
\tlocal_certs
\tskip_install_trust
\thttp_port ${httpPort}
\thttps_port ${httpsPort}
\tstorage file_system ${join(dir, "storage")}
}

taken.example.com {
\trespond "main"
}

import ${managedDir}/*.caddy
`,
        );
        env = parseHelperEnv({ CADDY_MANAGED_DIR: managedDir, CADDY_MAIN_CONFIG: mainConfig, CADDY_BIN });
        runCaddy = createCaddyRunner(env);
        await startCaddy();
    });

    afterEach(async () => {
        if (!caddy) await startCaddy();
    });

    afterAll(async () => {
        await stopCaddy();
        upstream?.stop(true);
        process.env.XDG_DATA_HOME = savedEnv.XDG_DATA_HOME;
        process.env.XDG_CONFIG_HOME = savedEnv.XDG_CONFIG_HOME;
        if (savedEnv.XDG_DATA_HOME === undefined) delete process.env.XDG_DATA_HOME;
        if (savedEnv.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
        await rm(dir, { recursive: true, force: true });
    });

    test("attach routes the domain to the upstream, detach removes it", async () => {
        const attached = await runHelperRequest({ ...attach, port: upstream.port }, env, { runCaddy });
        expect(attached).toEqual({ ok: true, action: "attach", unchanged: false });
        expect(await runningHosts()).toContain("app.example.com");
        expect(await through("app.example.com")).toBe("upstream-ok");
        expect(await through("taken.example.com")).toBe("main");

        const again = await runHelperRequest({ ...attach, port: upstream.port }, env, { runCaddy });
        expect(again).toEqual({ ok: true, action: "attach", unchanged: true });

        const detached = await runHelperRequest({ action: "detach", domain: "app.example.com", stack: "web" }, env, { runCaddy });
        expect(detached).toEqual({ ok: true, action: "detach" });
        expect(await runningHosts()).not.toContain("app.example.com");
        expect(await through("app.example.com")).not.toBe("upstream-ok");
        expect(await through("taken.example.com")).toBe("main");
        expect(await managedFiles()).toEqual([]);
    });

    test("a domain already served by the main Caddyfile is refused and the routing stays intact", async () => {
        const response = await runHelperRequest({ ...attach, domain: "taken.example.com", port: upstream.port }, env, { runCaddy });
        expect(response).toMatchObject({ ok: false, code: "conflict" });
        expect(await managedFiles()).toEqual([]);
        expect(await through("taken.example.com")).toBe("main");
    });

    test("a failed reload on attach rolls back to the previous running configuration", async () => {
        let reloads = 0;
        const failingFirstReload: HelperDeps["runCaddy"] = async (args, options) => {
            if (args[0] === "reload" && reloads++ === 0) {
                return { code: 1, stdout: "", stderr: "simulated reload failure", timedOut: false, truncated: false };
            }
            return runCaddy(args, options);
        };
        const response = await runHelperRequest({ ...attach, port: upstream.port }, env, { runCaddy: failingFirstReload });
        expect(response).toMatchObject({ ok: false, code: "failed" });
        expect(reloads).toBe(2);
        expect(await managedFiles()).toEqual([]);
        expect(await runningHosts()).not.toContain("app.example.com");
        expect(await through("taken.example.com")).toBe("main");
    });

    test("a failed reload on detach restores the file and keeps the domain served", async () => {
        expect((await runHelperRequest({ ...attach, port: upstream.port }, env, { runCaddy })).ok).toBe(true);
        let reloads = 0;
        const failingFirstReload: HelperDeps["runCaddy"] = async (args, options) => {
            if (args[0] === "reload" && reloads++ === 0) {
                return { code: 1, stdout: "", stderr: "simulated reload failure", timedOut: false, truncated: false };
            }
            return runCaddy(args, options);
        };
        const response = await runHelperRequest({ action: "detach", domain: "app.example.com", stack: "web" }, env, {
            runCaddy: failingFirstReload,
        });
        expect(response).toMatchObject({ ok: false, code: "failed" });
        expect(await managedFiles()).toEqual(["app.example.com.caddy"]);
        expect(await through("app.example.com")).toBe("upstream-ok");
        expect((await runHelperRequest({ action: "detach", domain: "app.example.com", stack: "web" }, env, { runCaddy })).ok).toBe(true);
    });

    test("an unreachable Caddy is reported as unknown, never as success", async () => {
        await stopCaddy();
        const response = await runHelperRequest({ ...attach, port: upstream.port }, env, { runCaddy });
        expect(response).toMatchObject({ ok: false, code: "unknown" });
        // The candidate was removed: the next start loads the previous state.
        expect(await managedFiles()).toEqual([]);
    });
});
