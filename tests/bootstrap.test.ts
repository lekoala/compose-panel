import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap } from "../src/bootstrap.ts";
import { loadConfig } from "../src/config.ts";
import type { CommandResult, DockerRunner } from "../src/docker.ts";

// Regression: the production entry point once built the app without its
// runner, so the container inspector and self-update silently used an
// unavailable fallback while Compose calls worked. `bootstrap` is what
// `src/server.ts` runs; every Docker boundary must reach the same runner.

const PASSWORD = "bootstrap-test-password";
let root: string;

beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "compose-panel-bootstrap-"));
});

afterAll(async () => {
    await rm(root, { recursive: true, force: true });
});

const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "", timedOut: false, truncated: false });

test("every Docker boundary of the production app uses the real runner", async () => {
    const calls: string[][] = [];
    const runner: DockerRunner = async args => {
        calls.push(args);
        if (args[0] === "compose" && args[1] === "version") return ok("Docker Compose version v5.6.0");
        if (args[0] === "compose" && args[1] === "ls") return ok("[]");
        if (args[0] === "container" && args[1] === "ls") {
            const fields = [`b${"0".repeat(63)}`, "lonely-standalone", "busybox", "running", "Up 1 hour", "none", "2026-10-12T00:00:00Z", "1 hour ago", "", "", "", "", ""];
            return ok(`${fields.map(field => JSON.stringify(field)).join("\t")}\n`);
        }
        if (args[0] === "container" && args[1] === "inspect") return { code: 1, stdout: "[]", stderr: `Error: No such container: ${args[3]}`, timedOut: false, truncated: false };
        return { code: 1, stdout: "", stderr: "unexpected", timedOut: false, truncated: false };
    };
    const config = loadConfig({
        STACKS_DIR: root,
        COMPOSE_PANEL_ADMIN_USER: "bootstrapper",
        COMPOSE_PANEL_ADMIN_PASSWORD_HASH: await Bun.password.hash(PASSWORD),
        COMPOSE_PANEL_AUDIT_ENABLED: "false",
    });
    const { app, capabilities } = await bootstrap(config, { createRunner: () => runner });
    expect(capabilities.available).toBe(true);

    const origin = "http://127.0.0.1:5081";
    const login = await app.fetch(new Request(`${origin}/login`));
    const csrfCookie = login.headers.getSetCookie().find(cookie => cookie.startsWith("cp_csrf="))!.split(";")[0]!;
    const csrf = /name="csrf" value="([^"]+)"/.exec(await login.text())![1]!;
    const signedIn = await app.fetch(new Request(`${origin}/login`, {
        method: "POST",
        headers: { origin, cookie: csrfCookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ csrf, user: "bootstrapper", password: PASSWORD }).toString(),
    }));
    const session = signedIn.headers.getSetCookie().find(cookie => cookie.startsWith("cp_session="))!.split(";")[0]!;

    // Container inspector: the home page lists a container outside any stack.
    const home = await (await app.fetch(new Request(`${origin}/`, { headers: { cookie: session } }))).text();
    expect(home).toContain("lonely-standalone");
    // Self-update: About asks Docker for the updater container.
    expect((await app.fetch(new Request(`${origin}/about`, { headers: { cookie: session } }))).status).toBe(200);
    expect(calls).toContainEqual(["container", "inspect", "--", "compose-panel-updater"]);
});
