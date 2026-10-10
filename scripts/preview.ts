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
const app = createApp({ config, stacksRoot, provider });
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
