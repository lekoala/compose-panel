// File-editing steps of scripts/setup-caddy.sh, run on temp files only. The
// script is sourced in library mode (COMPOSE_PANEL_SETUP_LIB=1): no systemd,
// no Docker, no Caddy, nothing outside the temp directory. Linux only (bash).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/setup-caddy.sh", import.meta.url));
const MANAGED = "/etc/caddy/compose-panel.d";
const PAIRS = ["COMPOSE_PANEL_CADDY_ENABLED=true", "COMPOSE_PANEL_CADDY_SOCKET_PATH=/run/compose-panel/caddy-helper.sock"];

async function lib(command: string, ...args: string[]): Promise<{ code: number; stdout: string }> {
    return shell(`${command} "$@"`, ...args);
}

async function shell(command: string, ...args: string[]): Promise<{ code: number; stdout: string }> {
    const proc = Bun.spawn(["bash", "-c", `source "$0"; ${command}`, SCRIPT, ...args], {
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

    test("only an absent or identical systemd unit may be installed", async () => {
        const source = join(dir, "source.socket");
        const installed = join(dir, "installed.socket");
        await writeFile(source, "[Socket]\nListenStream=/run/compose-panel/caddy-helper.sock\n");
        expect((await lib("unit_state", installed, source)).stdout).toBe("absent");
        await writeFile(installed, await readFile(source));
        expect((await lib("unit_state", installed, source)).stdout).toBe("same");
        await writeFile(installed, "[Socket]\nListenStream=/run/other.sock\n");
        expect((await lib("unit_state", installed, source)).stdout).toBe("differs");
        await rm(installed);
        await symlink(source, installed);
        expect((await lib("unit_state", installed, source)).stdout).toBe("unsafe");
        await rm(installed);
        await mkdir(installed);
        expect((await lib("unit_state", installed, source)).stdout).toBe("unsafe");
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
        await writeFile(
            envFile,
            `# COMPOSE_PANEL_CADDY_ENABLED=false\nCOMPOSE_PANEL_CADDY_ENABLED="true"\nCOMPOSE_PANEL_CADDY_SOCKET_PATH='/run/compose-panel/caddy-helper.sock'\n`,
        );
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

    // The real timeout(1) runs a fake Docker executable in a private PATH.
    async function fakeDocker(body: string) {
        await mkdir(join(dir, "bin"), { recursive: true });
        await writeFile(join(dir, "bin", "docker"), `#!/usr/bin/env bash\n${body}\n`);
        await chmod(join(dir, "bin", "docker"), 0o755);
    }

    test("only this checkout's single-file, non-oneoff Compose identity is accepted", async () => {
        await fakeDocker(`eval "values=($VALUES)"
case "$3" in
    *project\\\"*) printf '%s' "\${values[0]}" ;;
    *service\\\"*) printf '%s' "\${values[1]}" ;;
    *working_dir*) printf '%s' "\${values[2]}" ;;
    *config_files*) printf '%s' "\${values[3]}" ;;
    *oneoff*) printf '%s' "\${values[4]}" ;;
    *environment_file*) printf '%s' "\${values[5]}" ;;
    *) exit 1 ;;
esac`);
        const valid = ["compose-panel", "panel", `${dir}/deploy`, `${dir}/deploy/compose.yaml`, "False", ""];
        // Bash array syntax: every value quoted, including empty ones.
        const quote = (values: string[]) => values.map((value) => `'${value}'`).join(" ");
        const command = `REPO=$1; COMPOSE_FILE=$2; export PATH="$1/bin:$PATH" VALUES=$3; panel_identity_matches`;
        const check = (file: string, values: string[]) => shell(command, dir, file, quote(values));
        expect((await check(valid[3]!, valid)).code).toBe(0);
        const production = [...valid];
        production[3] = `${dir}/deploy/compose.prod.yaml`;
        expect((await check(production[3]!, production)).code).toBe(0);
        expect((await check(production[3]!, valid)).code).toBe(1);
        for (const [index, value] of [
            [0, "foreign"],
            [0, ""],
            [1, "other"],
            [2, "/second-checkout/deploy"],
            [3, "/second-checkout/deploy/compose.yaml"],
            [3, `${valid[3]},/override.yaml`],
            [4, "True"],
            [5, "/other.env"],
        ] as const) {
            const values = [...valid];
            values[index] = value;
            expect((await check(valid[3]!, values)).code).not.toBe(0);
        }
        await mkdir(join(dir, "deploy"));
        await writeFile(join(dir, "deploy", ".env"), "UNEXPECTED=value\n");
        expect((await check(valid[3]!, valid)).code).not.toBe(0);
    });

    test("a stalled Docker daemon fails the identity check within its bound", async () => {
        await fakeDocker("exec sleep 60");
        const started = performance.now();
        const result = await shell(
            `REPO=$1; COMPOSE_FILE=$1/deploy/compose.yaml; export PATH="$1/bin:$PATH"
if panel_identity_matches; then echo matched; else echo refused; fi`,
            dir,
        );
        expect(result.stdout).toBe("refused");
        // One bounded inspection, never six, never the whole hang.
        expect(performance.now() - started).toBeLessThan(25_000);
    }, 40_000);

    test("the Caddy service must use exactly the expected --config file", async () => {
        await mkdir(join(dir, "bin"));
        await writeFile(
            join(dir, "bin", "systemctl"),
            `#!/usr/bin/env bash
[ "$*" = "show caddy -p ExecStart --value" ] || exit 97
printf '%s\\n' "$EXEC"; exit "\${STATUS:-0}"
`,
        );
        await chmod(join(dir, "bin", "systemctl"), 0o755);
        const file = "/etc/caddy/Caddyfile";
        const check = (exec: string, status = "0") =>
            shell(`export PATH="$1/bin:$PATH" EXEC=$2 STATUS=$3; caddy_uses_config ${file}`, dir, exec, status);
        for (const exec of [
            `caddy run --environ --config ${file}`,
            `{ path=/usr/bin/caddy ; argv[]=caddy run --environ --config=${file} ; ignore_errors=no }`,
            `caddy run --config /elsewhere --config ${file}`,
        ])
            expect((await check(exec)).code).toBe(0);
        for (const exec of [
            "caddy run --config /elsewhere",
            `caddy run --config ${file}.custom`,
            `caddy run --config=${file}.custom`,
            `caddy run --config ${file} --config /elsewhere`,
            `caddy run --config=${file} --config=/elsewhere`,
            "caddy run",
        ])
            expect((await check(exec)).code).not.toBe(0);
        expect((await check(`caddy run --config ${file}`, "1")).code).not.toBe(0);
    });

    // Isolated Linux integration: the real Bash functions call a fake Docker
    // executable in a private PATH. No host daemon or system files are touched.
    for (const failure of ["none", "up", "health", "rollback"] as const) {
        test(`recreation preserves the running image and restores settings after ${failure}`, async () => {
            const oldImage = `sha256:${"a".repeat(64)}`;
            const cachedImage = `sha256:${"b".repeat(64)}`;
            const original = "COMPOSE_PANEL_ADMIN_PASSWORD_HASH='$argon2id$secret'\n";
            await writeFile(envFile, `${original}COMPOSE_PANEL_CADDY_ENABLED=true\n`);
            await writeFile(`${envFile}.bak-test`, original);
            await writeFile(join(dir, "tag"), cachedImage);
            await writeFile(
                join(dir, "docker"),
                `#!/usr/bin/env bash
set -eu
if [ "$1 $2" = 'image inspect' ]; then cat "$FIXTURE/tag"
elif [ "$1 $2" = 'image tag' ]; then printf '%s' "$3" > "$FIXTURE/tag"
elif [ "$1" = compose ]; then
    printf '%s\\n' "$@" > "$FIXTURE/args"
    cat "$FIXTURE/tag" >> "$FIXTURE/used-images"
    printf '\\n' >> "$FIXTURE/used-images"
    cat "$FIXTURE/compose-panel.env" > "$FIXTURE/settings-$(wc -l < "$FIXTURE/used-images")"
    count=$(wc -l < "$FIXTURE/used-images")
    if [ "$FAILURE" = rollback ] || { [ "$FAILURE" = up ] && [ "$count" = 1 ]; }; then exit 7; fi
else exit 99
fi
`,
            );
            await chmod(join(dir, "docker"), 0o700);
            const result = await shell(
                `
export FIXTURE=$1 FAILURE=$2 PATH="$1:$PATH"
REPO=$1; COMPOSE_FILE=$1/deploy/compose.yaml; ENV_FILE=$1/compose-panel.env
env_backup=$ENV_FILE.bak-test
panel_image=$3; panel_image_ref=ghcr.io/lekoala/compose-panel:latest
saved_tag_image=''
trap restore_panel_tag EXIT
wait_healthy() {
    [ "$FAILURE" != health ] || [ "$(wc -l < "$FIXTURE/used-images")" -gt 1 ]
}
recreate_and_verify_panel`,
                dir,
                failure,
                oldImage,
            );
            expect(result.code).toBe(failure === "none" ? 0 : 1);
            expect(await readFile(join(dir, "tag"), "utf8")).toBe(cachedImage);
            expect((await readFile(join(dir, "used-images"), "utf8")).trim().split("\n")).toEqual(
                Array(failure === "none" ? 1 : 2).fill(oldImage),
            );
            const args = (await readFile(join(dir, "args"), "utf8")).trim().split("\n");
            expect(args).toEqual([
                "compose",
                "-p",
                "compose-panel",
                "--project-directory",
                `${dir}/deploy`,
                "-f",
                `${dir}/deploy/compose.yaml`,
                "up",
                "-d",
                "--no-deps",
                "--no-build",
                "--pull",
                "never",
                "panel",
            ]);
            if (failure !== "none") {
                expect(await readFile(envFile, "utf8")).toBe(original);
                expect(await readFile(join(dir, "settings-2"), "utf8")).toBe(original);
            }
        });
    }

    test("tag cleanup runs on TERM and refuses to overwrite a concurrent tag change", async () => {
        const command = `
panel_image=running; saved_tag_image=cached; panel_image_ref=panel:latest
tag=$1; log=$2
docker() {
    if [ "$2" = inspect ]; then printf '%s' "$tag"
    elif [ "$2" = tag ]; then printf '%s' "$3" > "$log"
    else return 99
    fi
}
if [ "$3" = signal ]; then
    trap restore_panel_tag EXIT
    trap 'exit 143' TERM
    kill -TERM $$
else
    restore_panel_tag
fi`;
        const log = join(dir, "restored-tag");
        expect((await shell(command, "running", log, "signal")).code).toBe(143);
        expect(await readFile(log, "utf8")).toBe("cached");
        await rm(log);
        expect((await shell(command, "concurrent", log, "cleanup")).code).toBe(1);
        expect(await Bun.file(log).exists()).toBe(false);
    });
});

// Disposable test containers may lack git; CI runners always have it.
test.skipIf(!Bun.which("git"))("deployment secret backups are ignored by Git", async () => {
    const dir = await mkdtemp(join(tmpdir(), "compose-panel-ignore-"));
    try {
        await mkdir(join(dir, "deploy"));
        await writeFile(join(dir, "deploy", ".gitignore"), await Bun.file(new URL("../deploy/.gitignore", import.meta.url)).text());
        const init = Bun.spawn(["git", "init", "--quiet", dir], { stdout: "pipe", stderr: "pipe" });
        expect(await init.exited).toBe(0);
        const proc = Bun.spawn(["git", "check-ignore", "--no-index", "deploy/compose-panel.env.bak-20261016-120000"], {
            cwd: dir,
            stdout: "pipe",
            stderr: "pipe",
        });
        expect(await proc.exited).toBe(0);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
