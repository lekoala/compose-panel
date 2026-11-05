import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createComposeProvider, type ComposeProvider } from "../src/compose-provider.ts";
import { createContainerInspector, type ContainerInspector } from "../src/containers.ts";
import { createContainerMutator, type ContainerMutator } from "../src/container-mutations.ts";
import { createDockerRunner, type DockerRunner } from "../src/docker.ts";
import { parseImageInspect } from "../src/compose-state.ts";
import {
    checkRolloutEligibility,
    parseRolloutDeclaration,
    parseRolloutInspect,
    type RolloutDeclaration,
    type RolloutInspect,
} from "../src/rollout.ts";
import { runRollout, type RolloutDependencies, type RolloutPreparation } from "../src/rollout-run.ts";

// Opt-in, DISPOSABLE-daemon integration check for the native service rollout
// (ADR 0035). It builds a small image, starts a real proxy (Traefik) and sends
// continuous fast and slow requests through it while the rollout runs. It
// creates and removes containers, so it refuses to run unless every guard
// proves the daemon is the lab one. Never run it on a host or production daemon,
// never in unattended CI. Use scripts/docker-lab/run.sh, which sets
// COMPOSE_PANEL_TEST_DOCKER_LAB=1 and DOCKER_HOST=unix:///<lab>/docker.sock.
const LAB_LABEL = "compose-panel-lab=1";
const enabled = process.platform === "linux" && process.env.COMPOSE_PANEL_TEST_DOCKER_LAB === "1";
const APP_IMAGE = "cp-rollout-app:1";
const CURL_IMAGE = "curlimages/curl:8.10.1";
const TRAEFIK_IMAGE = "traefik:v3.1";

interface Run {
    code: number;
    stdout: string;
    stderr: string;
}

async function docker(args: string[], timeoutMs = 60_000): Promise<Run> {
    const proc = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: timeoutMs });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, stdout, stderr };
}

async function dockerOk(args: string[], timeoutMs?: number): Promise<string> {
    const result = await docker(args, timeoutMs);
    if (result.code !== 0) throw new Error(`docker ${args.join(" ")} failed (${result.code}): ${result.stderr.trim()}`);
    return result.stdout;
}

async function assertLabDaemon(): Promise<void> {
    const host = process.env.DOCKER_HOST ?? "";
    if (!host.startsWith("unix://")) throw new Error("DOCKER_HOST must point to the lab Unix socket (unix://...).");
    const socket = host.slice("unix://".length);
    let real: string;
    try {
        real = realpathSync(socket);
    } catch {
        throw new Error(`Lab socket ${socket} does not exist.`);
    }
    if (["/var/run/docker.sock", "/run/docker.sock"].includes(real) || real.startsWith("/run/user/")) {
        throw new Error(`DOCKER_HOST resolves to a default daemon socket (${real}); refusing.`);
    }
    for (const name of ["DOCKER_CONTEXT", "COMPOSE_PROJECT_NAME", "COMPOSE_FILE", "COMPOSE_ENV_FILES", "COMPOSE_PROFILES"]) {
        if (process.env[name]) throw new Error(`Unset ${name} before running the lab test.`);
    }
    const labels = JSON.parse(await dockerOk(["info", "--format", "{{json .Labels}}"])) as string[] | null;
    if (!labels?.includes(LAB_LABEL)) throw new Error(`The daemon behind DOCKER_HOST lacks the engine label ${LAB_LABEL}; refusing.`);
    if ((await dockerOk(["ps", "-aq"])).trim() !== "") throw new Error("The lab daemon must start without containers; refusing.");
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await check()) return;
        await Bun.sleep(100);
    }
    throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}.`);
}

describe.skipIf(!enabled)("native rollout on a disposable lab daemon", () => {
    let base: string;
    let provider: ComposeProvider;
    let inspector: ContainerInspector;
    let mutator: ContainerMutator;
    const runner: DockerRunner = createDockerRunner();

    beforeAll(async () => {
        await assertLabDaemon();
        if (!process.env.COMPOSE_PANEL_LAB_SHARED) {
            throw new Error("COMPOSE_PANEL_LAB_SHARED is not set; run scripts/docker-lab/run.sh.");
        }
        base = await mkdtemp(join(tmpdir(), "cp-rollout-lab-"));
        const imageDir = join(base, "image");
        await mkdir(imageDir);
        await writeFile(
            join(imageDir, "Dockerfile"),
            `FROM oven/bun:1.4.4-slim\nWORKDIR /app\nCOPY server.ts /app/server.ts\nCMD ["bun", "/app/server.ts"]\n`,
        );
        await writeFile(
            join(imageDir, "server.ts"),
            `const fail = process.env.APP_FAIL === "1";\n` +
                `if (fail) setTimeout(() => process.exit(1), 1500);\n` +
                `Bun.serve({\n` +
                `  port: 8080,\n` +
                `  async fetch(request) {\n` +
                `    const path = new URL(request.url).pathname;\n` +
                `    if (path === "/health/ready") {\n` +
                `      if (await Bun.file("/tmp/drain").exists()) return new Response("drained", { status: 503 });\n` +
                `      return new Response("ok");\n` +
                `    }\n` +
                `    if (path === "/slow") {\n` +
                `      await Bun.sleep(1500);\n` +
                `      return new Response("slow");\n` +
                `    }\n` +
                `    return new Response("ok");\n` +
                `  },\n` +
                `});\n`,
        );
        await dockerOk(["build", "-t", APP_IMAGE, imageDir], 300_000);
        provider = createComposeProvider({ runner });
        inspector = createContainerInspector({ runner });
        mutator = createContainerMutator({ runner });
    }, 360_000);

    afterAll(async () => {
        if (!base) return;
        await docker(["rmi", "-f", APP_IMAGE]);
        await rm(base, { recursive: true, force: true });
    });

    interface Stack {
        project: string;
        dir: string;
        compose: string;
        env: string;
        clientDir: string;
    }

    async function setupStack(project: string, withClient: boolean): Promise<Stack> {
        const dir = join(base, project);
        const shared = process.env.COMPOSE_PANEL_LAB_SHARED!;
        // Bind mounts are resolved by the DinD daemon, so the client output must
        // live on the path the lab mounts at the same location inside it.
        const clientDir = join(shared, `${project}-client`);
        await mkdir(dir, { recursive: true });
        await mkdir(clientDir, { recursive: true });
        const compose = join(dir, "compose.yaml");
        const env = join(dir, ".env");
        // The lab exposes the daemon socket at /lab/docker.sock inside DinD.
        // A host DOCKER_HOST path is not visible to a container started there.
        const socket = "/lab/docker.sock";
        await writeFile(env, `APP_FAIL=0\nLAB_SOCKET=${socket}\nCLIENT_OUT=${clientDir}\n`);
        const client = withClient
            ? `  client:\n` +
              `    image: ${CURL_IMAGE}\n` +
              `    profiles: ["client"]\n` +
              `    depends_on: [traefik]\n` +
              `    networks: [rollout]\n` +
              `    entrypoint: ["sh"]\n` +
              `    volumes:\n` +
              `      - "\${CLIENT_OUT}:/out"\n` +
              `    command:\n` +
              `      - -c\n` +
              `      - |\n` +
              `        while [ ! -f /out/stop ]; do\n` +
              `          curl -fsS --max-time 10 -H 'Host: app.test' http://traefik/ >/dev/null || echo fast >> /out/failures\n` +
              `          curl -fsS --max-time 10 -H 'Host: app.test' http://traefik/slow >/dev/null || echo slow >> /out/failures\n` +
              `          sleep 0.2\n` +
              `        done\n`
            : "";
        await writeFile(
            compose,
            `services:\n` +
                `  web:\n` +
                `    image: ${APP_IMAGE}\n` +
                `    environment:\n` +
                `      APP_FAIL: "\${APP_FAIL:-0}"\n` +
                `    expose: ["8080"]\n` +
                `    networks: [rollout]\n` +
                `    stop_grace_period: 10s\n` +
                `    healthcheck:\n` +
                `      test: ["CMD-SHELL", "test ! -f /tmp/drain && bun -e 'fetch(\\"http://127.0.0.1:8080/health/ready\\").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'"]\n` +
                `      interval: 2s\n` +
                `      timeout: 2s\n` +
                `      retries: 1\n` +
                `      start_period: 5s\n` +
                `    labels:\n` +
                `      panel.rollout.enabled: "true"\n` +
                `      panel.rollout.timeout: "30"\n` +
                `      panel.rollout.settle: "3"\n` +
                `      panel.rollout.drain-file: "/tmp/drain"\n` +
                `      panel.rollout.drain-detect: "15"\n` +
                `      panel.rollout.drain-time: "5"\n` +
                `      panel.rollout.stop-timeout: "10"\n` +
                `      traefik.enable: "true"\n` +
                `      traefik.docker.network: "${project}-net"\n` +
                `      traefik.http.routers.app.rule: "Host(\`app.test\`)"\n` +
                `      traefik.http.services.app.loadbalancer.server.port: "8080"\n` +
                `  traefik:\n` +
                `    image: ${TRAEFIK_IMAGE}\n` +
                `    command:\n` +
                `      - --providers.docker=true\n` +
                `      - --providers.docker.exposedByDefault=false\n` +
                `      - --providers.docker.healthcheck=true\n` +
                `      - --providers.docker.network=${project}-net\n` +
                `      - --entrypoints.web.address=:80\n` +
                `      - --log.level=ERROR\n` +
                `    volumes:\n` +
                `      - "\${LAB_SOCKET}:/var/run/docker.sock:ro"\n` +
                `    expose: ["80"]\n` +
                `    networks: [rollout]\n` +
                client +
                `networks:\n` +
                `  rollout:\n` +
                `    name: ${project}-net\n`,
        );
        return { project, dir, compose, env, clientDir };
    }

    function compose(stack: Stack, args: string[]): Promise<Run> {
        return docker(["compose", "-p", stack.project, "--project-directory", stack.dir, "-f", stack.compose, ...args], 180_000);
    }

    async function composeOk(stack: Stack, args: string[]): Promise<string> {
        const result = await compose(stack, args);
        if (result.code !== 0) throw new Error(`compose ${args.join(" ")} failed: ${result.stderr.trim()}`);
        return result.stdout;
    }

    async function inspect(id: string): Promise<RolloutInspect | null> {
        const result = await inspector.inspect(id);
        return parseRolloutInspect(result.stdout);
    }

    async function prepare(stack: Stack): Promise<RolloutPreparation> {
        const target = { project: stack.project, composeFile: stack.compose, cwd: stack.dir, envFile: stack.env };
        const facts = await provider.serviceRolloutFacts(target);
        const names = await provider.listServices({ ...target, project: stack.project });
        const ids = await provider.serviceContainerIds({ ...target, service: "web" });
        if (!facts || !names || !ids || ids.length !== 1) throw new Error("fixture is not ready for a rollout");
        const serviceFacts = facts.get("web");
        if (!serviceFacts) throw new Error("web facts are missing");
        const declaration = parseRolloutDeclaration(serviceFacts.labels);
        if (!declaration?.ok) throw new Error(`declaration refused: ${declaration?.reason ?? "absent"}`);
        const old = await inspect(ids[0]!);
        const eligibility = checkRolloutEligibility({
            facts: serviceFacts,
            declaration: declaration.value,
            inspect: old,
            containerCount: ids.length,
        });
        if (!eligibility.ok) throw new Error(`eligibility refused: ${eligibility.reason}`);
        return { oldContainerId: old!.id, declaration: declaration.value, image: eligibility.image };
    }

    function dependencies(target: { project: string; composeFile: string; cwd: string; envFile: string }): RolloutDependencies {
        return {
            pull: (value, service, onOutput, timeoutMs) => provider.pullService({ ...value, service, onOutput, timeoutMs }),
            scale: (value, service, onOutput, timeoutMs) => provider.scaleService({ ...value, service, replicas: 2, onOutput, timeoutMs }),
            listServiceContainers: (value, service) => provider.serviceContainerIds({ ...value, service }),
            inspect,
            imageId: async (reference) => {
                const result = await provider.inspectImages([reference]);
                return parseImageInspect(result.stdout)[0]?.id ?? null;
            },
            stop: (id, seconds, onOutput, timeoutMs) => mutator.stop(id, seconds, { onOutput, timeoutMs }),
            remove: (id, onOutput, timeoutMs) => mutator.remove(id, { onOutput, timeoutMs }),
            markDrain: (id, path, onOutput, timeoutMs) => mutator.markDrain(id, path, { onOutput, timeoutMs }),
            sleep: (ms) => Bun.sleep(ms),
            now: () => Date.now(),
            isShuttingDown: () => false,
        };
    }

    test("serves fast and slow requests without a failure through a real proxy", async () => {
        const stack = await setupStack("cp-qa-rollout", true);
        const target = { project: stack.project, composeFile: stack.compose, cwd: stack.dir, envFile: stack.env };
        try {
            await composeOk(stack, ["up", "-d", "web", "traefik"]);
            const webId = (await composeOk(stack, ["ps", "-q", "web"])).trim();
            await waitFor(
                async () => (await dockerOk(["inspect", "-f", "{{.State.Health.Status}}", webId])).trim() === "healthy",
                90_000,
                "web healthy",
            );
            await waitFor(
                async () => {
                    const result = await docker([
                        "run",
                        "--rm",
                        "--network",
                        `${stack.project}-net`,
                        CURL_IMAGE,
                        "-fsS",
                        "-H",
                        "Host: app.test",
                        "http://traefik/",
                    ]);
                    return result.code === 0;
                },
                120_000,
                "Traefik routing the web service",
            );

            const preparation = await prepare(stack);
            await composeOk(stack, ["--profile", "client", "up", "-d", "client"]);
            const clientId = (await composeOk(stack, ["ps", "-q", "client"])).trim();
            await Bun.sleep(1500);

            const messages: string[] = [];
            const outcome = await runRollout(dependencies(target), {
                target,
                service: "web",
                pull: false,
                operationTimeoutMs: 60_000,
                rolloutTimeoutMs: 180_000,
                onOutput: (chunk) => messages.push(chunk),
                prepare: async () => ({ ok: true, preparation }),
            });
            expect(outcome).toEqual({ code: 0, stdout: "", stderr: "", timedOut: false, truncated: false });

            await writeFile(join(stack.clientDir, "stop"), "1");
            await waitFor(
                async () => (await dockerOk(["inspect", "-f", "{{.State.Status}}", clientId])).trim() === "exited",
                30_000,
                "the continuous client to stop",
            );
            const failures = await readFile(join(stack.clientDir, "failures"), "utf8").catch(() => "");
            expect(failures.trim()).toBe("");

            const remaining = await provider.serviceContainerIds({ ...target, service: "web" });
            expect(remaining).toHaveLength(1);
            expect(remaining![0]).not.toBe(preparation.oldContainerId);
            const newContainer = await inspect(remaining![0]!);
            expect(newContainer?.running).toBe(true);
            expect(newContainer?.health).toBe("healthy");
        } finally {
            await compose(stack, ["down", "-v", "--remove-orphans"]);
        }
    }, 360_000);

    test("keeps the old instance when the candidate exits before becoming healthy", async () => {
        const stack = await setupStack("cp-qa-rollout-fail", false);
        const target = { project: stack.project, composeFile: stack.compose, cwd: stack.dir, envFile: stack.env };
        try {
            await composeOk(stack, ["up", "-d", "web"]);
            const webId = (await composeOk(stack, ["ps", "-q", "web"])).trim();
            await waitFor(
                async () => (await dockerOk(["inspect", "-f", "{{.State.Health.Status}}", webId])).trim() === "healthy",
                90_000,
                "web healthy",
            );
            const preparation = await prepare(stack);
            // The candidate is created from the new environment and exits before
            // becoming healthy; the old container keeps the previous environment.
            const socket = "/lab/docker.sock";
            await writeFile(stack.env, `APP_FAIL=1\nLAB_SOCKET=${socket}\nCLIENT_OUT=${stack.clientDir}\n`);

            const outcome = await runRollout(dependencies(target), {
                target,
                service: "web",
                pull: false,
                operationTimeoutMs: 60_000,
                rolloutTimeoutMs: 120_000,
                onOutput: () => {},
                prepare: async () => ({ ok: true, preparation }),
            });
            expect("intervention" in outcome).toBe(false);
            expect("refused" in outcome).toBe(false);
            if (!("code" in outcome)) throw new Error("expected a command result");
            expect(outcome.code).toBe(1);

            const remaining = await provider.serviceContainerIds({ ...target, service: "web" });
            expect(remaining).toEqual([preparation.oldContainerId]);
            const old = await inspect(preparation.oldContainerId);
            expect(old?.running).toBe(true);
            expect(old?.health).toBe("healthy");
        } finally {
            await compose(stack, ["down", "-v", "--remove-orphans"]);
        }
    }, 360_000);
});
