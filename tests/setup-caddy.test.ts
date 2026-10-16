// File-editing steps of scripts/setup-caddy.sh, run on temp files only. The
// script is sourced in library mode (COMPOSE_PANEL_SETUP_LIB=1): no systemd,
// no Docker, no Caddy, nothing outside the temp directory. Linux only (bash).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/setup-caddy.sh", import.meta.url));
const MANAGED = "/etc/caddy/compose-panel.d";
const PAIRS = ["COMPOSE_PANEL_CADDY_ENABLED=true", "COMPOSE_PANEL_CADDY_SOCKET_PATH=/run/compose-panel/caddy-helper.sock"];

async function lib(command: string, ...args: string[]): Promise<{ code: number; stdout: string }> {
    const proc = Bun.spawn(["bash", "-c", `source "$0"; ${command} "$@"`, SCRIPT, ...args], {
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", COMPOSE_PANEL_SETUP_LIB: "1" },
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { code, stdout: stdout.trim() };
}

describe.skipIf(process.platform !== "linux")("setup-caddy.sh file steps", () => {
    let dir = "";
    let caddyfile = "";
    let envFile = "";

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), "compose-panel-setup-"));
        caddyfile = join(dir, "Caddyfile");
        envFile = join(dir, "compose-panel.env");
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    test("the managed import is detected in its accepted spellings and not in comments", async () => {
        for (const line of [`import ${MANAGED}/*.caddy`, `  import "${MANAGED}/*.caddy"  # sites`, `import\t${MANAGED}/*.caddy`]) {
            await writeFile(caddyfile, `{\n\temail ops@example.com\n}\n${line}\n`);
            expect((await lib("caddy_import_state", caddyfile, MANAGED)).stdout).toBe("present");
        }
        await writeFile(caddyfile, `# import ${MANAGED}/*.caddy\nexample.com {\n\trespond "hi"\n}`);
        expect((await lib("caddy_import_state", caddyfile, MANAGED)).stdout).toBe("absent");
    });

    test("another import of the managed directory is a conflict, never rewritten", async () => {
        for (const line of [`import ${MANAGED}/*`, `import ${MANAGED}/app.example.com.caddy`, `import ${MANAGED}`]) {
            await writeFile(caddyfile, `${line}\n`);
            expect((await lib("caddy_import_state", caddyfile, MANAGED)).stdout).toBe("conflict");
        }
        // An unrelated import with a shared prefix is not ours.
        await writeFile(caddyfile, `import ${MANAGED}-other/*.caddy\n`);
        expect((await lib("caddy_import_state", caddyfile, MANAGED)).stdout).toBe("absent");
    });

    test("appending the import keeps the file, ends it with the import, and is detected afterwards", async () => {
        const original = `{\n\temail ops@example.com\n}\n\nexample.com {\n\trespond "hi"\n}`;
        await writeFile(caddyfile, original);
        expect((await lib("append_caddy_import", caddyfile, MANAGED)).code).toBe(0);
        const updated = await readFile(caddyfile, "utf8");
        expect(updated.startsWith(`${original}\n`)).toBe(true);
        expect(updated.trimEnd().endsWith(`import ${MANAGED}/*.caddy`)).toBe(true);
        expect((await lib("caddy_import_state", caddyfile, MANAGED)).stdout).toBe("present");
    });

    test("env settings are added once, without touching existing lines", async () => {
        const original = "COMPOSE_PANEL_ADMIN_USER=operator\nCOMPOSE_PANEL_ADMIN_PASSWORD_HASH='$argon2id$x'";
        await writeFile(envFile, original);
        expect((await lib("env_state", envFile, ...PAIRS)).stdout).toBe("missing");
        await lib("ensure_env", envFile, ...PAIRS);
        const once = await readFile(envFile, "utf8");
        expect(once.startsWith(`${original}\n`)).toBe(true);
        expect((await lib("env_state", envFile, ...PAIRS)).stdout).toBe("ok");
        await lib("ensure_env", envFile, ...PAIRS);
        expect(await readFile(envFile, "utf8")).toBe(once);
    });

    test("env settings already set, quoted or commented, are read like Compose does", async () => {
        await writeFile(envFile, `# COMPOSE_PANEL_CADDY_ENABLED=false\nCOMPOSE_PANEL_CADDY_ENABLED="true"\nCOMPOSE_PANEL_CADDY_SOCKET_PATH='/run/compose-panel/caddy-helper.sock'\n`);
        expect((await lib("env_state", envFile, ...PAIRS)).stdout).toBe("ok");
        // Only one key set: the other is added, the existing one kept.
        await writeFile(envFile, "COMPOSE_PANEL_CADDY_ENABLED=true\n");
        await lib("ensure_env", envFile, ...PAIRS);
        const content = await readFile(envFile, "utf8");
        expect(content.match(/^COMPOSE_PANEL_CADDY_ENABLED=/gm)).toHaveLength(1);
        expect((await lib("env_state", envFile, ...PAIRS)).stdout).toBe("ok");
    });

    test("an env setting with another value is a conflict and is left alone", async () => {
        await writeFile(envFile, "COMPOSE_PANEL_CADDY_ENABLED=false\n");
        expect((await lib("env_state", envFile, ...PAIRS)).stdout).toBe("conflict");
        await writeFile(envFile, "COMPOSE_PANEL_CADDY_SOCKET_PATH=/elsewhere.sock\n");
        expect((await lib("env_state", envFile, ...PAIRS)).stdout).toBe("conflict");
    });

    test("without --check or --install the script refuses and changes nothing", async () => {
        const proc = Bun.spawn(["bash", SCRIPT], { stdout: "pipe", stderr: "pipe" });
        expect(await proc.exited).toBe(64);
        const unknown = Bun.spawn(["bash", SCRIPT, "--force"], { stdout: "pipe", stderr: "pipe" });
        expect(await unknown.exited).toBe(64);
    });
});
