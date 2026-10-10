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

interface Service { name: string; state: "running" | "exited"; exitCode: number; health: string }
const projects = new Map<string, Service[]>([
    ["web", [
        { name: "app", state: "running", exitCode: 0, health: "healthy" },
        { name: "cache", state: "running", exitCode: 0, health: "" },
        { name: "migrate", state: "exited", exitCode: 0, health: "" },
    ]],
    ["db", [{ name: "postgres", state: "exited", exitCode: 137, health: "" }]],
]);

const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "", timedOut: false, truncated: false });
const fail = (stderr: string): CommandResult => ({ code: 1, stdout: "", stderr, timedOut: false, truncated: false });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function arg(args: string[], flag: string): string | undefined {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
}

/** Service names from the top-level `services:` block (two-space indent). */
async function servicesOf(composeFile: string): Promise<string[]> {
    const text = await readFile(composeFile, "utf8").catch(() => "");
    const block = text.split(/^services:\s*$/m)[1] ?? "";
    return [...block.matchAll(/^ {2}([A-Za-z0-9_.-]+):/gm)].map(match => match[1]!);
}

function projectStatus(services: Service[]): string {
    const running = services.filter(service => service.state === "running").length;
    const exited = services.length - running;
    return [running ? `running(${running})` : "", exited ? `exited(${exited})` : ""].filter(Boolean).join(", ");
}

async function stream(options: RunOptions | undefined, lines: string[]): Promise<void> {
    for (const line of lines) {
        options?.onChunk?.(`${line}\n`);
        await sleep(450);
    }
}

const runner: DockerRunner = async (args, options) => {
    const project = arg(args, "-p") ?? basename(arg(args, "--project-directory") ?? "");
    const composeFile = arg(args, "-f") ?? "";
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
            Service: service.name, State: service.state, Health: service.health, ExitCode: service.exitCode,
        })).join("\n"));
    }
    if (args.includes("config")) {
        const text = await readFile(composeFile, "utf8").catch(() => "");
        if (!/^services:\s*$/m.test(text) || (await servicesOf(composeFile)).length === 0) {
            return fail(`validating ${basename(dirname(composeFile))}: services must be a mapping with at least one service (simulated check)`);
        }
        return args.includes("--quiet") ? ok() : ok(JSON.stringify({ name: basename(dirname(composeFile)) || project }));
    }
    const names = await servicesOf(composeFile);
    const container = (service: string) => `${project}-${service}-1`;
    if (args.includes("pull")) {
        await stream(options, names.map(service => ` ${service} Pulled (simulated)`));
        return ok();
    }
    if (args.includes("up")) {
        await stream(options, names.flatMap(service => [` Container ${container(service)}  Creating`, ` Container ${container(service)}  Started`]));
        projects.set(project, names.map(name => ({ name, state: "running", exitCode: 0, health: "" })));
        return ok();
    }
    if (args.includes("restart") || args.includes("stop")) {
        const stopping = args.includes("stop");
        const services = projects.get(project) ?? [];
        await stream(options, services.map(service => ` Container ${container(service.name)}  ${stopping ? "Stopped" : "Restarted"}`));
        for (const service of services) Object.assign(service, stopping ? { state: "exited", exitCode: 0 } : { state: "running", exitCode: 0 });
        return ok();
    }
    if (args.includes("down")) {
        await stream(options, [...(projects.get(project) ?? []).map(service => ` Container ${container(service.name)}  Removed`), ` Network ${project}_default  Removed`]);
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
        onChunk(`${service.name}-1  | ${stamp()} GET /health 200 — line ${++tick} (simulated) é\n`);
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
