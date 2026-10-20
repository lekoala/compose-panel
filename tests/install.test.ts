import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/install.sh", import.meta.url));
const SETUP = fileURLToPath(new URL("../scripts/setup-caddy.sh", import.meta.url));
const LOCK = fileURLToPath(new URL("../deploy/caddy/with-caddy-lock.sh", import.meta.url));

async function shell(command: string, args: string[] = [], input = "", env: Record<string, string> = {}) {
    const proc = Bun.spawn(["bash", "-c", `source "$0"; ${command}`, SCRIPT, ...args], {
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", COMPOSE_PANEL_INSTALL_LIB: "1", ...env },
        stdin: new Blob([input]), stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    return { stdout, stderr, code };
}

describe.skipIf(process.platform === "win32")("Ubuntu installer isolated fixtures", () => {
    let dir: string;
    beforeEach(async () => {
        dir = await realpath(await mkdtemp(join(tmpdir(), "cp-install-")));
    });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    test("only the requested Ubuntu LTS releases and architectures are accepted", async () => {
        for (const release of ["24.04", "26.04"]) {
            for (const arch of ["amd64", "arm64"]) {
                expect((await shell('supported_host "$@"', ["ubuntu", release, arch])).code).toBe(0);
            }
        }
        for (const args of [["debian", "24.04", "amd64"], ["ubuntu", "22.04", "amd64"],
            ["ubuntu", "26.10", "amd64"], ["ubuntu", "24.04", "armhf"]]) {
            expect((await shell('supported_host "$@"', args)).code).not.toBe(0);
        }
    });

    test("user and domain validators reject configuration injection and weak usernames", async () => {
        expect((await shell('valid_user "$1"', ["operator_42"])).code).toBe(0);
        for (const value of ["admin", "Root", "administrator", "a", "a\nadmin", "-operator", "ops' #"]) {
            expect((await shell('valid_user "$1"', [value])).code).not.toBe(0);
        }
        expect((await shell('valid_domain "$1"', ["panel.example.org"])).code).toBe(0);
        for (const value of ["https://panel.example.org", "127.0.0.1", "host.local", "a..org",
            "a.org.", "*.example.org", "a.org {\nrespond secret\n}", "-a.org", "a-.org", "a.org:443"]) {
            expect((await shell('valid_domain "$1"', [value])).code).not.toBe(0);
        }
    });

    test("env output round-trips hashes literally and never enables a public origin in private mode", async () => {
        const hash = "$argon2id$v=19$m=65536,t=3,p=1$c2FsdA$aGFzaA";
        const proxy = `$2a$14$${"x".repeat(53)}`;
        const file = join(dir, "compose-panel.env");
        for (const domain of ["", "panel.example.org"]) {
            const result = await shell(`
admin_user=operator42; admin_hash=$2; domain=$3; proxy_hash=$4
render_env > "$1"
COMPOSE_PANEL_SETUP_LIB=1 source "$5"
[ "$(env_value "$1" COMPOSE_PANEL_ADMIN_PASSWORD_HASH)" = "$2" ]
[ "$(env_value "$1" COMPOSE_PANEL_INSTALLER_PROXY_HASH)" = "$4" ]
cmp -s "$1" <(render_env)
`, [file, hash, domain, domain ? proxy : "", SETUP]);
            expect(result.code).toBe(0);
            const content = await readFile(file, "utf8");
            expect(content).toContain(`COMPOSE_PANEL_ADMIN_PASSWORD_HASH='${hash}'`);
            expect(content.includes("COMPOSE_PANEL_PROXY_ORIGINS=")).toBe(Boolean(domain));
            expect(content).toContain("COMPOSE_PANEL_ALLOW_LOOPBACK=true");
            expect(content).toContain("COMPOSE_PANEL_CADDY_ENABLED=true");
        }
    });

    test("Caddy keeps application imports and protects every panel route", async () => {
        const result = await shell('domain=panel.example.org; admin_user=operator42; proxy_hash=$1; render_caddy', ["$2a$hash"]);
        expect(result.code).toBe(0);
        expect(result.stdout).toContain("import /etc/caddy/compose-panel.d/*.caddy");
        expect(result.stdout).toContain("basic_auth {\n        operator42 $2a$hash");
        expect(result.stdout).toContain("reverse_proxy 127.0.0.1:5081");
        const privateConfig = await shell('domain=""; render_caddy');
        expect(privateConfig.code).toBe(0);
        expect(privateConfig.stdout).not.toContain("reverse_proxy");
    });

    test("new secrets are 0600 and a second publication never overwrites them", async () => {
        const source = join(dir, "source");
        const target = join(dir, "target");
        await writeFile(source, "original");
        expect((await shell('publish_new "$1" "$2" 0600', [source, target])).code).toBe(0);
        expect((await stat(target)).mode & 0o777).toBe(0o600);
        await writeFile(source, "replacement");
        expect((await shell('publish_new "$1" "$2" 0600', [source, target])).code).not.toBe(0);
        expect(await readFile(target, "utf8")).toBe("original");
        await mkdir(join(dir, "directory"));
        expect((await shell('publish_new "$1" "$2" 0600', [source, join(dir, "directory")])).code).not.toBe(0);
    });

    test("symlinked destinations, dangling links and symlinked parents are refused", async () => {
        const source = join(dir, "source");
        await writeFile(source, "fixture");
        await mkdir(join(dir, "real"));
        await symlink(join(dir, "real"), join(dir, "link"));
        await symlink(join(dir, "absent"), join(dir, "dangling"));
        for (const target of [join(dir, "link", "new"), join(dir, "dangling")]) {
            expect((await shell('publish_new "$1" "$2" 0600', [source, target])).code).not.toBe(0);
        }
        expect(await Bun.file(join(dir, "real", "new")).exists()).toBe(false);
        expect(await Bun.file(join(dir, "absent")).exists()).toBe(false);
    });

    // Real subprocess boundary, fake executable: safe on Linux CI and macOS.
    // No command can connect to a daemon, and all files stay in this fixture.
    test("password hashing sends exact stdin without secrets in argv or environment", async () => {
        const executable = join(dir, "docker");
        await writeFile(executable, `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$@" > "$FIXTURE/args"
env > "$FIXTURE/env"
cat > "$FIXTURE/input"
printf '$argon2id$fixture\\n'
`);
        await chmod(executable, 0o700);
        // macOS has no timeout(1); this one only drops its own options.
        await writeFile(join(dir, "timeout"), '#!/usr/bin/env bash\nwhile [ "${1#--}" != "$1" ]; do shift; done; shift; exec "$@"\n');
        await chmod(join(dir, "timeout"), 0o700);
        const password = "secret '$()\\\t never-an-argument";
        const result = await shell(`
export FIXTURE=$1 PATH="$1:$PATH"
IMAGE=ghcr.io/lekoala/compose-panel:latest
hash_admin_password
`, [dir], password);
        expect(result.code).toBe(0);
        expect(await readFile(join(dir, "input"), "utf8")).toBe(password);
        const args = await readFile(join(dir, "args"), "utf8");
        expect(args).not.toContain(password);
        expect(await readFile(join(dir, "env"), "utf8")).not.toContain(password);
        expect(args.split("\n").slice(0, 8)).toEqual(["run", "--rm", "-i", "--network", "none", "--entrypoint", "bun", "ghcr.io/lekoala/compose-panel:latest"]);
        expect(result.stderr).not.toContain(password);
    });
});

// The real setup-caddy.sh and with-caddy-lock.sh functions (GNU mv -T, md5sum),
// with fake timeout/runuser/systemd-run/systemctl/dpkg-query executables.
// Every path is inside the fixture; nothing touches the host Caddy or systemd.
const FAKES: Record<string, string> = {
    "timeout": 'while [ "${1#--}" != "$1" ]; do shift; done; shift; exec "$@"',
    "runuser": '[ "$FAIL" != validate ]',
    "systemd-run": '[ "$FAIL" != validate ]',
    "systemctl": `n=$(( $(cat "$FIXTURE/calls" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$FIXTURE/calls"
[ "$FAIL" != rollback ] && { [ "$FAIL" != reload ] || [ "$n" -gt 1 ]; }`,
    "dpkg-query": `case "$*" in
    *Status*) printf 'install ok installed' ;;
    *Conffiles*) printf ' %s %s%s\\n' "$CADDYFILE" "$SUM" "\${OBSOLETE:+ obsolete}" ;;
esac`,
    "chown": 'printf \'%s\\n\' "$*" >> "$FIXTURE/chown"',
};
const DOCTOR = fileURLToPath(new URL("../scripts/doctor.sh", import.meta.url));

describe.skipIf(process.platform !== "linux")("Ubuntu installer Caddy steps", () => {
    let dir: string;
    let caddyfile: string;
    beforeEach(async () => {
        dir = await realpath(await mkdtemp(join(tmpdir(), "cp-install-caddy-")));
        caddyfile = join(dir, "Caddyfile");
        await mkdir(join(dir, "bin"));
        await mkdir(join(dir, "managed"));
        for (const [name, body] of Object.entries(FAKES)) {
            await writeFile(join(dir, "bin", name), `#!/usr/bin/env bash\n${body}\n`);
            await chmod(join(dir, "bin", name), 0o755);
        }
        await writeFile(caddyfile, "original\n");
    });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    function run(command: string, env: Record<string, string> = {}) {
        return shell(`
export FIXTURE=$1 PATH="$1/bin:$PATH" CADDYFILE=$1/Caddyfile
COMPOSE_PANEL_SETUP_LIB=1 source "$2"
COMPOSE_PANEL_CADDY_LOCK_LIB=1 CADDY_MANAGED_DIR="$1/managed" source "$3"
CADDYFILE=$1/Caddyfile MANAGED_DIR=$1/managed
export FAIL=\${FAIL:-} SUM=\${SUM:-} OBSOLETE=\${OBSOLETE:-}
${command}`, [dir, SETUP, LOCK], "", env);
    }

    for (const [failure, code] of [["none", 0], ["validate", 1], ["reload", 1], ["rollback", 2]] as const) {
        test(`replacement with ${failure} failure keeps a readable original or candidate`, async () => {
            const result = await run('domain=""; write_caddy_candidate "$1/candidate"; replace_caddy "$1/candidate"',
                { FAIL: failure });
            expect(result.code).toBe(code);
            const content = await readFile(caddyfile, "utf8");
            if (failure === "none") expect(content).toContain("import /etc/caddy/compose-panel.d/*.caddy");
            else expect(content).toBe("original\n");
            // Only an unresolved rollback keeps the lock for the EXIT trap.
            expect(await Bun.file(join(dir, "managed", ".lock", "owner")).exists()).toBe(failure === "rollback");
        });
    }

    test("the published Caddyfile is readable by the caddy group only, whatever the umask", async () => {
        const result = await run('umask 077; domain=""; write_caddy_candidate "$1/candidate"; replace_caddy "$1/candidate"');
        expect(result.code).toBe(0);
        expect((await stat(caddyfile)).mode & 0o777).toBe(0o640);
        // As root, the Caddy lock is also chowned; only the candidate matters here.
        expect((await readFile(join(dir, "chown"), "utf8")).split("\n")).toContain(`root:caddy ${dir}/candidate`);
    });

    test("the Basic Auth password reaches Caddy as one stdin line, never in argv or environment", async () => {
        await writeFile(join(dir, "bin", "caddy"), `#!/usr/bin/env bash
printf '%s\\n' "$@" > "$FIXTURE/args"
env > "$FIXTURE/env"
cat > "$FIXTURE/input"
printf '$2a$14$fixture\\n'
`);
        await chmod(join(dir, "bin", "caddy"), 0o755);
        const password = "proxy '$()\\\t secret";
        // Read from a fixture file: the password must not be a process argument here either.
        await writeFile(join(dir, "pw"), password);
        const hashed = await run(`proxy_password="$(cat "$1/pw")"; hash_proxy_password`);
        expect(hashed.code).toBe(0);
        expect(hashed.stdout).toBe("$2a$14$fixture\n");
        expect(await readFile(join(dir, "input"), "utf8")).toBe(`${password}\n`);
        expect(await readFile(join(dir, "args"), "utf8")).toBe("hash-password\n");
        expect(await readFile(join(dir, "env"), "utf8")).not.toContain(password);
    });

    test("an identical file left by an interrupted run is accepted, a different one never", async () => {
        const target = join(dir, "target");
        await writeFile(join(dir, "source"), "key");
        expect((await run('publish_same "$1/source" "$1/target" 0644')).code).toBe(0);
        expect(await readFile(target, "utf8")).toBe("key");
        expect((await run('publish_same "$1/source" "$1/target" 0644')).code).toBe(0);
        await writeFile(target, "foreign");
        expect((await run('publish_same "$1/source" "$1/target" 0644')).code).not.toBe(0);
        expect(await readFile(target, "utf8")).toBe("foreign");
    });

    test("an APT repository resumes only from the installer's own files", async () => {
        // No apt/sources.list on purpose: a missing input must not hide a match.
        const lists = join(dir, "apt", "sources.list.d");
        await mkdir(lists, { recursive: true });
        const check = 'apt_repo_resumable "$1/apt" "download\\.docker\\.com" "$1/apt/keyrings/docker.asc" "$1/apt/sources.list.d/docker.sources"';
        expect((await run(check)).code).toBe(0);
        await writeFile(join(lists, "docker.sources"), "URIs: https://download.docker.com/linux/ubuntu\n");
        expect((await run(check)).code).toBe(0);
        await writeFile(join(lists, "admin.list"), "deb https://download.docker.com/linux/ubuntu noble stable\n");
        expect((await run(check)).code).not.toBe(0);
        await rm(join(lists, "admin.list"));
        await mkdir(join(dir, "apt", "keyrings"));
        await symlink(join(dir, "elsewhere"), join(dir, "apt", "keyrings", "docker.asc"));
        expect((await run(check)).code).not.toBe(0);
        await rm(join(dir, "apt", "keyrings", "docker.asc"));
        expect((await run(check)).code).toBe(0);
        // APT follows symlinked sources, so must this check; a dangling one is an error, not "no match".
        await writeFile(join(dir, "foreign.list"), "deb https://download.docker.com/linux/ubuntu noble stable\n");
        await symlink(join(dir, "foreign.list"), join(lists, "linked.list"));
        expect((await run(check)).code).not.toBe(0);
        await rm(join(lists, "linked.list"));
        await symlink(join(dir, "missing.list"), join(lists, "dangling.list"));
        expect((await run(check)).code).not.toBe(0);
    });

    test("a rerun restricts the installer's existing Caddyfile to the caddy group", async () => {
        await chmod(caddyfile, 0o644);
        const result = await run("secure_owned_caddyfile");
        expect(result.code).toBe(0);
        expect((await stat(caddyfile)).mode & 0o777).toBe(0o640);
        expect((await readFile(join(dir, "chown"), "utf8")).split("\n")).toContain(`root:caddy ${caddyfile}`);
    });

    test("a failed helper backup is never kept as the rollback source", async () => {
        const helper = join(dir, "helper");
        await writeFile(helper, "working binary");
        const ok = await run("HELPER_BIN=$1/helper; backup_helper");
        expect(ok.code).toBe(0);
        expect(await readFile(ok.stdout.trim(), "utf8")).toBe("working binary");
        await writeFile(join(dir, "bin", "cp"), "#!/usr/bin/env bash\n: > \"${@: -1}\"\nexit 1\n");
        await chmod(join(dir, "bin", "cp"), 0o755);
        await rm(ok.stdout.trim());
        const failed = await run("HELPER_BIN=$1/helper; backup_helper");
        expect(failed.code).not.toBe(0);
        expect(failed.stdout).toBe("");
        expect((await Array.fromAsync(new Bun.Glob("helper.bak-*").scan(dir)))).toEqual([]);
        expect(await readFile(helper, "utf8")).toBe("working binary");
    });

    test("a checkout writable by other users is refused before anything is sourced", async () => {
        const repo = join(dir, "repo");
        for (const sub of ["scripts", "deploy/caddy"]) await mkdir(join(repo, sub), { recursive: true });
        const files = ["scripts/install.sh", "scripts/setup-caddy.sh", "deploy/caddy/with-caddy-lock.sh",
            "deploy/caddy/caddy-helper.socket", "deploy/caddy/caddy-helper@.service", "deploy/compose.prod.yaml"];
        for (const file of files) {
            await writeFile(join(repo, file), "fixture\n");
            await chmod(join(repo, file), 0o644);
        }
        for (const path of [repo, join(repo, "scripts"), join(repo, "deploy"), join(repo, "deploy/caddy")]) {
            await chmod(path, 0o755);
        }
        const uid = String(process.getuid?.());
        const check = 'trusted_checkout "$1/repo"';
        expect((await run(check, { SUDO_UID: uid })).code).toBe(0);
        // Owned by the test user: only root or that sudo user is trusted.
        if (uid !== "0") expect((await run(check, { SUDO_UID: "54321" })).code).not.toBe(0);
        await chmod(join(repo, "scripts/setup-caddy.sh"), 0o646);
        expect((await run(check, { SUDO_UID: uid })).code).not.toBe(0);
        await chmod(join(repo, "scripts/setup-caddy.sh"), 0o644);
        await chmod(join(repo, "deploy"), 0o757);
        expect((await run(check, { SUDO_UID: uid })).code).not.toBe(0);
        await chmod(join(repo, "deploy"), 0o755);
        await rm(join(repo, "deploy/compose.prod.yaml"));
        await symlink(join(dir, "elsewhere"), join(repo, "deploy/compose.prod.yaml"));
        expect((await run(check, { SUDO_UID: uid })).code).not.toBe(0);
    });

    for (const [proxyHash, failures] of [["", "0"], ["$2a$14$fixture", "1"]] as const) {
        test(`doctor ${proxyHash ? "requires the installer Basic Auth" : "accepts a login page"} on HTTPS`, async () => {
            await writeFile(join(dir, "bin", "curl"), "#!/usr/bin/env bash\nprintf 200\n");
            await chmod(join(dir, "bin", "curl"), 0o755);
            await writeFile(join(dir, "panel.env"),
                `COMPOSE_PANEL_PROXY_ORIGINS=https://panel.example.org\nCOMPOSE_PANEL_INSTALLER_PROXY_HASH='${proxyHash}'\n`);
            const result = await run(`COMPOSE_PANEL_DOCTOR_LIB=1 source "$DOCTOR"
ENV_FILE=$1/panel.env doctor_failures=0 doctor_unverified=0
doctor_https >/dev/null
printf '%s' "$doctor_failures"`, { DOCTOR });
            expect(result.code).toBe(0);
            expect(result.stdout).toBe(failures);
        });
    }

    for (const running of [true, false]) {
        test(`a rerun ${running ? "leaves a running" : "starts a stopped"} panel without recreating it`, async () => {
            await writeFile(join(dir, "bin", "docker"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FIXTURE/docker-calls"
[ "$1" != inspect ] || printf '%s\\n' "$RUNNING"
`);
            await chmod(join(dir, "bin", "docker"), 0o755);
            const result = await run("start_existing_panel", { RUNNING: String(running) });
            expect(result.code).toBe(0);
            const calls = (await readFile(join(dir, "docker-calls"), "utf8")).trim().split("\n");
            expect(calls.slice(1)).toEqual(running ? [] : ["start compose-panel"]);
        });
    }

    test("only the unmodified packaged Caddyfile can be resumed", async () => {
        const sum = new Bun.CryptoHasher("md5").update("original\n").digest("hex");
        expect((await run("packaged_caddyfile", { SUM: sum })).code).toBe(0);
        expect((await run("packaged_caddyfile", { SUM: sum, OBSOLETE: "1" })).code).not.toBe(0);
        expect((await run("packaged_caddyfile", { SUM: "0".repeat(32) })).code).not.toBe(0);
        await writeFile(caddyfile, "original\nexample.org { respond hi }\n");
        expect((await run("packaged_caddyfile", { SUM: sum })).code).not.toBe(0);
    });
});
