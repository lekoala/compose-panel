/**
 * Local preview: the real panel with demo stacks and a simulated Docker.
 *
 *   bun run preview            # http://127.0.0.1:5081, sign in as admin / preview
 *   bun run preview --reset    # recreate the demo stacks
 *   PORT=5090 bun run preview
 *
 * Nothing real is touched: no Docker command runs, no daemon is contacted.
 * Docker answers come from the in-memory simulation below (`compose ls`, `ps`,
 * `config`, actions with streamed output, live logs), so every page, action
 * and stream can be tried on Windows or Linux without Docker. Demo stacks live
 * in `.preview/` (git-ignored); edits there persist until `--reset`.
 * This is a development tool: it is not shipped in the image.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createApp } from "../src/app.ts";
import { createComposeProvider } from "../src/compose-provider.ts";
import { loadConfig } from "../src/config.ts";
import type { CommandResult, DockerRunner, RunOptions } from "../src/docker.ts";
import { resolveRoot } from "../src/stacks.ts";

const PASSWORD = "preview";
const root = join(import.meta.dir, "..", ".preview");
const stacksDir = join(root, "stacks");

const DEMO: Record<string, string> = {
    web: `# Public website: a web server, a cache and a one-shot migration job.
services:
  app:
    image: nginx:1.27-alpine
    ports:
      - "8080:80"
    healthcheck:
      test: ["CMD", "wget", "-q", "-O-", "http://localhost"]
  cache:
    image: redis:7
  migrate:
    image: alpine:3.20
    command: ["echo", "migrations done"]
`,
    db: `services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
`,
    worker: `# Not deployed yet: try Up.
services:
  worker:
    image: busybox
    command: ["sh", "-c", "while true; do date; sleep 5; done"]
`,
};

if (process.argv.includes("--reset")) await rm(root, { recursive: true, force: true });
for (const [name, compose] of Object.entries(DEMO)) {
    const dir = join(stacksDir, name);
    if (existsSync(join(dir, "compose.yaml"))) continue;
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "compose.yaml"), compose);
    if (name === "db") await writeFile(join(dir, ".env"), "POSTGRES_PASSWORD=change-me\n");
}
const stacksRoot = await resolveRoot(stacksDir);

// ---- Simulated Docker -------------------------------------------------------
// A tiny model of the engine: images (with OCI labels), local tags, newer tags
// "in the registry", and containers. Pull moves local tags to the registry's
// newer images; Up recreates containers whose tag changed. That is enough to
// show "Update ready: from → to" with a release notes link.

interface Image { id: string; created: string; labels: Record<string, string> }
interface Service { name: string; image: string; imageId: string; state: "running" | "exited"; exitCode: number; health: string }

const images = new Map<string, Image>();
function image(fill: string, version: string | null, created: string, labels: Record<string, string> = {}): string {
    const id = `sha256:${fill.repeat(64)}`;
    images.set(id, { id, created, labels: version ? { ...labels, "org.opencontainers.image.version": version } : labels });
    return id;
}
const NGINX_SOURCE = { "org.opencontainers.image.source": "https://github.com/nginxinc/docker-nginx" };
const localTags = new Map<string, string>([
    ["nginx:1.27-alpine", image("a", "1.27.1", "2026-08-14T09:00:00Z", NGINX_SOURCE)],
    ["redis:7", image("c", null, "2026-08-02T12:00:00Z")],
    ["alpine:3.20", image("e", "3.20.3", "2026-07-20T08:00:00Z")],
    ["postgres:16", image("f", "16.4", "2026-08-08T10:00:00Z")],
]);
const registry = new Map<string, string>([
    ["nginx:1.27-alpine", image("b", "1.27.2", "2026-10-02T09:00:00Z", NGINX_SOURCE)],
    ["redis:7", image("d", null, "2026-09-28T12:00:00Z")],
    ["alpine:3.20", localTags.get("alpine:3.20")!],
    ["postgres:16", localTags.get("postgres:16")!],
    ["busybox", image("9", "1.37.0", "2026-09-01T00:00:00Z")],
]);

function container(ref: string, name: string, state: Service["state"] = "running", exitCode = 0, health = ""): Service {
    return { name, image: ref, imageId: localTags.get(ref)!, state, exitCode, health };
}
const projects = new Map<string, Service[]>([
    ["web", [
        container("nginx:1.27-alpine", "app", "running", 0, "healthy"),
        container("redis:7", "cache"),
        container("alpine:3.20", "migrate", "exited", 0),
    ]],
    ["db", [container("postgres:16", "postgres", "exited", 137)]],
]);

/**
 * Containers outside the demo stacks, so the Containers page, the home
 * "Other containers" section and Server's "Needs attention" have something to
 * show: two from a Compose project the panel does not manage, three standalone.
 */
interface OtherContainer {
    id: string;
    name: string;
    image: string;
    state: "running" | "exited" | "restarting";
    status: string;
    health: string;
    exitCode: number;
    ports: string;
    restart: string;
    project: string;
    service: string;
    configFiles: string;
    workingDir: string;
}
const others: OtherContainer[] = [
    { id: `e1${"0".repeat(62)}`, name: "monitoring-grafana-1", image: "grafana/grafana:11.2.0", state: "running", status: "Up 3 days (healthy)", health: "healthy", exitCode: 0, ports: "127.0.0.1:3000->3000/tcp", restart: "unless-stopped", project: "monitoring", service: "grafana", configFiles: "/srv/monitoring/compose.yaml", workingDir: "/srv/monitoring" },
    { id: `e2${"0".repeat(62)}`, name: "monitoring-prometheus-1", image: "prom/prometheus:v2.54.1", state: "running", status: "Up 3 days", health: "none", exitCode: 0, ports: "9090/tcp", restart: "unless-stopped", project: "monitoring", service: "prometheus", configFiles: "/srv/monitoring/compose.yaml", workingDir: "/srv/monitoring" },
    { id: `e3${"0".repeat(62)}`, name: "caddy", image: "caddy:2.8", state: "running", status: "Up 12 days", health: "none", exitCode: 0, ports: "0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp", restart: "always", project: "", service: "", configFiles: "", workingDir: "" },
    { id: `e4${"0".repeat(62)}`, name: "nightly-backup", image: "restic/restic:0.17.0", state: "exited", status: "Exited (1) 6 hours ago", health: "none", exitCode: 1, ports: "", restart: "no", project: "", service: "", configFiles: "", workingDir: "" },
    { id: `e5${"0".repeat(62)}`, name: "flaky-worker", image: "busybox", state: "restarting", status: "Restarting (2) 10 seconds ago", health: "none", exitCode: 2, ports: "", restart: "on-failure", project: "", service: "", configFiles: "", workingDir: "" },
];

function otherListLine(other: OtherContainer): string {
    return [
        other.id, other.name, other.image, other.state, other.status, other.health,
        "2026-10-01T06:00:00Z", other.state === "exited" ? "6 hours ago" : "3 days ago", other.ports,
        other.project, other.service, other.configFiles, other.workingDir,
    ].map(field => JSON.stringify(field)).join("\t");
}

function otherInspect(other: OtherContainer): object {
    const [, host, hostPort, port] = /^(?:([\d.]+):(\d+)->)?(\d+\/tcp)/.exec(other.ports) ?? [];
    const labels: Record<string, string> = other.project
        ? { "com.docker.compose.project": other.project, "com.docker.compose.service": other.service, "com.docker.compose.project.config_files": other.configFiles, "com.docker.compose.project.working_dir": other.workingDir }
        : {};
    return {
        Id: other.id,
        Name: `/${other.name}`,
        Image: `sha256:${other.id.split("").reverse().join("")}`,
        Created: "2026-10-01T06:00:00Z",
        Config: { Image: other.image, Labels: labels, Env: ["SECRET=never shown"] },
        State: {
            Status: other.state, Running: other.state === "running", Paused: false, Restarting: other.state === "restarting",
            ExitCode: other.exitCode, StartedAt: "2026-10-09T06:00:00Z", FinishedAt: other.state === "exited" ? "2026-10-12T00:00:00Z" : "0001-01-01T00:00:00Z",
            ...(other.health !== "none" ? { Health: { Status: other.health } } : {}),
        },
        HostConfig: { RestartPolicy: { Name: other.restart } },
        NetworkSettings: { Ports: port ? { [port]: host ? [{ HostIp: host, HostPort: hostPort }] : null } : {} },
        Mounts: other.project ? [{ Type: "bind", Source: `${other.workingDir}/data`, Destination: "/data", RW: true }] : [],
    };
}

const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "", timedOut: false, truncated: false });
const fail = (stderr: string): CommandResult => ({ code: 1, stdout: "", stderr, timedOut: false, truncated: false });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function arg(args: string[], flag: string): string | undefined {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
}

/** Services and their `image:` from the top-level `services:` block (two-space indent). */
async function servicesOf(composeFile: string): Promise<{ name: string; image: string | null }[]> {
    const text = await readFile(composeFile, "utf8").catch(() => "");
    const block = text.split(/^services:\s*$/m)[1] ?? "";
    const result: { name: string; image: string | null }[] = [];
    for (const line of block.split(/\r?\n/)) {
        const service = /^ {2}([A-Za-z0-9_.-]+):/.exec(line);
        if (service) result.push({ name: service[1]!, image: null });
        const ref = /^ {4}image:\s*["']?([^"'\s]+)/.exec(line);
        if (ref && result.length > 0) result[result.length - 1]!.image = ref[1]!;
    }
    return result;
}

function projectStatus(services: Service[]): string {
    const running = services.filter(service => service.state === "running").length;
    const exited = services.length - running;
    return [running ? `running(${running})` : "", exited ? `exited(${exited})` : ""].filter(Boolean).join(", ");
}

function containerNameOf(project: string, service: string): string {
    return `${project}-${service}-1`;
}

/** Deterministic pseudo-value so the simulated stats are stable across reloads. */
function pseudo(text: string, salt: number): number {
    let hash = salt >>> 0;
    for (let index = 0; index < text.length; index++) hash = (Math.imul(hash, 31) + text.charCodeAt(index)) >>> 0;
    return hash;
}

function humanBytes(bytes: number): string {
    const units = ["B", "KiB", "MiB", "GiB", "TiB"];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)}${units[unit]}`;
}

function inspect(ref: string): object | null {
    const found = images.get(ref) ?? images.get(localTags.get(ref) ?? "");
    if (!found) return null;
    const tags = [...localTags].filter(([, id]) => id === found.id).map(([tag]) => tag);
    const repo = (tags[0] ?? ref).replace(/:[^/]*$/, "");
    const digest = found.id.slice(7).split("").reverse().join("");
    return { Id: found.id, RepoTags: tags, RepoDigests: [`${repo}@sha256:${digest}`], Created: found.created, Config: { Labels: found.labels } };
}

async function stream(options: RunOptions | undefined, lines: string[]): Promise<void> {
    for (const line of lines) {
        options?.onChunk?.(`${line}\n`);
        await sleep(450);
    }
}

const runner: DockerRunner = async (args, options) => {
    if (args[0] === "image" && args[1] === "inspect") {
        const refs = args.slice(args.indexOf("--") + 1);
        const found = refs.map(inspect).filter(Boolean);
        return { ...ok(JSON.stringify(found)), code: found.length === refs.length ? 0 : 1 };
    }
    if (args[0] === "info") {
        return ok(JSON.stringify({
            OperatingSystem: "Ubuntu 22.04.5 LTS",
            OSType: "linux",
            Architecture: "aarch64",
            KernelVersion: "5.15.0-107-generic",
            ServerVersion: "27.3.1",
            NCPU: 4,
            MemTotal: 24 * 1024 ** 3,
            Containers: [...projects.values()].reduce((total, services) => total + services.length, 0),
            ContainersRunning: [...projects.values()].reduce((total, services) => total + services.filter(service => service.state === "running").length, 0),
            ContainersPaused: 0,
            ContainersStopped: [...projects.values()].reduce((total, services) => total + services.filter(service => service.state !== "running").length, 0),
            Images: localTags.size,
            Driver: "overlay2",
        }));
    }
    if (args[0] === "stats") {
        const lines: string[] = [];
        const limit = 24 * 1024 ** 3;
        for (const [project, services] of projects) {
            for (const service of services) {
                if (service.state !== "running") continue;
                const name = containerNameOf(project, service.name);
                const seed = pseudo(name, 7);
                const cpu = (seed % 900) / 10;
                const used = (20 + (seed % 880)) * 1024 ** 2;
                lines.push(JSON.stringify({
                    Container: name,
                    Name: name,
                    ID: service.imageId.replace("sha256:", ""),
                    CPUPerc: `${cpu.toFixed(2)}%`,
                    MemUsage: `${humanBytes(used)} / ${humanBytes(limit)}`,
                    MemPerc: `${((used / limit) * 100).toFixed(2)}%`,
                    NetIO: "1.2MB / 3.4MB",
                    BlockIO: "0B / 8.1MB",
                    PIDs: String(seed % 40),
                }));
            }
        }
        for (const other of others.filter(item => item.state === "running")) {
            const seed = pseudo(other.name, 7);
            const used = (40 + (seed % 600)) * 1024 ** 2;
            lines.push(JSON.stringify({
                Container: other.name, Name: other.name, ID: other.id,
                CPUPerc: `${((seed % 300) / 10).toFixed(2)}%`,
                MemUsage: `${humanBytes(used)} / ${humanBytes(limit)}`,
                MemPerc: `${((used / limit) * 100).toFixed(2)}%`,
                NetIO: "18MB / 6.2MB", BlockIO: "4.1MB / 120MB", PIDs: String(seed % 30),
            }));
        }
        return ok(lines.length > 0 ? `${lines.join("\n")}\n` : "");
    }
    if (args[0] === "system" && args[1] === "df") {
        return ok([
            { Type: "Images", TotalCount: "9", Active: "4", Size: "8.2GB", Reclaimable: "3.1GB (37%)" },
            { Type: "Containers", TotalCount: "6", Active: "4", Size: "512MB", Reclaimable: "128MB (25%)" },
            { Type: "Local Volumes", TotalCount: "3", Active: "2", Size: "4.1GB", Reclaimable: "1.2GB (29%)" },
            { Type: "Build Cache", TotalCount: "12", Active: "0", Size: "1.4GB", Reclaimable: "1.4GB (100%)" },
        ].map(row => JSON.stringify(row)).join("\n") + "\n");
    }
    if (args[0] === "container" && args[1] === "ls") {
        const lines: string[] = [];
        for (const [project, services] of projects) {
            for (const service of services) {
                const running = service.state === "running";
                const fields = [
                    service.imageId.replace("sha256:", ""),
                    containerNameOf(project, service.name),
                    service.image,
                    service.state,
                    running ? "Up 2 hours" : `Exited (${service.exitCode}) 5 minutes ago`,
                    service.health || "none",
                    "2026-10-05T08:31:11Z",
                    running ? "2 hours ago" : "5 minutes ago",
                    "",
                    project,
                    service.name,
                    join(stacksRoot, project, "compose.yaml"),
                    join(stacksRoot, project),
                ];
                lines.push(fields.map(field => JSON.stringify(field)).join("\t"));
            }
        }
        lines.push(...others.map(otherListLine));
        return ok(lines.length > 0 ? `${lines.join("\n")}\n` : "");
    }
    if (args[0] === "container" && (args[1] === "inspect" || args[1] === "logs")) {
        const id = args[args.length - 1]!;
        const other = others.find(item => item.id === id);
        if (args[1] === "logs") {
            const stamp = new Date().toISOString();
            const last = other && other.state !== "running" ? `error: exit ${other.exitCode}` : "ready";
            return ok(`${stamp} ${other?.name ?? "container"} started (simulated)\n${stamp} ${last} (simulated)\n`);
        }
        if (other) return ok(JSON.stringify([otherInspect(other)]));
        for (const [project, services] of projects) {
            const service = services.find(item => item.imageId.replace("sha256:", "") === id);
            if (!service) continue;
            return ok(JSON.stringify([{
                Id: id,
                Name: `/${containerNameOf(project, service.name)}`,
                Image: service.imageId,
                Created: "2026-10-05T08:31:11Z",
                Config: { Image: service.image },
                State: {
                    Status: service.state, Running: service.state === "running", Paused: false, Restarting: false,
                    ExitCode: service.exitCode, StartedAt: "2026-10-05T08:31:11Z", FinishedAt: "0001-01-01T00:00:00Z",
                    ...(service.health ? { Health: { Status: service.health } } : {}),
                },
                HostConfig: { RestartPolicy: { Name: "unless-stopped" } },
                NetworkSettings: { Ports: {} },
                Mounts: [],
            }]));
        }
        return { code: 1, stdout: "[]", stderr: `Error: No such container: ${id}`, timedOut: false, truncated: false };
    }
    const project = arg(args, "-p") ?? basename(arg(args, "--project-directory") ?? "");
    const composeFile = arg(args, "-f") ?? "";
    const containerName = (service: string) => `${project}-${service}-1`;
    if (args.includes("version")) return ok("Docker Compose version v5.6.0 (simulated)");
    if (args.includes("ls")) {
        return ok(JSON.stringify([...projects].map(([name, services]) => ({
            Name: name,
            Status: projectStatus(services),
            ConfigFiles: join(stacksRoot, name, "compose.yaml"),
        }))));
    }
    if (args.includes("ps")) {
        return ok((projects.get(project) ?? []).map(service => JSON.stringify({
            Service: service.name, Name: containerName(service.name), Image: service.image,
            State: service.state, Health: service.health, ExitCode: service.exitCode,
        })).join("\n"));
    }
    if (args.includes("images")) {
        return ok(JSON.stringify((projects.get(project) ?? []).map(service => ({ ContainerName: containerName(service.name), ID: service.imageId }))));
    }
    if (args.includes("config")) {
        const services = await servicesOf(composeFile);
        if (services.length === 0) {
            return fail(`validating ${basename(dirname(composeFile))}: services must be a mapping with at least one service (simulated check)`);
        }
        return args.includes("--quiet") ? ok() : ok(JSON.stringify({ name: basename(dirname(composeFile)) || project }));
    }
    const wanted = (await servicesOf(composeFile)).map(service => ({ name: service.name, image: service.image ?? "busybox" }));
    if (args.includes("pull")) {
        for (const service of wanted) {
            const newer = registry.get(service.image);
            if (!newer) {
                await stream(options, [` ${service.name} Error: pull access denied for ${service.image} (simulated: unknown image)`]);
            } else if (localTags.get(service.image) === newer) {
                await stream(options, [` ${service.name} Pulled: image is up to date`]);
            } else {
                localTags.set(service.image, newer);
                await stream(options, [` ${service.name} Pulling`, ` ${service.name} Pulled: downloaded newer image for ${service.image}`]);
            }
        }
        return ok();
    }
    if (args.includes("up")) {
        const before = new Map((projects.get(project) ?? []).map(service => [service.name, service]));
        const next: Service[] = [];
        for (const service of wanted) {
            if (!localTags.has(service.image)) {
                const remote = registry.get(service.image);
                if (!remote) return fail(`pull access denied for ${service.image} (simulated: unknown image)`);
                localTags.set(service.image, remote);
                await stream(options, [` ${service.name} Pulled`]);
            }
            const id = localTags.get(service.image)!;
            const current = before.get(service.name);
            const unchanged = current !== undefined && current.imageId === id && current.image === service.image && current.state === "running";
            const name = containerName(service.name);
            await stream(options, unchanged ? [` Container ${name}  Running`] : [` Container ${name}  ${current ? "Recreated" : "Created"}`, ` Container ${name}  Started`]);
            next.push({ name: service.name, image: service.image, imageId: id, state: "running", exitCode: 0, health: current?.health ?? "" });
        }
        projects.set(project, next);
        return ok();
    }
    if (args.includes("restart") || args.includes("stop")) {
        const stopping = args.includes("stop");
        const services = projects.get(project) ?? [];
        await stream(options, services.map(service => ` Container ${containerName(service.name)}  ${stopping ? "Stopped" : "Restarted"}`));
        for (const service of services) Object.assign(service, stopping ? { state: "exited", exitCode: 0 } : { state: "running", exitCode: 0 });
        return ok();
    }
    if (args.includes("down")) {
        await stream(options, [...(projects.get(project) ?? []).map(service => ` Container ${containerName(service.name)}  Removed`), ` Network ${project}_default  Removed`]);
        projects.delete(project);
        return ok();
    }
    return fail(`preview: unsupported docker call: ${args.join(" ")}`);
};

const provider = createComposeProvider({ runner });
// One-shot history reads also normally spawn `docker compose logs`; simulate them.
provider.readLogs = async target => {
    const services = projects.get(target.project ?? "") ?? [];
    if (services.length === 0) return ok("");
    const stamp = new Date().toISOString();
    const stdout = services.map(service => `${service.name}-1  | ${stamp} started (simulated history)`).join("\n") + "\n";
    return ok(stdout);
};
// Log follows normally spawn `docker compose logs`; simulate them instead.
provider.followLogs = async (target, onChunk, signal) => {
    const services = projects.get(target.project ?? "") ?? [];
    const running = services.filter(service => service.state === "running");
    const stamp = () => new Date().toISOString();
    for (const service of services) onChunk(`${service.name}-1  | ${stamp()} started (simulated history)\n`);
    let tick = 0;
    while (!signal.aborted && running.length > 0) {
        await sleep(1500);
        if (signal.aborted) break;
        const service = running[tick % running.length]!;
        onChunk(`${service.name}-1  | ${stamp()} GET /health 200, line ${++tick} (simulated) é\n`);
    }
    return { code: 0, timedOut: false };
};
await provider.detect();

// ---- Panel ------------------------------------------------------------------

const config = loadConfig({
    ...process.env,
    STACKS_DIR: stacksRoot,
    COMPOSE_PANEL_DEV: "true",
    COMPOSE_PANEL_ADMIN_USER: "admin",
    COMPOSE_PANEL_ADMIN_PASSWORD_HASH: await Bun.password.hash(PASSWORD, { algorithm: "argon2id" }),
});
const app = createApp({ config, stacksRoot, provider, runner });
const server = Bun.serve({ hostname: "127.0.0.1", port: config.port, fetch: request => app.fetch(request) });

console.info(`
  Compose Panel preview: http://127.0.0.1:${server.port}
  Sign in as admin / ${PASSWORD}

  Docker is SIMULATED: no command runs, nothing real is touched.
  Demo stacks: ${stacksRoot}  (bun run preview --reset to recreate)
  Ctrl+C to stop.
`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, async () => {
        await app.beginShutdown(1000);
        server.stop(true);
        process.exit(0);
    });
}
