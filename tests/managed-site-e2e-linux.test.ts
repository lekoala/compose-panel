import { describe, expect, test } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../src/docker.ts";
import { fetchAndPublishGitRelease, revisionScript } from "../src/git-release.ts";
import { buildManagedSite } from "../src/managed-site-generate.ts";
import { MANAGED_SITE_PATHS, parseManagedSiteManifest, type ManagedSiteManifest } from "../src/managed-site.ts";
import {
    managedSiteAttemptPath,
    parseProbeAnswer,
    readBaseline,
    readPendingDeployAttempt,
    switchCurrent,
    type ManagedSiteProbe,
} from "../src/managed-site-deploy.ts";
import {
    createLabProbe,
    createMappedGitRunner,
    deployWithE2E,
    outerDockerEnv,
    type ManagedSiteE2EConfig,
} from "./helpers/managed-site-e2e.ts";

/**
 * End-to-end proof of the manual managed-site deploy on a REAL, disposable
 * Docker Engine (ADR 0042, ADR 0043). Opt-in only:
 *   bun run test:managed-sites-e2e:wsl
 *
 * The suite runs on the lab daemon from scripts/docker-lab/lib.sh. It creates a
 * real Git repository with two commits, publishes the first revision as the
 * baseline, then drives the actual deploy code: a full deploy, a no-op for the
 * SHA already proven active, a return to the previous release, two refusals
 * before any mutation, and two SIGKILLs (after the gateway stop, and after the
 * pointer switch) followed by an inspection of the durable state. A second
 * Compose project is running throughout and must not change.
 *
 * The gateway publishes 127.0.0.1:<port> in the lab daemon's own network
 * namespace, so the revision probe is executed inside that namespace with
 * `docker exec`. The deploy still applies the strict probe contract to the
 * answer, and the real HTTP probe is covered by managed-site-probe.test.ts and
 * the shell lab.
 */
const enabled = process.env.COMPOSE_PANEL_TEST_DOCKER_LAB === "1";
const shared = process.env.COMPOSE_PANEL_LAB_SHARED ?? "";
const labContainer = process.env.COMPOSE_PANEL_LAB_CONTAINER ?? "";
const labOuterContext = process.env.COMPOSE_PANEL_LAB_OUTER_CONTEXT || undefined;
const port = Number(process.env.COMPOSE_PANEL_E2E_PORT ?? "18432");
const GIT_URL = "https://git.invalid/compose-panel-e2e.git";
const GIT_REF = "refs/heads/main";

function requireEnv(): void {
    if (!enabled) throw new Error("COMPOSE_PANEL_TEST_DOCKER_LAB=1 is required.");
    if (!shared) throw new Error("COMPOSE_PANEL_LAB_SHARED is required.");
    if (!labContainer) throw new Error("COMPOSE_PANEL_LAB_CONTAINER is required.");
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("COMPOSE_PANEL_E2E_PORT is not a port.");
}

async function dockerOk(args: string[], cwd?: string): Promise<string> {
    const result = await runCommand("docker", args, { cwd, timeoutMs: 180_000, maxBytes: 8 * 1024 * 1024 });
    if (result.code !== 0 || result.timedOut) {
        throw new Error(`docker ${args.join(" ")} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
    }
    return result.stdout.trim();
}

async function git(args: string[], cwd: string): Promise<string> {
    const result = await runCommand("git", args, { cwd, timeoutMs: 60_000, maxBytes: 1024 * 1024 });
    if (result.code !== 0 || result.timedOut) {
        throw new Error(`git ${args.join(" ")} failed (${result.code}): ${result.stderr.trim()}`);
    }
    return result.stdout.trim();
}

async function waitForRevision(probe: ManagedSiteProbe, expected: string, deadlineMs = 60_000, probePort = port): Promise<void> {
    const deadline = Date.now() + deadlineMs;
    let last: string | null = null;
    for (;;) {
        const answer = await probe(probePort);
        last = answer ? parseProbeAnswer(answer.status, answer.body) : null;
        if (last === expected) return;
        if (Date.now() > deadline) throw new Error(`revision ${expected} was never served; last answer ${last ?? "none"}`);
        await Bun.sleep(250);
    }
}

async function fetchInLab(path: string, targetPort = port): Promise<string | null> {
    const result = await runCommand("docker", ["exec", labContainer, "wget", "-q", "-O", "-", `http://127.0.0.1:${targetPort}${path}`], {
        env: outerDockerEnv(labOuterContext),
        timeoutMs: 4000,
        maxBytes: 4096,
    });
    return result.code === 0 && !result.timedOut ? result.stdout : null;
}

function attempt(n: number): string {
    return `e2eattempt${String(n).padStart(3, "0")}`;
}

function manifestJson(project: string, siteId: string): string {
    const manifest: ManagedSiteManifest = {
        version: 1,
        siteId,
        owner: "opt-in",
        project,
        services: { gateway: "web", runtime: "php" },
        publicRoot: "public",
        runtime: { profile: "php-front-controller" },
        deploy: { kind: "bind-mount", git: { url: GIT_URL, ref: GIT_REF } },
    };
    return `${JSON.stringify(manifest, null, 2)}\n`;
}

function composeYaml(project: string, stackDir: string): string {
    return `name: ${project}

services:
  web:
    image: nginx:alpine
    restart: "no"
    ports:
      - "127.0.0.1:${port}:80"
    volumes:
      - ${stackDir}/${MANAGED_SITE_PATHS.runtime}:${stackDir}/${MANAGED_SITE_PATHS.runtime}:ro
      - ${stackDir}/generated/nginx-site.conf:/etc/nginx/conf.d/default.conf:ro
    depends_on:
      - php

  php:
    image: php:8.3-fpm-alpine
    restart: "no"
    volumes:
      - ${stackDir}/${MANAGED_SITE_PATHS.runtime}:${stackDir}/${MANAGED_SITE_PATHS.runtime}:ro
      - ${stackDir}/${MANAGED_SITE_PATHS.shared}:${stackDir}/${MANAGED_SITE_PATHS.shared}:rw
      - ${stackDir}/generated/opcache.ini:/usr/local/etc/php/conf.d/zz-opcache.ini:ro
`;
}

const INDEX_PHP = `<?php
// The published release carries .compose-panel/revision.php outside public/.
require dirname(__DIR__) . '/.compose-panel/revision.php';
`;

/** Create commit A in a real repository and a bare repository to fetch from. */
async function createGitFixture(root: string): Promise<{ work: string; bare: string; a: string }> {
    const work = join(root, "work");
    const bare = join(root, "repo.git");
    await mkdir(join(work, "public"), { recursive: true });
    await writeFile(join(work, "public", "index.php"), INDEX_PHP);
    await writeFile(join(work, "public", "version.txt"), "one\n");

    await git(["init", "--quiet", "--initial-branch=main", work], root);
    await git(["add", "-A"], work);
    await git(
        [
            "-c",
            "user.name=Compose Panel Lab",
            "-c",
            "user.email=lab@example.test",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--quiet",
            "-m",
            "revision one",
        ],
        work,
    );
    const a = await git(["rev-parse", "HEAD"], work);

    await git(["init", "--quiet", "--bare", bare], root);
    await git(["push", "--quiet", bare, "main"], work);

    return { work, bare, a };
}

/** Commit revision two on top of A and publish it as the branch tip. */
async function commitRevisionTwo(work: string, bare: string): Promise<string> {
    await writeFile(join(work, "public", "version.txt"), "two\n");
    await git(["add", "-A"], work);
    await git(
        [
            "-c",
            "user.name=Compose Panel Lab",
            "-c",
            "user.email=lab@example.test",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--quiet",
            "-m",
            "revision two",
        ],
        work,
    );
    const b = await git(["rev-parse", "HEAD"], work);
    await git(["push", "--quiet", bare, "main"], work);
    return b;
}

async function runCrashedDeploy(config: ManagedSiteE2EConfig, crash: "after-stop" | "after-switch"): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "cp-e2e-child-"));
    try {
        const flag = join(root, "reached");
        const configPath = join(root, "config.json");
        await writeFile(configPath, `${JSON.stringify({ ...config, crash, flag })}\n`);
        const child = Bun.spawn([process.execPath, join(import.meta.dir, "managed-site-e2e-child.ts"), configPath], {
            cwd: join(import.meta.dir, ".."),
            env: process.env,
            stdout: "pipe",
            stderr: "pipe",
        });
        const deadline = Date.now() + 180_000;
        while (!existsSync(flag)) {
            if (child.exitCode !== null) {
                const stderr = await new Response(child.stderr).text();
                throw new Error(`the deploy child exited before ${crash} (${child.exitCode}): ${stderr.slice(0, 4000)}`);
            }
            if (Date.now() > deadline) {
                child.kill("SIGKILL");
                throw new Error(`the deploy child never reached ${crash}`);
            }
            await Bun.sleep(100);
        }
        child.kill("SIGKILL");
        await child.exited;
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

describe.skipIf(process.platform !== "linux" || !enabled || !shared || !labContainer)("managed-site deploy on a disposable daemon", () => {
    test("two commits, no-op, rollback, refusals and two killed deploys", async () => {
        requireEnv();
        const root = await mkdtemp(join(realpathSync(shared), "managed-site-e2e-"));
        await chmod(root, 0o755);
        const stackDir = join(root, "stack");
        const siteId = `cp-e2e-${process.pid}`;
        const project = `cp-e2e-${process.pid}`;
        const composeFile = join(stackDir, "compose.yaml");
        const manifestFile = join(stackDir, "compose-panel-site.json");
        const runtimeDir = join(stackDir, MANAGED_SITE_PATHS.runtime);
        const currentPath = join(runtimeDir, "current");
        const bystanderProject = `${project}-by`;
        const bystanderFile = join(root, "bystander", "compose.yaml");
        const probe = createLabProbe({ labContainer, labOuterContext });
        const config: ManagedSiteE2EConfig = {
            stackDir,
            siteId,
            project,
            composeFile,
            port,
            gitUrl: GIT_URL,
            gitRef: GIT_REF,
            bareRepo: join(root, "repo.git"),
            labContainer,
            ...(labOuterContext ? { labOuterContext } : {}),
            attemptId: attempt(0),
        };

        try {
            // ---- layout, manifest, gateway config ----
            for (const path of [
                join(stackDir, "generated"),
                join(stackDir, MANAGED_SITE_PATHS.staging),
                join(stackDir, MANAGED_SITE_PATHS.releases),
                join(stackDir, MANAGED_SITE_PATHS.shared),
                join(stackDir, MANAGED_SITE_PATHS.private),
            ]) {
                await mkdir(path, { recursive: true, mode: 0o755 });
            }
            await chmod(join(stackDir, MANAGED_SITE_PATHS.staging), 0o700);
            await chmod(join(stackDir, MANAGED_SITE_PATHS.private), 0o700);
            await chmod(join(stackDir, MANAGED_SITE_PATHS.shared), 0o755);

            const fixtures = join(import.meta.dir, "..", "scripts", "managed-sites-lab", "fixtures");
            const gateway = await readFile(join(fixtures, "nginx-site.conf"), "utf8");
            await writeFile(join(stackDir, "generated", "nginx-site.conf"), gateway.replaceAll("__SITE_ROOT__", stackDir));
            await writeFile(join(stackDir, "generated", "opcache.ini"), await readFile(join(fixtures, "opcache.ini")));
            await writeFile(composeFile, composeYaml(project, stackDir));
            await writeFile(manifestFile, manifestJson(project, siteId));

            // ---- two real commits: A is the baseline, B is deployed next ----
            const { work, bare, a } = await createGitFixture(root);
            config.bareRepo = bare;
            const parsed = parseManagedSiteManifest(await readFile(manifestFile, "utf8"));
            if (!parsed.ok) throw new Error(parsed.reason);

            // ---- baseline: publish commit A and serve it ----
            const bootstrap = await fetchAndPublishGitRelease({
                stackDir,
                attemptId: attempt(0),
                siteId,
                url: GIT_URL,
                ref: GIT_REF,
                runner: createMappedGitRunner(GIT_URL, bare),
            });
            if (!bootstrap.ok) {
                throw new Error(`baseline publish failed: ${bootstrap.reason}${bootstrap.detail ? ` ${bootstrap.detail}` : ""}`);
            }
            expect(bootstrap.releaseId).toBe(a);
            expect(await switchCurrent(runtimeDir, a)).toEqual({ ok: true });

            // Publish B only once A is the proven baseline, so the fixture's
            // branch tip always matches the revision each step expects.
            const b = await commitRevisionTwo(work, bare);
            expect(b).not.toBe(a);

            await dockerOk(["compose", "-p", project, "-f", composeFile, "up", "-d", "--quiet-pull"], stackDir);
            await waitForRevision(probe, a);
            expect(await fetchInLab("/")).toBe(`${a}\n`);
            expect(await fetchInLab("/version.txt")).toBe("one\n");
            expect(await readBaseline(stackDir, siteId)).toMatchObject({ ok: true, releaseId: a });

            // A second Compose project must survive every deploy.
            await mkdir(join(root, "bystander"), { recursive: true });
            await writeFile(
                bystanderFile,
                `name: ${bystanderProject}\nservices:\n  idle:\n    image: alpine:3.20\n    restart: "no"\n    command: ["sh", "-c", "trap 'exit 0' TERM; sleep 3600 & wait"]\n`,
            );
            await dockerOk(["compose", "-p", bystanderProject, "-f", bystanderFile, "up", "-d", "--quiet-pull"]);
            const bystanderId = await dockerOk(["compose", "-p", bystanderProject, "-f", bystanderFile, "ps", "-q", "idle"]);

            const gatewayId = await dockerOk(["compose", "-p", project, "-f", composeFile, "ps", "-q", "web"], stackDir);
            const baselineRuntimeId = await dockerOk(["compose", "-p", project, "-f", composeFile, "ps", "-q", "php"], stackDir);

            // ---- deploy commit B through the real deploy code ----
            const deployed = await deployWithE2E({ ...config, attemptId: attempt(1) });
            expect(deployed.kind).toBe("deployed");
            if (deployed.kind === "deployed") {
                expect(deployed.releaseId).toBe(b);
                expect(deployed.priorReleaseId).toBe(a);
            }
            expect(await readlink(currentPath)).toBe(`releases/${b}`);
            await waitForRevision(probe, b);
            expect(await fetchInLab("/")).toBe(`${b}\n`);
            expect(await fetchInLab("/version.txt")).toBe("two\n");
            expect(await dockerOk(["compose", "-p", project, "-f", composeFile, "ps", "-q", "web"], stackDir)).toBe(gatewayId);
            expect(await dockerOk(["compose", "-p", project, "-f", composeFile, "ps", "-q", "php"], stackDir)).not.toBe(baselineRuntimeId);
            expect(existsSync(managedSiteAttemptPath(stackDir))).toBe(false);

            // ---- the SHA already proven active is a no-op ----
            const runtimeB = await dockerOk(["compose", "-p", project, "-f", composeFile, "ps", "-q", "php"], stackDir);
            const noop = await deployWithE2E({ ...config, attemptId: attempt(2) });
            expect(noop).toEqual({ kind: "noop", releaseId: b });
            expect(await readlink(currentPath)).toBe(`releases/${b}`);
            expect(await dockerOk(["compose", "-p", project, "-f", composeFile, "ps", "-q", "php"], stackDir)).toBe(runtimeB);
            expect(await dockerOk(["compose", "-p", project, "-f", composeFile, "ps", "-q", "web"], stackDir)).toBe(gatewayId);

            // ---- deploy the previous commit again ----
            await git(["reset", "--hard", "--quiet", a], work);
            await git(["push", "--quiet", "--force", bare, "main"], work);
            const back = await deployWithE2E({ ...config, attemptId: attempt(3) });
            expect(back.kind).toBe("deployed");
            if (back.kind === "deployed") {
                expect(back.releaseId).toBe(a);
                expect(back.priorReleaseId).toBe(b);
            }
            await waitForRevision(probe, a);
            expect(await fetchInLab("/version.txt")).toBe("one\n");
            const runtimeA = await dockerOk(["compose", "-p", project, "-f", composeFile, "ps", "-q", "php"], stackDir);

            // ---- changed project identity is refused before any mutation ----
            await writeFile(manifestFile, manifestJson(`${project}-other`, siteId));
            const wrongProject = await deployWithE2E({ ...config, attemptId: attempt(4) });
            expect(wrongProject.kind).toBe("refused");
            if (wrongProject.kind === "refused") expect(wrongProject.reason).toContain("project");
            expect(existsSync(managedSiteAttemptPath(stackDir))).toBe(false);
            await waitForRevision(probe, a);
            expect(await dockerOk(["compose", "-p", project, "-f", composeFile, "ps", "-q", "php"], stackDir)).toBe(runtimeA);
            await writeFile(manifestFile, manifestJson(project, siteId));

            // ---- a parent bind over the site tree is refused ----
            const originalCompose = await readFile(composeFile, "utf8");
            const parentBind = originalCompose.replace(
                `      - ${stackDir}/${MANAGED_SITE_PATHS.runtime}:${stackDir}/${MANAGED_SITE_PATHS.runtime}:ro\n`,
                `      - ${stackDir}/${MANAGED_SITE_PATHS.runtime}:${stackDir}/${MANAGED_SITE_PATHS.runtime}:ro\n      - ${stackDir}/site:${stackDir}/site:ro\n`,
            );
            expect(parentBind).not.toBe(originalCompose);
            await writeFile(composeFile, parentBind);
            const wrongBind = await deployWithE2E({ ...config, attemptId: attempt(5) });
            expect(wrongBind.kind).toBe("refused");
            expect(existsSync(managedSiteAttemptPath(stackDir))).toBe(false);
            await waitForRevision(probe, a);
            await writeFile(composeFile, originalCompose);

            // ---- kill after the gateway stop, before the switch ----
            await git(["reset", "--hard", "--quiet", b], work);
            await git(["push", "--quiet", bare, "main"], work);
            const stopAttempt = attempt(6);
            await runCrashedDeploy({ ...config, attemptId: stopAttempt }, "after-stop");

            const stopMarker = await readPendingDeployAttempt(stackDir);
            expect(stopMarker.kind).toBe("pending");
            if (stopMarker.kind === "pending") {
                expect(stopMarker.attempt.attemptId).toBe(stopAttempt);
                expect(stopMarker.attempt.outcome).toBe("pending");
            }
            expect(await dockerOk(["compose", "-p", project, "-f", composeFile, "ps", "-q", "web"], stackDir)).toBe("");
            expect(await readlink(currentPath)).toBe(`releases/${a}`);
            expect(await dockerOk(["compose", "-p", project, "-f", composeFile, "ps", "-q", "php"], stackDir)).toBe(runtimeA);
            expect(await probe(port)).toBeNull();

            // Recovery: the pointer is still the verified baseline, so the
            // operator restarts the gateway, confirms the revision, then
            // acknowledges the attempt.
            await dockerOk(["compose", "-p", project, "-f", composeFile, "start", "web"], stackDir);
            await waitForRevision(probe, a);
            await unlink(managedSiteAttemptPath(stackDir));
            expect(await readPendingDeployAttempt(stackDir)).toEqual({ kind: "none" });

            // ---- kill after the pointer switch, before the recreation ----
            const switchAttempt = attempt(7);
            await runCrashedDeploy({ ...config, attemptId: switchAttempt }, "after-switch");
            const switchMarker = await readPendingDeployAttempt(stackDir);
            expect(switchMarker.kind).toBe("pending");
            if (switchMarker.kind === "pending") expect(switchMarker.attempt.attemptId).toBe(switchAttempt);
            expect(await readlink(currentPath)).toBe(`releases/${b}`);
            expect(await dockerOk(["compose", "-p", project, "-f", composeFile, "ps", "-q", "web"], stackDir)).toBe("");

            // The pointer says B while the surviving PHP process still
            // serves A: no deploy may claim a verified baseline.
            await dockerOk(["compose", "-p", project, "-f", composeFile, "start", "web"], stackDir);
            await waitForRevision(probe, a);
            expect(await readBaseline(stackDir, siteId)).toMatchObject({ ok: true, releaseId: b });
            const ambiguous = await deployWithE2E({ ...config, attemptId: attempt(8) });
            expect(ambiguous.kind).toBe("refused");
            if (ambiguous.kind === "refused") expect(ambiguous.reason).toContain("baseline is not provable");
            expect(await readPendingDeployAttempt(stackDir)).not.toEqual({ kind: "none" });
            expect(await dockerOk(["compose", "-p", project, "-f", composeFile, "ps", "-q", "web"], stackDir)).not.toBe("");

            // Inspection resolves it: the pointer goes back to A, which
            // the running process already serves, then the attempt is
            // acknowledged.
            expect(await switchCurrent(runtimeDir, a)).toEqual({ ok: true });
            await waitForRevision(probe, a);
            await unlink(managedSiteAttemptPath(stackDir));

            // ---- the site works again ----
            const recovered = await deployWithE2E({ ...config, attemptId: attempt(9) });
            expect(recovered.kind).toBe("deployed");
            await waitForRevision(probe, b);
            expect(await fetchInLab("/")).toBe(`${b}\n`);
            expect(await fetchInLab("/version.txt")).toBe("two\n");
            expect(await dockerOk(["compose", "-p", project, "-f", composeFile, "ps", "-q", "web"], stackDir)).toBe(gatewayId);
            expect(existsSync(managedSiteAttemptPath(stackDir))).toBe(false);

            // ---- the second stack was never touched ----
            expect(await dockerOk(["compose", "-p", bystanderProject, "-f", bystanderFile, "ps", "-q", "idle"])).toBe(bystanderId);
        } finally {
            await runCommand("docker", ["compose", "-p", project, "-f", composeFile, "down", "-v", "--remove-orphans"], {
                cwd: stackDir,
                timeoutMs: 120_000,
            }).catch(() => {});
            await runCommand("docker", ["compose", "-p", bystanderProject, "-f", bystanderFile, "down", "-v", "--remove-orphans"], {
                timeoutMs: 120_000,
            }).catch(() => {});
            await rm(root, { recursive: true, force: true });
        }
    }, 600_000);

    test("the generated gateway follows a runtime IP change without recreating the gateway", async () => {
        requireEnv();
        const testPort = 41000 + (port % 900);
        const root = await mkdtemp(join(realpathSync(shared), "managed-site-ip-"));
        const stackDir = join(root, "stack");
        const project = `cp-ip-${process.pid}`;
        const sha = "e".repeat(40);
        const runtimeDir = join(stackDir, MANAGED_SITE_PATHS.runtime);
        const currentPath = join(runtimeDir, "current");
        const composeFile = join(stackDir, "compose.yaml");
        const probe = createLabProbe({ labContainer, labOuterContext });
        const compose = async (...args: string[]): Promise<string> => {
            const result = await runCommand("docker", ["compose", "-p", project, "-f", composeFile, ...args], {
                cwd: stackDir,
                timeoutMs: 180_000,
                maxBytes: 8 * 1024 * 1024,
            });
            if (result.code !== 0 || result.timedOut) {
                throw new Error(
                    `docker compose ${args.join(" ")} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
                );
            }
            return result.stdout.trim();
        };
        try {
            await chmod(root, 0o755);
            await mkdir(stackDir, { recursive: true });
            const built = buildManagedSite({
                stackDir,
                siteId: `cp-ip-${process.pid}`,
                project,
                port: testPort,
                gitUrl: GIT_URL,
                gitRef: GIT_REF,
                channel: "php-8.3",
            });
            if (!built.ok) throw new Error(built.reason);
            await writeFile(composeFile, built.artifacts.compose);
            await writeFile(join(stackDir, "compose-panel-site.json"), built.manifestSource);
            await mkdir(join(stackDir, "generated"), { recursive: true });
            await writeFile(join(stackDir, "generated", "nginx-site.conf"), built.artifacts.gateway);
            await writeFile(join(stackDir, "generated", "opcache.ini"), built.artifacts.opcache);
            const release = join(runtimeDir, "releases", sha);
            await mkdir(join(release, ".compose-panel"), { recursive: true });
            await mkdir(join(release, "public"), { recursive: true });
            await writeFile(join(release, "public", "index.php"), `<?php require dirname(__DIR__) . '/.compose-panel/revision.php';\n`);
            await writeFile(join(release, ".compose-panel", "revision.php"), revisionScript(sha));
            await mkdir(join(stackDir, "site", "private", "releases"), { recursive: true });
            await writeFile(
                join(stackDir, "site", "private", "releases", `${sha}.json`),
                `${JSON.stringify({ version: 1, siteId: built.manifest.siteId, release: sha, status: "complete" })}\n`,
            );
            await symlink(`releases/${sha}`, currentPath);

            await compose("up", "-d", "--pull", "never");
            try {
                await waitForRevision(probe, sha, 60_000, testPort);
            } catch (error) {
                console.error("gateway ps:", await compose("ps"));
                console.error("gateway logs:", await compose("logs", "gateway"));
                console.error("runtime logs:", await compose("logs", "runtime"));
                throw error;
            }
            const gatewayId = await compose("ps", "-q", "gateway");
            const runtimeBefore = await compose("ps", "-q", "runtime");
            const ipBefore = await dockerOk(["inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", runtimeBefore]);

            await compose("up", "-d", "--no-deps", "--no-build", "--pull", "never", "--force-recreate", "runtime");
            const runtimeAfter = await compose("ps", "-q", "runtime");
            expect(runtimeAfter).not.toBe(runtimeBefore);
            expect(await compose("ps", "-q", "gateway")).toBe(gatewayId);
            let ipAfter = await dockerOk(["inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", runtimeAfter]);
            if (ipAfter === ipBefore) {
                // Docker may reuse the freed address. Move the runtime to another
                // address on its own network while keeping the same containers.
                const network = `${project}_site`;
                const subnet = await dockerOk(["network", "inspect", "-f", "{{range .IPAM.Config}}{{.Subnet}}{{end}}", network]);
                const prefix = subnet.split("/")[0]!.split(".").slice(0, 3).join(".");
                const gatewayIp = await dockerOk(["inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", gatewayId]);
                let moved = false;
                for (const last of [250, 251, 249, 248, 247, 246]) {
                    const candidate = `${prefix}.${last}`;
                    if (candidate === ipBefore || candidate === gatewayIp) continue;
                    const disconnected = await runCommand("docker", ["network", "disconnect", network, runtimeAfter], {
                        timeoutMs: 30_000,
                        maxBytes: 1024 * 1024,
                    });
                    if (disconnected.code !== 0) continue;
                    const connected = await runCommand(
                        "docker",
                        ["network", "connect", "--ip", candidate, "--alias", "runtime", network, runtimeAfter],
                        {
                            timeoutMs: 30_000,
                            maxBytes: 1024 * 1024,
                        },
                    );
                    if (connected.code === 0) {
                        ipAfter = candidate;
                        moved = true;
                        break;
                    }
                    await runCommand("docker", ["network", "connect", "--alias", "runtime", network, runtimeAfter], {
                        timeoutMs: 30_000,
                        maxBytes: 1024 * 1024,
                    }).catch(() => {});
                }
                expect(moved).toBe(true);
            }
            expect(ipAfter).not.toBe(ipBefore);
            expect(await compose("ps", "-q", "gateway")).toBe(gatewayId);

            // The generated config resolves `runtime` through Docker DNS on
            // every request. The old static upstream would keep the previous IP
            // until the config was reloaded or the gateway recreated.
            try {
                await waitForRevision(probe, sha, 30_000, testPort);
            } catch (error) {
                console.error("gateway logs after IP change:", await compose("logs", "gateway"));
                console.error("runtime logs after IP change:", await compose("logs", "runtime"));
                throw error;
            }
            expect(await fetchInLab("/", testPort)).toBe(`${sha}\n`);
        } finally {
            await runCommand("docker", ["compose", "-p", project, "-f", composeFile, "down", "-v", "--remove-orphans"], {
                cwd: stackDir,
                timeoutMs: 120_000,
            }).catch(() => {});
            await rm(root, { recursive: true, force: true });
        }
    }, 300_000);
});
