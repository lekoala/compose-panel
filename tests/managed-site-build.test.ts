import { describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult, RunOptions } from "../src/docker.ts";
import { MANAGED_SITE_BUILD_IMAGE, composerPreparation, runComposerPreparation } from "../src/managed-site-build.ts";
import { parseManagedSiteManifest, type ManagedSiteManifest } from "../src/managed-site.ts";

const ATTEMPT = "attempt0001";

function result(overrides: Partial<CommandResult> = {}): CommandResult {
    return { code: 0, stdout: "", stderr: "", timedOut: false, truncated: false, ...overrides };
}

interface FakeDocker {
    calls: string[][];
    runner: (args: string[], options: RunOptions) => Promise<CommandResult>;
}

/**
 * Answers the fixed `docker run`, `docker rm` and `docker ps` commands. The
 * first run is the offline lock check; the second is the install.
 */
function fakeDocker(
    options: {
        validate?: (args: string[]) => Promise<CommandResult> | CommandResult;
        install?: (args: string[], runOptions: RunOptions) => Promise<CommandResult> | CommandResult;
        rm?: CommandResult;
    } = {},
): FakeDocker {
    const calls: string[][] = [];
    let runs = 0;
    return {
        calls,
        runner: async (args, runOptions) => {
            calls.push(args);
            if (args[0] === "run") {
                runs += 1;
                if (runs === 1) return options.validate ? options.validate(args) : result();
                return options.install ? options.install(args, runOptions) : result();
            }
            if (args[0] === "rm") return options.rm ?? result();
            if (args[0] === "ps") return result({ stdout: "" });
            return result();
        },
    };
}

async function makeTree(
    composerJson = '{"name":"acme/root","require":{},"config":{"platform":{"php":"8.3.0"}}}',
    lockJson = '{"platform-overrides":{"php":"8.3.0"},"packages":[]}',
): Promise<{ stack: string; tree: string }> {
    const stack = await mkdtemp(join(tmpdir(), "cp-build-"));
    const tree = join(stack, "site", "staging", ATTEMPT, "tree");
    await mkdir(join(tree, "public"), { recursive: true });
    await writeFile(join(tree, "public", "index.php"), "<?php echo 'ok';\n");
    await writeFile(join(tree, "composer.json"), composerJson);
    await writeFile(join(tree, "composer.lock"), lockJson);
    return { stack, tree };
}

function request(stack: string, tree: string, runner: FakeDocker["runner"], overrides: Record<string, unknown> = {}) {
    return runComposerPreparation({
        stackDir: stack,
        attemptId: ATTEMPT,
        tree,
        phpMinor: "8.3",
        runner,
        ...overrides,
    });
}

function runCalls(docker: FakeDocker): string[][] {
    return docker.calls.filter((args) => args[0] === "run");
}

describe("runComposerPreparation", () => {
    test("checks the lock offline, then installs in one unprivileged container", async () => {
        const { stack, tree } = await makeTree();
        try {
            const docker = fakeDocker({
                install: async () => {
                    await mkdir(join(tree, "vendor"), { recursive: true });
                    await writeFile(join(tree, "vendor", "autoload.php"), "<?php\n");
                    return result();
                },
            });
            const outcome = await request(stack, tree, docker.runner);
            expect(outcome).toEqual({ ok: true, image: MANAGED_SITE_BUILD_IMAGE });

            const runs = runCalls(docker);
            expect(runs).toHaveLength(2);
            const [validate, install] = runs as [string[], string[]];

            // The lock check is offline and reads the tree read-only.
            expect(validate).toContain("--network");
            expect(validate[validate.indexOf("--network") + 1]).toBe("none");
            expect(validate).toContain(`${tree}:/src:ro`);
            expect(validate).toContain("validate");
            expect(validate).toContain("--no-check-publish");
            expect(validate).toContain("--no-check-all");
            expect(validate).toContain(MANAGED_SITE_BUILD_IMAGE);

            // The install is unprivileged, read-only, and only the tree is writable.
            expect(install).toContain("--read-only");
            expect(install).toContain("--cap-drop");
            expect(install).toContain("ALL");
            expect(install).toContain("--security-opt");
            expect(install).toContain("no-new-privileges");
            expect(install).toContain("--network");
            expect(install[install.indexOf("--network") + 1]).toBe("bridge");
            expect(install).toContain("--pids-limit");
            expect(install).toContain("--memory");
            expect(install).toContain("--cpus");
            expect(install).toContain(`${tree}:/src`);
            expect(install.filter((value) => value === "-v")).toHaveLength(1);
            // The cache and home are on a bounded tmpfs, not in the tree.
            expect(install).toContain("/composer:rw,noexec,nosuid,nodev,size=256m,mode=1777");
            expect(install).toContain("COMPOSER_HOME=/composer/home");
            expect(install).toContain("COMPOSER_CACHE_DIR=/composer/cache");
            expect(install.join(" ")).not.toContain("docker.sock");
            expect(install.join(" ")).not.toContain("/site/private");
            expect(install.join(" ")).not.toContain("/site/runtime");
            expect(install).toContain(MANAGED_SITE_BUILD_IMAGE);
            expect(install.slice(install.indexOf(MANAGED_SITE_BUILD_IMAGE) + 1)).toEqual([
                "--no-plugins",
                "--no-interaction",
                "install",
                "--no-dev",
                "--no-progress",
                "--prefer-dist",
                "--no-scripts",
                "--no-ansi",
            ]);
            expect(await readFile(join(tree, "vendor", "autoload.php"), "utf8")).toBe("<?php\n");
            await expect(lstat(join(tree, ".compose-panel-build"))).rejects.toThrow();
        } finally {
            await rm(stack, { recursive: true, force: true });
        }
    });

    test("refuses a missing or wrong lock platform, a stale composer platform and reserved paths before Docker", async () => {
        const { stack, tree } = await makeTree();
        try {
            const docker = fakeDocker();
            await rm(join(tree, "composer.lock"));
            const missing = await request(stack, tree, docker.runner);
            expect(missing.ok).toBe(false);
            if (!missing.ok) expect(missing.reason).toContain("composer.lock");

            await writeFile(join(tree, "composer.lock"), '{"packages":[]}');
            const noOverrides = await request(stack, tree, docker.runner);
            expect(noOverrides.ok).toBe(false);
            if (!noOverrides.ok) expect(noOverrides.reason).toContain("platform-overrides.php");

            await writeFile(join(tree, "composer.lock"), '{"platform-overrides":{"php":"8.4.0"},"packages":[]}');
            const wrongLock = await request(stack, tree, docker.runner);
            expect(wrongLock.ok).toBe(false);
            if (!wrongLock.ok) expect(wrongLock.reason).toContain("PHP 8.3");

            await writeFile(join(tree, "composer.lock"), '{"platform-overrides":{"php":"8.3.0"},"packages":[]}');
            await writeFile(join(tree, "composer.json"), '{"config":{"platform":{"php":"8.4.0"}}}');
            const wrongJson = await request(stack, tree, docker.runner);
            expect(wrongJson.ok).toBe(false);
            if (!wrongJson.ok) expect(wrongJson.reason).toContain("PHP 8.3");

            await writeFile(join(tree, "composer.json"), '{"require":{}}');
            const undeclared = await request(stack, tree, docker.runner);
            expect(undeclared.ok).toBe(false);
            if (!undeclared.ok) expect(undeclared.reason).toContain("config.platform.php");

            await writeFile(join(tree, "composer.json"), '{"config":{"platform":{"php":"8.3.0"}}}');
            await mkdir(join(tree, ".compose-panel-build"));
            const reserved = await request(stack, tree, docker.runner);
            expect(reserved.ok).toBe(false);
            if (!reserved.ok) expect(reserved.reason).toContain(".compose-panel-build");
            await rm(join(tree, ".compose-panel-build"), { recursive: true });

            await mkdir(join(tree, "vendor"));
            const committedVendor = await request(stack, tree, docker.runner);
            expect(committedVendor.ok).toBe(false);
            if (!committedVendor.ok) expect(committedVendor.reason).toContain("must not commit vendor/");

            if (process.platform !== "win32") {
                await rm(join(tree, "vendor"), { recursive: true });
                await rm(join(tree, "composer.json"));
                await symlink(join(stack, "outside.json"), join(tree, "composer.json"));
                const linked = await request(stack, tree, docker.runner);
                expect(linked.ok).toBe(false);
                if (!linked.ok) expect(linked.reason).toContain("symbolic link");
            }

            expect(docker.calls).toEqual([]);
        } finally {
            await rm(stack, { recursive: true, force: true });
        }
    });

    test("refuses a tree that is not this attempt's staging directory", async () => {
        const { stack } = await makeTree();
        try {
            const docker = fakeDocker();
            const outcome = await runComposerPreparation({
                stackDir: stack,
                attemptId: ATTEMPT,
                tree: join(stack, "elsewhere"),
                phpMinor: "8.3",
                runner: docker.runner,
            });
            expect(outcome.ok).toBe(false);
            expect(docker.calls).toEqual([]);
        } finally {
            await rm(stack, { recursive: true, force: true });
        }
    });

    test("stops after a stale or invalid lock and never installs", async () => {
        const { stack, tree } = await makeTree();
        try {
            const docker = fakeDocker({ validate: () => result({ code: 2, stdout: "The lock file is not up to date" }) });
            const outcome = await request(stack, tree, docker.runner);
            expect(outcome.ok).toBe(false);
            if (!outcome.ok) {
                expect(outcome.reason).toContain("composer update");
                expect(outcome.reason).not.toContain("not up to date");
            }
            expect(runCalls(docker)).toHaveLength(1);
            expect(docker.calls.some((args) => args[0] === "rm")).toBe(true);
        } finally {
            await rm(stack, { recursive: true, force: true });
        }
    });

    test("keeps the attempt when a container removal cannot be proven", async () => {
        const { stack, tree } = await makeTree();
        try {
            const docker = fakeDocker({ validate: () => result({ code: 1 }), rm: result({ terminationUnconfirmed: true }) });
            const outcome = await request(stack, tree, docker.runner);
            expect(outcome).toMatchObject({ ok: false, unconfirmed: true });
        } finally {
            await rm(stack, { recursive: true, force: true });
        }
    });

    test("reports a failed install without echoing its output", async () => {
        const { stack, tree } = await makeTree();
        try {
            const docker = fakeDocker({ install: () => result({ code: 1, stderr: "COMPOSER_AUTH=secret-token" }) });
            const outcome = await request(stack, tree, docker.runner);
            expect(outcome.ok).toBe(false);
            if (!outcome.ok) {
                expect(outcome.reason).not.toContain("secret-token");
                expect(outcome.unconfirmed).toBe(false);
            }
        } finally {
            await rm(stack, { recursive: true, force: true });
        }
    });

    test("stops an install that exceeds the release size cap", async () => {
        const { stack, tree } = await makeTree();
        try {
            const docker = fakeDocker({
                install: async (_args, runOptions) => {
                    await writeFile(join(tree, "big.bin"), Buffer.alloc(4096));
                    await new Promise<void>((resolve) => {
                        if (runOptions.signal?.aborted) return resolve();
                        runOptions.signal?.addEventListener("abort", () => resolve(), { once: true });
                    });
                    return result({ timedOut: true });
                },
            });
            const outcome = await request(stack, tree, docker.runner, { maxTreeBytes: 1024, monitorIntervalMs: 10 });
            expect(outcome.ok).toBe(false);
            if (!outcome.ok) expect(outcome.reason).toContain("size cap");
        } finally {
            await rm(stack, { recursive: true, force: true });
        }
    });

    test("stops an install that creates too many files", async () => {
        const { stack, tree } = await makeTree();
        try {
            const docker = fakeDocker({
                install: async (_args, runOptions) => {
                    for (let i = 0; i < 5; i += 1) await writeFile(join(tree, `f${i}.txt`), "x");
                    await new Promise<void>((resolve) => {
                        if (runOptions.signal?.aborted) return resolve();
                        runOptions.signal?.addEventListener("abort", () => resolve(), { once: true });
                    });
                    return result({ timedOut: true });
                },
            });
            const outcome = await request(stack, tree, docker.runner, { maxFiles: 2, monitorIntervalMs: 10 });
            expect(outcome.ok).toBe(false);
            if (!outcome.ok) expect(outcome.reason).toContain("size cap");
        } finally {
            await rm(stack, { recursive: true, force: true });
        }
    });

    test("cancels a running install and proves its container removed", async () => {
        const { stack, tree } = await makeTree();
        try {
            const controller = new AbortController();
            const docker = fakeDocker({
                install: async (_args, runOptions) => {
                    await new Promise<void>((resolve) => {
                        if (runOptions.signal?.aborted) return resolve();
                        runOptions.signal?.addEventListener("abort", () => resolve(), { once: true });
                    });
                    return result({ timedOut: true });
                },
            });
            const pending = request(stack, tree, docker.runner, { signal: controller.signal });
            controller.abort();
            const outcome = await pending;
            expect(outcome.ok).toBe(false);
            if (!outcome.ok) {
                expect(outcome.reason).toContain("cancelled");
                expect(outcome.unconfirmed).toBe(false);
            }
            expect(docker.calls.some((args) => args[0] === "rm")).toBe(true);
        } finally {
            await rm(stack, { recursive: true, force: true });
        }
    });

    test("refuses a run that leaves no regular vendor/autoload.php", async () => {
        const { stack, tree } = await makeTree();
        try {
            const docker = fakeDocker();
            const outcome = await request(stack, tree, docker.runner);
            expect(outcome.ok).toBe(false);
            if (!outcome.ok) expect(outcome.reason).toContain("vendor/autoload.php");
        } finally {
            await rm(stack, { recursive: true, force: true });
        }
    });

    test("is absent unless the manifest declares it", () => {
        const manifest = JSON.parse(
            JSON.stringify({
                version: 1,
                siteId: "acme-shop",
                owner: "managed",
                project: "acme-shop",
                services: { gateway: "gateway", runtime: "runtime" },
                gateway: { port: 41001 },
                publicRoot: "public",
                runtime: { profile: "php-front-controller", image: "php:8.3-fpm-alpine" },
                deploy: { kind: "bind-mount", git: { url: "https://github.com/acme/shop.git", ref: "refs/heads/main" } },
                generation: "1",
            }),
        ) as Record<string, unknown>;
        const plain = parseManagedSiteManifest(JSON.stringify(manifest));
        expect(plain.ok).toBe(true);
        if (!plain.ok) return;
        expect(composerPreparation(plain.manifest)).toBeUndefined();

        manifest.build = { kind: "composer" };
        const parsed = parseManagedSiteManifest(JSON.stringify(manifest));
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        expect(typeof composerPreparation(parsed.manifest)).toBe("function");
        const unknownChannel: ManagedSiteManifest = { ...parsed.manifest, runtime: { ...parsed.manifest.runtime, image: "php:9.0-fpm" } };
        expect(typeof composerPreparation(unknownChannel)).toBe("function");
    });
});
