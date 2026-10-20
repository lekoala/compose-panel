// Real preflight/dispatch, fake host commands. No host Docker or systemd access.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SCRIPT = join(ROOT, "scripts/install.sh");
const HASH = "$argon2id$v=19$m=65536,t=3,p=1$c2FsdA$aGFzaA";
const PROXY = `$2a$14$${"x".repeat(53)}`;
const IMAGE = "ghcr.io/lekoala/compose-panel:latest";
const FILES = ["scripts/install.sh", "scripts/setup-caddy.sh", "deploy/caddy/with-caddy-lock.sh",
    "deploy/caddy/caddy-helper.socket", "deploy/caddy/caddy-helper@.service", "deploy/compose.prod.yaml"];
const TOOLS: Record<string, string> = {
    uname: 'printf "%s\\n" "${KERNEL:-Linux}"',
    id: 'printf "%s\\n" "${ROOT_UID:-0}"',
    dpkg: '[ "$*" = --print-architecture ] || exit 97; printf "%s\\n" "${ARCH:-arm64}"',
    "dpkg-query": `case "$*" in
        *Conffiles*) printf ' %s %s\\n' "$HOST/etc/caddy/Caddyfile" "$PACKAGE_SUM" ;;
        *Status*) for package in $PACKAGES; do
            if [ "$package" = "\${@: -1}" ]; then printf 'install ok installed'; exit 0; fi
            done; exit 1 ;;
        *) exit 97 ;;
    esac`,
    getent: 'if [ "$*" = "group caddy" ]; then [ "${CADDY_GROUP:-1}" = 1 ]; else exec /usr/bin/getent "$@"; fi',
    stat: `if [ "$2" = '%u %a' ] && [ "$3" = "$REPO_FIXTURE/deploy/compose-panel.env" ]; then
        printf '%s %s\\n' "\${ENV_OWNER:-0}" "$(/usr/bin/stat -c '%a' "$3")"
    else exec /usr/bin/stat "$@"; fi`,
    ss: `case "$*" in *5081*) key=panel ;; *-lun*) key=udp ;; *) key=tcp ;; esac
    [ "$SS_ERROR" != "$key" ] || exit 1
    [ "$BUSY" != "$key" ] || printf 'LISTEN fixture\\n'`,
    docker: `case "$1" in
        info) [ "$DOCKER_ERROR" != info ] ;;
        version) printf '29.9.0\\n' ;;
        compose) [ "$*" = 'compose version' ] && [ "$DOCKER_ERROR" != compose ] ;;
        ps) [ "$DOCKER_ERROR" != ps ] || exit 1
            case "$*" in *label=*) printf '%s' "$PROJECT_CONTAINERS" ;; *) printf '%s' "$NAMED_CONTAINER" ;; esac ;;
        inspect) [ "$DOCKER_ERROR" != inspect ] || exit 1
            [ "$1 $2" = 'inspect -f' ] || exit 97
            case "$3" in
                *project\\\"*) printf '%s' "$LABEL_PROJECT" ;;
                *service\\\"*) printf '%s' "$LABEL_SERVICE" ;;
                *working_dir*) printf '%s' "$LABEL_DIRECTORY" ;;
                *config_files*) printf '%s' "$LABEL_FILES" ;;
                *oneoff*) printf '%s' "$LABEL_ONEOFF" ;;
                *environment_file*) printf '%s' "$LABEL_ENV" ;;
                *Config.Image*) printf '%s' "$PANEL_IMAGE" ;;
                *) exit 97 ;;
            esac ;;
        *) printf 'FORBIDDEN docker\\n' >> "$CALLS"; exit 97 ;;
    esac`,
    caddy: '[ "$*" = version ] || exit 97; printf "%s\\n" "${CADDY_VERSION:-v2.8.4}"',
    systemctl: `case "$1" in
        is-active) [ "$CADDY_ACTIVE" = 1 ] ;;
        is-enabled) [ "$BOOT_ENABLED" = 1 ] ;;
        show) printf '%s\\n' "$CADDY_EXEC" ;;
        *) printf 'FORBIDDEN systemctl\\n' >> "$CALLS"; exit 97 ;;
    esac`,
    snap: '[ "$*" = "list docker" ] || exit 97; [ "$SNAP_DOCKER" = 1 ]',
    ufw: '[ "$*" = status ] || exit 97; printf "Status: inactive\\n"',
};
async function snapshot(root: string): Promise<unknown> {
    const entries: unknown[] = [];
    async function visit(path: string) {
        const s = await lstat(path);
        entries.push([path, s.mode, s.uid, s.gid, s.mtimeMs,
            s.isSymbolicLink() ? await readlink(path) : s.isFile() ? await readFile(path, "utf8") : null]);
        if (s.isDirectory()) for (const name of (await readdir(path)).sort()) await visit(join(path, name));
    }
    await visit(root); return entries;
}

describe.skipIf(process.platform !== "linux")("complete installer preflight (isolated fixtures)", () => {
    let dir: string, host: string, repo: string, bin: string;
    let env: Record<string, string>;
    let socket: Server | undefined;
    async function file(path: string, text: string, mode = 0o644) {
        await mkdir(dirname(path), { recursive: true }); await writeFile(path, text, { mode });
    }
    async function tool(name: string, body = TOOLS[name]!) {
        await file(join(bin, name), `#!/bin/bash\nprintf '%s\\t%s\\n' '${name}' "$*" >> "$CALLS"\n${body}\n`, 0o755);
    }
    beforeEach(async () => {
        dir = await realpath(await mkdtemp(join(tmpdir(), "cp-preflight-")));
        host = join(dir, "host"); repo = join(dir, "repo"); bin = join(dir, "bin");
        await mkdir(bin);
        for (const path of FILES) {
            await mkdir(dirname(join(repo, path)), { recursive: true });
            await copyFile(join(ROOT, path), join(repo, path)); await chmod(join(repo, path), 0o644);
        }
        await file(join(host, "etc/os-release"), 'ID=ubuntu\nVERSION_ID=24.04\nVERSION_CODENAME=noble\n');
        await mkdir(join(host, "run/systemd/system"), { recursive: true });
        // No PATH fallback: absent Docker/Caddy/ss cannot resolve to host tools.
        for (const name of ["bash", "dirname", "cut", "awk", "wc", "sed", "tail", "tr", "cmp", "grep", "find", "md5sum", "head", "timeout", "cat"]) {
            await symlink(Bun.which(name)!, join(bin, name));
        }
        for (const name of Object.keys(TOOLS).filter(name => !["docker", "caddy", "snap"].includes(name))) await tool(name);
        for (const name of ["apt-get", "curl", "gpg", "install", "chmod", "chown", "mv", "cp", "rm", "mkdir", "mktemp", "flock", "systemd-run"]) {
            await tool(name, 'printf "FORBIDDEN mutation\\n" >> "$CALLS"; exit 97');
        }
        env = { PATH: bin, HOST: host, REPO_FIXTURE: repo, CALLS: join(dir, "calls"),
            LOCK_FIXTURE: join(dir, "install.lock"), HOLD_LOCK: "0", ALLOW_APPLY: "0",
            SUDO_UID: String(process.getuid!()), SUDO_GID: String(process.getgid!()),
            PACKAGES: "", PACKAGE_SUM: "", SS_ERROR: "", BUSY: "", DOCKER_ERROR: "", PROJECT_CONTAINERS: "", NAMED_CONTAINER: "",
            LABEL_PROJECT: "compose-panel", LABEL_SERVICE: "panel", LABEL_DIRECTORY: `${repo}/deploy`,
            LABEL_FILES: `${repo}/deploy/compose.prod.yaml`, LABEL_ONEOFF: "False", LABEL_ENV: "", PANEL_IMAGE: IMAGE,
            CADDY_ACTIVE: "1", BOOT_ENABLED: "1", CADDY_EXEC: `caddy run --config ${host}/etc/caddy/Caddyfile`, SNAP_DOCKER: "0" };
    });
    afterEach(async () => {
        if (socket) { await new Promise<void>(resolve => socket!.close(() => resolve())); socket = undefined; }
        await rm(dir, { recursive: true, force: true });
    });
    async function run(expected = 0, args = ["--check"], state = [0, 0, 0, 0]) {
        const before = await Promise.all([snapshot(host), snapshot(repo)]);
        const proc = Bun.spawn(["/bin/bash", "-c", `source "$1"
installer_prepare() {
    check_installer_host "$HOST/etc/os-release" "$HOST/run/systemd/system"
    load_installer_checkout "$REPO_FIXTURE"
    LOG="$HOST/var/log/compose-panel-install.log"
    LOCK_FILE="$LOCK_FIXTURE"
    inspection_root="$HOST"
}
# Another installer: a separate open file description holding the lock.
if [ "$HOLD_LOCK" = 1 ]; then exec 8>"$LOCK_FIXTURE"; /usr/bin/flock -n 8; fi
# A dispatch regression must fail before entering privileged installation code.
installer_apply() {
    if [ "$ALLOW_APPLY" = 1 ]; then printf 'apply\\n' >> "$CALLS"; return 0; fi
    printf 'FORBIDDEN apply\\n' >> "$CALLS"; return 97
}
shift
installer_main "$@"
printf 'STATE %s %s %s %s\\n' "$have_docker" "$have_panel" "$have_caddy" "$caddy_owned"
`, "fixture", SCRIPT, ...args], {
            env: { ...env, COMPOSE_PANEL_INSTALL_LIB: "1" }, stdout: "pipe", stderr: "pipe", stdin: "ignore",
        });
        const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
        expect({ code, stderr: code === expected ? "" : stderr }).toEqual({ code: expected, stderr: "" });
        expect(await Promise.all([snapshot(host), snapshot(repo)])).toEqual(before);
        const calls = await Bun.file(env.CALLS!).exists() ? await readFile(env.CALLS!, "utf8") : "";
        expect(calls).not.toContain("FORBIDDEN");
        for (const secret of [HASH, PROXY]) expect(`${stdout}${stderr}${calls}`).not.toContain(secret);
        if (expected === 0) expect(stdout).toContain(`STATE ${state.join(" ")}`);
        return calls;
    }
    async function credentials(https = false) {
        await file(join(repo, "deploy/compose-panel.env"), [
            "# Compose Panel installer v1 (ADR 0031)", "COMPOSE_PANEL_ADMIN_USER=operator42",
            `COMPOSE_PANEL_ADMIN_PASSWORD_HASH='${HASH}'`, "COMPOSE_PANEL_ALLOW_LOOPBACK=true",
            ...(https ? ["COMPOSE_PANEL_PROXY_ORIGINS=https://panel.example.org"] : []),
            `COMPOSE_PANEL_INSTALLER_PROXY_HASH='${https ? PROXY : ""}'`, "COMPOSE_PANEL_CADDY_ENABLED=true",
            "COMPOSE_PANEL_CADDY_SOCKET_PATH=/run/compose-panel/caddy-helper.sock", "",
        ].join("\n"), 0o600);
    }
    async function docker(panel = false) {
        await tool("docker"); env.PACKAGES = "docker-ce docker-compose-plugin";
        await mkdir(join(host, "var/run"), { recursive: true }); socket = createServer();
        await new Promise<void>(resolve => socket!.listen(join(host, "var/run/docker.sock"), resolve));
        if (panel) { await credentials(); env.PROJECT_CONTAINERS = env.NAMED_CONTAINER = "compose-panel"; }
    }
    async function caddy(owned = false, https = false) {
        await tool("caddy"); env.PACKAGES += " caddy";
        let content = "# package welcome page\n:80 { respond welcome }\n";
        if (owned) {
            await credentials(https);
            content = "# Compose Panel installer v1 (ADR 0031)\nimport /etc/caddy/compose-panel.d/*.caddy\n";
            if (https) content = `${content}\npanel.example.org {\n    basic_auth {\n        operator42 ${PROXY}\n    }\n    reverse_proxy 127.0.0.1:5081\n}\n`;
        }
        await file(join(host, "etc/caddy/Caddyfile"), content, 0o640);
        if (!owned) env.PACKAGE_SUM = new Bun.CryptoHasher("md5").update(content).digest("hex");
    }
    for (const [release, codename] of [["24.04", "noble"], ["26.04", "resolute"]]) {
        for (const arch of ["amd64", "arm64"]) test(`fresh Ubuntu ${release}/${arch}: check and yes never install`, async () => {
            await file(join(host, "etc/os-release"), `ID=ubuntu\nVERSION_ID=${release}\nVERSION_CODENAME=${codename}\n`);
            env.ARCH = arch; await run(0, ["--check", "--yes"]);
        });
    }
    for (const [key, value] of [["KERNEL", "Darwin"], ["ROOT_UID", "1000"], ["ARCH", "armhf"]]) {
        test(`unsupported host ${key} is refused`, async () => { env[key!] = value!; await run(1); });
    }
    for (const release of ['ID=debian\nVERSION_ID=24.04\nVERSION_CODENAME=noble\n',
        'ID=ubuntu\nVERSION_ID=22.04\nVERSION_CODENAME=jammy\n', 'ID=ubuntu\nVERSION_ID=26.04\nVERSION_CODENAME=noble\n']) {
        test(`unsupported OS metadata ${release.trim().replaceAll("\n", " ")}`, async () => {
            await file(join(host, "etc/os-release"), release); await run(1);
        });
    }
    test("an unbooted systemd host is refused", async () => { await rm(join(host, "run/systemd/system"), { recursive: true }); await run(1); });
    // The lock is outside the snapshotted trees; --check keeps the forbidden flock stub.
    async function realFlock() { await tool("flock", `exec ${Bun.which("flock")} "$@"`); }
    test("install takes the installer lock before probing the host", async () => {
        await realFlock(); env.ALLOW_APPLY = "1";
        const calls = await run(0, ["--install"]);
        expect(calls.indexOf("flock\t")).toBeGreaterThan(-1);
        expect(calls.indexOf("flock\t")).toBeLessThan(calls.indexOf("ss\t"));
        expect(calls).toContain("apply\n");
    });
    test("a running installer refuses another install before preflight", async () => {
        await realFlock(); env.HOLD_LOCK = "1"; env.ALLOW_APPLY = "1";
        const calls = await run(1, ["--install"]);
        expect(calls).toContain("flock\t");
        for (const probe of ["ss\t", "systemctl\t", "dpkg-query\t", "apply\n"]) expect(calls).not.toContain(probe);
    });
    test("check ignores a running installer and takes no lock", async () => { env.HOLD_LOCK = "1"; await run(); });
    test("unknown CLI option fails before probing", async () => { expect(await run(1, ["--force"])).toBe(""); });
    test("writable checkout refuses before sourcing setup", async () => { await chmod(join(repo, "scripts/setup-caddy.sh"), 0o666); await run(1); });
    test("missing production Compose file refuses", async () => { await rm(join(repo, "deploy/compose.prod.yaml")); await run(1); });
    test("implicit Compose interpolation refuses", async () => { await file(join(repo, "deploy/.env"), "COMPOSE_PROJECT_NAME=foreign\n"); await run(1); });
    for (const path of ["opt/stacks", "run/compose-panel", "etc/caddy/compose-panel.d", "var/log/compose-panel-install.log"]) {
        test(`wrong file type at ${path}`, async () => {
            if (path.endsWith(".log")) await mkdir(join(host, path), { recursive: true }); else await file(join(host, path), "foreign");
            await run(1);
        });
    }
    for (const path of ["etc/caddy", "etc/apt/keyrings", "usr/local/bin/compose-panel-caddy-helper", "etc/apt/apt.conf.d/52compose-panel-periodic"]) {
        test(`dangling symlink refuses at ${path}`, async () => {
            await mkdir(dirname(join(host, path)), { recursive: true }); await symlink(join(dir, "missing"), join(host, path)); await run(1);
        });
    }
    for (const busy of ["tcp", "udp", "panel"]) {
        test(`occupied ${busy} port refuses`, async () => { env.BUSY = busy; await run(1); });
        test(`failed ${busy} port inspection is not free`, async () => { env.SS_ERROR = busy; await run(1); });
    }
    test("missing ss refuses", async () => { await rm(join(bin, "ss")); await run(1); });
    for (const pkg of ["docker.io", "docker-compose", "docker-compose-v2", "docker-doc", "docker-buildx", "podman-docker", "containerd", "runc", "docker-ce"]) {
        test(`conflicting package ${pkg} is kept and refused`, async () => { env.PACKAGES = pkg; await run(1); });
    }
    test("snap binary outside PATH refuses", async () => { await file(join(host, "snap/bin/docker"), "fixture"); await run(1); });
    test("installed Docker snap refuses", async () => { await tool("snap"); env.SNAP_DOCKER = "1"; await run(1); });
    for (const kind of ["docker", "caddy"]) test(`foreign ${kind} APT source refuses`, async () => {
        await file(join(host, "etc/apt/sources.list.d/admin.list"), kind === "docker" ? "https://download.docker.com/linux/ubuntu" : "https://dl.cloudsmith.io/public/caddy/stable"); await run(1);
    });
    test("partial repositories are eligible for later byte comparison", async () => {
        await file(join(host, "etc/apt/keyrings/docker.asc"), "key");
        await file(join(host, "etc/apt/sources.list.d/docker.sources"), "URIs: https://download.docker.com/linux/ubuntu\n");
        await file(join(host, "etc/apt/sources.list.d/caddy-stable.list"), "https://dl.cloudsmith.io/public/caddy/stable\n"); await run();
    });
    for (const error of ["info", "compose", "ps", "inspect"]) test(`Docker ${error} error refuses`, async () => { await docker(true); env.DOCKER_ERROR = error; await run(1); });
    test("incomplete Docker packages refuse", async () => { await docker(); env.PACKAGES = "docker-ce"; await run(1); });
    test("missing local Docker socket refuses", async () => { await docker(); await rm(join(host, "var/run/docker.sock")); await run(1); });
    test("another container in the panel project refuses", async () => { await docker(); env.PROJECT_CONTAINERS = "other"; await run(1); });
    test("container disappearance during discovery refuses", async () => { await docker(); env.PROJECT_CONTAINERS = "compose-panel"; await run(1); });
    for (const label of ["LABEL_PROJECT", "LABEL_SERVICE", "LABEL_DIRECTORY", "LABEL_FILES", "LABEL_ONEOFF", "LABEL_ENV", "PANEL_IMAGE"]) {
        test(`foreign panel ${label} refuses`, async () => { await docker(true); env[label] = "foreign"; await run(1); });
    }
    test("same-name foreign container is inspected without our project label", async () => {
        await docker(true); env.PROJECT_CONTAINERS = ""; env.LABEL_PROJECT = "foreign"; await run(1);
    });
    test("panel without installer credentials refuses", async () => { await docker(true); await rm(join(repo, "deploy/compose-panel.env")); await run(1); });
    for (const https of [false, true]) test(`owned ${https ? "HTTPS" : "private"} deployment preserves credentials and app routes`, async () => {
        await docker(true); await caddy(true, https); env.BUSY = "panel";
        await file(join(host, "etc/caddy/compose-panel.d/app.caddy"), "# untouched app\n"); await run(0, ["--check"], [1, 1, 1, 1]);
    });
    for (const fault of ["permissions", "owner", "credentials", "origin", "proxy", "drift", "symlink"]) test(`env ${fault} refuses without revealing hashes`, async () => {
        await credentials(true); const path = join(repo, "deploy/compose-panel.env");
        if (fault === "permissions") await chmod(path, 0o644);
        else if (fault === "owner") env.ENV_OWNER = "12345";
        else if (fault === "symlink") { await rm(path); await symlink(join(dir, "missing"), path); }
        else {
            let text = await readFile(path, "utf8");
            if (fault === "credentials") text = text.replace(HASH, "invalid");
            if (fault === "origin") text = text.replace("https://panel.example.org", "http://panel.example.org");
            if (fault === "proxy") text = text.replace(PROXY, "invalid");
            if (fault === "drift") text += "CUSTOM=value\n";
            await writeFile(path, text);
        }
        await run(1);
    });
    test("packaged Caddy from a partial install can resume", async () => { await caddy(); await run(0, ["--check"], [0, 0, 1, 0]); });
    test("systemd ExecStart formatting with --config= is recognized", async () => {
        await caddy(); env.CADDY_EXEC = `{ path=/usr/bin/caddy ; argv[]=caddy run --environ --config=${host}/etc/caddy/Caddyfile ; ignore_errors=no }`;
        await run(0, ["--check"], [0, 0, 1, 0]);
    });
    for (const fault of ["foreign", "stopped", "config-path", "config-prefix", "old-version", "missing-group", "managed-routes"]) test(`existing Caddy ${fault} refuses`, async () => {
        await caddy();
        if (fault === "foreign") await file(join(host, "etc/caddy/Caddyfile"), "foreign\n");
        if (fault === "stopped") env.CADDY_ACTIVE = "0";
        if (fault === "config-path") env.CADDY_EXEC = "caddy run --config /elsewhere";
        if (fault === "config-prefix") env.CADDY_EXEC = `{ path=/usr/bin/caddy ; argv[]=caddy run --config ${host}/etc/caddy/Caddyfile.custom ; }`;
        if (fault === "old-version") env.CADDY_VERSION = "v2.7.6";
        if (fault === "missing-group") env.CADDY_GROUP = "0";
        if (fault === "managed-routes") await file(join(host, "etc/caddy/compose-panel.d/app.caddy"), "foreign\n");
        await run(1);
    });
    test("failed route scan is not treated as empty", async () => {
        await caddy(); await mkdir(join(host, "etc/caddy/compose-panel.d")); await rm(join(bin, "find")); await tool("find", "exit 1"); await run(1);
    });
    test("incomplete Caddy package refuses", async () => { env.PACKAGES = "caddy"; await run(1); });
    test("orphan app routes refuse", async () => { await file(join(host, "etc/caddy/compose-panel.d/app.caddy"), "foreign\n"); await run(1); });
    test("disabled boot services only warn and remain unchanged", async () => {
        await docker(true); await caddy(true); env.BOOT_ENABLED = "0"; await run(0, ["--check"], [1, 1, 1, 1]);
    });
    for (const unit of ["caddy-helper.socket", "caddy-helper@.service"]) test(`foreign helper ${unit} refuses`, async () => {
        await file(join(host, `etc/systemd/system/${unit}`), "foreign\n"); await run(1);
    });
    test("matching helper units and an orphan executable can resume", async () => {
        for (const unit of ["caddy-helper.socket", "caddy-helper@.service"]) await file(join(host, `etc/systemd/system/${unit}`), await readFile(join(repo, `deploy/caddy/${unit}`), "utf8"));
        await file(join(host, "usr/local/bin/compose-panel-caddy-helper"), "fixture", 0o755); await run();
        await rm(join(host, "etc/systemd/system"), { recursive: true }); await run();
    });
    test("nonexecutable helper refuses", async () => { await file(join(host, "usr/local/bin/compose-panel-caddy-helper"), "fixture"); await run(1); });
    test("update policy without package refuses", async () => { await file(join(host, "etc/apt/apt.conf.d/52compose-panel-periodic"), "fixture"); await run(1); });
    test("admin update policy is only read", async () => { env.PACKAGES = "unattended-upgrades"; await file(join(host, "etc/apt/apt.conf.d/52compose-panel-periodic"), "admin policy"); await run(); });
});
