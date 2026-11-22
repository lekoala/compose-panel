import { describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult, RunOptions } from "../src/docker.ts";
import {
    MANAGED_SITE_BUILD_IMAGE,
    MANAGED_SITE_BUILD_SCRATCH,
    composerPreparation,
    runComposerPreparation,
} from "../src/managed-site-build.ts";
import { parseManagedSiteManifest, type ManagedSiteManifest } from "../src/managed-site.ts";

const ATTEMPT = "attempt0001";

function result(overrides: Partial<CommandResult> = {}): CommandResult {
    return { code: 0, stdout: "", stderr: "", timedOut: false, truncated: false, ...overrides };
}

interface FakeDocker {
    calls: string[][];
    runner: (args: string[], options: RunOptions) => Promise<CommandResult>;
}

/** Answers the fixed `docker run`, `docker rm` and `docker ps` commands. */
function fakeDocker(options: { run?: (args: string[]) => Promise<CommandResult> | CommandResult; rm?: CommandResult } = {}): FakeDocker {
    const calls: string[][] = [];
    return {
        calls,
        runner: async (args) => {
            calls.push(args);
            if (args[0] === "run") return options.run ? options.run(args) : result();
            if (args[0] === "rm") return options.rm ?? result();
            if (args[0] === "ps") return result({ stdout: "" });
            return result();
        },
    };
}

async function makeTree(composerJson = '{"config":{"platform":{"php":"8.3.0"}}}'): Promise<{ stack: string; tree: string }> {
    const stack = await mkdtemp(join(tmpdir(), "cp-build-"));
    const tree = join(stack, "site", "staging", ATTEMPT, "tree");
    await mkdir(join(tree, "public"), { recursive: true });
    await writeFile(join(tree, "public", "index.php"), "<?php echo 'ok';\n");
    await writeFile(join(tree, "composer.json"), composerJson);
    await writeFile(join(tree, "composer.lock"), '{"packages":[]}\n');
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

describe("runComposerPreparation", () => {
    test("builds in one unprivileged, read-only container with a single writable mount", async () => {
        const { stack, tree } = await makeTree();
        try {
            const docker = fakeDocker({
                run: async () => {
                    await mkdir(join(tree, "vendor"), { recursive: true });
                    await writeFile(join(tree, "vendor", "autoload.php"), "<?php\n");
                    await mkdir(join(tree, MANAGED_SITE_BUILD_SCRATCH, "home"), { recursive: true });
                    return result();
                },
            });
            const outcome = await request(stack, tree, docker.runner);
            expect(outcome).toEqual({ ok: true, image: MANAGED_SITE_BUILD_IMAGE });

            const run = docker.calls.find((args) => args[0] === "run")!;
            expect(run).toContain("--rm");
            expect(run).toContain("--read-only");
            expect(run).toContain("--cap-drop");
            expect(run).toContain("ALL");
            expect(run).toContain("--security-opt");
            expect(run).toContain("no-new-privileges");
            expect(run).toContain("--network");
            expect(run).toContain("bridge");
            expect(run).toContain("--pids-limit");
            expect(run).toContain("--memory");
            expect(run).toContain("--cpus");
            expect(run).toContain(`${tree}:/build`);
            expect(run.filter((value) => value === "-v")).toHaveLength(1);
            expect(run.join(" ")).not.toContain("docker.sock");
            expect(run.join(" ")).not.toContain("/site/private");
            expect(run.join(" ")).not.toContain("/site/runtime");
            expect(run).toContain(MANAGED_SITE_BUILD_IMAGE);
            expect(run.slice(run.indexOf(MANAGED_SITE_BUILD_IMAGE) + 1)).toEqual([
                "install",
                "--no-interaction",
                "--no-dev",
                "--no-progress",
                "--prefer-dist",
                "--no-scripts",
                "--no-plugins",
                "--optimize-autoloader",
                "--no-ansi",
            ]);
            // The scratch cache and home never reach the published release.
            expect(await readFile(join(tree, "vendor", "autoload.php"), "utf8")).toBe("<?php\n");
            await expect(lstat(join(tree, MANAGED_SITE_BUILD_SCRATCH))).rejects.toThrow();
        } finally {
            await rm(stack, { recursive: true, force: true });
        }
    });

    test("refuses a missing lock file, a mismatched platform and a symlinked composer.json before Docker", async () => {
        const { stack, tree } = await makeTree();
        try {
            const docker = fakeDocker();
            await rm(join(tree, "composer.lock"));
            const missing = await request(stack, tree, docker.runner);
            expect(missing.ok).toBe(false);
            if (!missing.ok) expect(missing.reason).toContain("composer.lock");

            await writeFile(join(tree, "composer.lock"), '{"packages":[]}\n');
            await writeFile(join(tree, "composer.json"), '{"config":{"platform":{"php":"8.4.0"}}}');
            const mismatch = await request(stack, tree, docker.runner);
            expect(mismatch.ok).toBe(false);
            if (!mismatch.ok) expect(mismatch.reason).toContain("PHP 8.3");

            await writeFile(join(tree, "composer.json"), '{"require":{}}');
            const undeclared = await request(stack, tree, docker.runner);
            expect(undeclared.ok).toBe(false);
            if (!undeclared.ok) expect(undeclared.reason).toContain("config.platform.php");

            if (process.platform !== "win32") {
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

    test("keeps the attempt when the container removal cannot be proven", async () => {
        const { stack, tree } = await makeTree();
        try {
            const docker = fakeDocker({ run: () => result({ code: 1 }), rm: result({ terminationUnconfirmed: true }) });
            const outcome = await request(stack, tree, docker.runner);
            expect(outcome).toMatchObject({ ok: false, unconfirmed: true });
        } finally {
            await rm(stack, { recursive: true, force: true });
        }
    });

    test("reports a failed Composer run without echoing its output", async () => {
        const { stack, tree } = await makeTree();
        try {
            const docker = fakeDocker({ run: () => result({ code: 1, stderr: "COMPOSER_AUTH=secret-token" }) });
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
