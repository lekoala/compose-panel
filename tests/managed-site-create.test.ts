import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult } from "../src/docker.ts";
import type { ComposeProvider } from "../src/compose-provider.ts";
import { createManagedSite, findManagedSitePortOwner } from "../src/create-managed-site.ts";
import { buildManagedSite } from "../src/managed-site-generate.ts";
import { publishManagedSiteBaseline } from "../src/managed-site-baseline.ts";
import { parseManagedSiteManifest } from "../src/managed-site.ts";
import { readBaseline } from "../src/managed-site-deploy.ts";
import { revisionScript, type GitReleaseRequest, type GitReleaseResult } from "../src/git-release.ts";

const ok: CommandResult = { code: 0, stdout: "", stderr: "", timedOut: false, truncated: false };

function provider(): ComposeProvider {
    return {
        validateConfig: async () => ok,
        projectName: async () => "acme-shop",
        listProjects: async () => ({ ...ok, stdout: "[]" }),
    } as unknown as ComposeProvider;
}

async function site(stackName = "acme-shop") {
    const root = await mkdtemp(join(tmpdir(), "compose-panel-create-site-"));
    const built = buildManagedSite({
        stackDir: join(root, stackName),
        siteId: stackName,
        project: stackName,
        port: 41001,
        gitUrl: "https://github.com/acme/shop.git",
        gitRef: "refs/heads/main",
        channel: "php-8.3",
        paths: ["shared/uploads/avatars"],
    });
    if (!built.ok) throw new Error(built.reason);
    await createManagedSite(root, { stackName, manifestSource: built.manifestSource, artifacts: built.artifacts }, provider(), 1024 * 1024);
    return { root, stackDir: join(root, stackName) };
}

describe("findManagedSitePortOwner", () => {
    test("reports a port declared by another managed site and ignores opt-in stacks", async () => {
        const root = await mkdtemp(join(tmpdir(), "compose-panel-ports-"));
        try {
            for (const [name, port] of [
                ["one", 41001],
                ["two", 41002],
            ] as const) {
                await mkdir(join(root, name));
                await writeFile(join(root, name, "compose.yaml"), "services:\n  web:\n    image: nginx\n");
                const manifest = {
                    version: 1,
                    siteId: name,
                    owner: "managed",
                    project: name,
                    services: { gateway: "gateway", runtime: "runtime" },
                    gateway: { port },
                    publicRoot: "public",
                    runtime: { profile: "php-front-controller", image: "php:8.3-fpm-alpine" },
                    deploy: { kind: "bind-mount", git: { url: "https://github.com/acme/shop.git", ref: "refs/heads/main" } },
                    generation: "1",
                };
                await writeFile(join(root, name, "compose-panel-site.json"), JSON.stringify(manifest));
            }
            await mkdir(join(root, "three"));
            await writeFile(join(root, "three", "compose.yaml"), "services:\n  web:\n    image: nginx\n");
            await writeFile(
                join(root, "three", "compose-panel-site.json"),
                JSON.stringify({
                    version: 1,
                    siteId: "three",
                    owner: "opt-in",
                    project: "three",
                    services: { gateway: "web", runtime: "php" },
                    publicRoot: "public",
                    runtime: { profile: "php-front-controller" },
                    deploy: { kind: "bind-mount", git: { url: "https://github.com/acme/shop.git", ref: "refs/heads/main" } },
                }),
            );
            expect(await findManagedSitePortOwner(root, 41001, null)).toEqual({ kind: "used", stack: "one" });
            expect(await findManagedSitePortOwner(root, 41001, "one")).toEqual({ kind: "free" });
            expect(await findManagedSitePortOwner(root, 41999, null)).toEqual({ kind: "free" });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});

describe.skipIf(process.platform !== "linux")("createManagedSite", () => {
    test("writes the generated files and the private release layout", async () => {
        const { root, stackDir } = await site();
        try {
            const manifest = parseManagedSiteManifest(await readFile(join(stackDir, "compose-panel-site.json"), "utf8"));
            expect(manifest.ok).toBe(true);
            if (!manifest.ok) return;
            expect(manifest.manifest.owner).toBe("managed");
            expect(manifest.manifest.gateway).toEqual({ port: 41001 });
            expect(await readFile(join(stackDir, "compose.yaml"), "utf8")).toContain('"127.0.0.1:41001:80"');
            expect(await readFile(join(stackDir, "compose.yaml"), "utf8")).toContain(`source: '${stackDir}/site/shared/uploads/avatars'`);
            expect(await readFile(join(stackDir, "generated", "nginx-site.conf"), "utf8")).toContain(
                `root ${stackDir}/site/runtime/current/public;`,
            );
            expect((await stat(join(stackDir, "site", "staging"))).mode & 0o777).toBe(0o700);
            expect((await stat(join(stackDir, "site", "private"))).mode & 0o777).toBe(0o700);
            expect((await stat(join(stackDir, "site", "runtime", "releases"))).mode & 0o777).toBe(0o755);
            expect((await stat(join(stackDir, "site", "shared", "uploads", "avatars"))).mode & 0o777).toBe(0o755);
            expect((await stat(stackDir)).mode & 0o777).toBe(0o755);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("writes a database site without creating the private env file", async () => {
        const root = await mkdtemp(join(tmpdir(), "compose-panel-create-db-"));
        const stackName = "acme-shop";
        const stackDir = join(root, stackName);
        try {
            const built = buildManagedSite({
                stackDir,
                siteId: stackName,
                project: stackName,
                port: 41001,
                gitUrl: "https://github.com/acme/shop.git",
                gitRef: "refs/heads/main",
                channel: "php-8.3",
                database: { engine: "postgresql", network: "acme-db" },
            });
            if (!built.ok) throw new Error(built.reason);
            await createManagedSite(
                root,
                { stackName, manifestSource: built.manifestSource, artifacts: built.artifacts },
                provider(),
                1024 * 1024,
            );
            const compose = await readFile(join(stackDir, "compose.yaml"), "utf8");
            expect(compose).toContain("env_file:");
            expect(compose).toContain("database.env");
            expect(compose).toContain("'acme-db'");
            expect(await Bun.file(join(stackDir, "site", "private", "database.env")).exists()).toBe(false);
            const manifest = parseManagedSiteManifest(await readFile(join(stackDir, "compose-panel-site.json"), "utf8"));
            expect(manifest.ok).toBe(true);
            if (!manifest.ok) return;
            expect(manifest.manifest.version).toBe(2);
            expect(manifest.manifest.database).toEqual({ kind: "existing", engine: "postgresql", network: "acme-db" });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("refuses an existing folder without overwriting it", async () => {
        const { root, stackDir } = await site();
        try {
            const built = buildManagedSite({
                stackDir,
                siteId: "acme-shop",
                project: "acme-shop",
                port: 41002,
                gitUrl: "https://github.com/acme/other.git",
                gitRef: "refs/heads/main",
                channel: "php-8.4",
            });
            if (!built.ok) throw new Error(built.reason);
            await expect(
                createManagedSite(
                    root,
                    { stackName: "acme-shop", manifestSource: built.manifestSource, artifacts: built.artifacts },
                    provider(),
                    1024 * 1024,
                ),
            ).rejects.toThrow();
            expect(await readFile(join(stackDir, "compose-panel-site.json"), "utf8")).toContain('"siteId": "acme-shop"');
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("publishes nothing when creation is interrupted before the rename", async () => {
        const root = await mkdtemp(join(tmpdir(), "compose-panel-create-interrupt-"));
        try {
            const stackDir = join(root, "acme-shop");
            const built = buildManagedSite({
                stackDir,
                siteId: "acme-shop",
                project: "acme-shop",
                port: 41001,
                gitUrl: "https://github.com/acme/shop.git",
                gitRef: "refs/heads/main",
                channel: "php-8.3",
            });
            if (!built.ok) throw new Error(built.reason);
            let finalWasAbsent = false;
            await expect(
                createManagedSite(
                    root,
                    { stackName: "acme-shop", manifestSource: built.manifestSource, artifacts: built.artifacts },
                    provider(),
                    1024 * 1024,
                    {
                        beforePublish: async () => {
                            finalWasAbsent = !(await Bun.file(join(stackDir, "compose.yaml")).exists());
                            throw new Error("interrupted");
                        },
                    },
                ),
            ).rejects.toThrow("interrupted");
            expect(finalWasAbsent).toBe(true);
            expect(await Bun.file(join(stackDir, "compose.yaml")).exists()).toBe(false);
            expect((await readdir(root)).filter((entry) => entry.startsWith(".cp-site-"))).toEqual([]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});

describe.skipIf(process.platform !== "linux")("publishManagedSiteBaseline", () => {
    const SHA = "c".repeat(40);

    async function fakeRelease(stackDir: string): Promise<GitReleaseResult> {
        const release = join(stackDir, "site", "runtime", "releases", SHA);
        await mkdir(join(release, ".compose-panel"), { recursive: true });
        await mkdir(join(release, "public"), { recursive: true });
        await writeFile(join(release, "public", "index.php"), "<?php echo 'ok';\n");
        await writeFile(join(release, ".compose-panel", "revision.php"), revisionScript(SHA));
        await mkdir(join(stackDir, "site", "private", "releases"), { recursive: true });
        await writeFile(
            join(stackDir, "site", "private", "releases", `${SHA}.json`),
            `${JSON.stringify({ version: 1, siteId: "acme-shop", release: SHA, status: "complete" })}\n`,
        );
        return {
            ok: true,
            releaseId: SHA,
            releasePath: release,
            metadataPath: join(stackDir, "site", "private", "releases", `${SHA}.json`),
            reused: false,
        };
    }

    test("forwards the fixed release preparation to the fetch", async () => {
        const { root, stackDir } = await site();
        try {
            const manifest = parseManagedSiteManifest(await readFile(join(stackDir, "compose-panel-site.json"), "utf8"));
            if (!manifest.ok) throw new Error(manifest.reason);
            let captured: GitReleaseRequest | undefined;
            const prepare = async () => ({ ok: true as const });
            const limits = { maxFiles: 10, maxTreeBytes: 1024, maxDepth: 4 };
            const publish = async (request: GitReleaseRequest): Promise<GitReleaseResult> => {
                captured = request;
                return fakeRelease(request.stackDir);
            };
            const result = await publishManagedSiteBaseline({
                stackDir,
                manifest: manifest.manifest,
                attemptId: "attempt0001",
                publish,
                prepare,
                releaseLimits: limits,
            });
            expect(result.kind).toBe("published");
            expect(captured?.prepare).toBe(prepare);
            expect(captured?.releaseLimits).toEqual(limits);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("publishes once, points current and proves the baseline", async () => {
        const { root, stackDir } = await site();
        try {
            const manifest = parseManagedSiteManifest(await readFile(join(stackDir, "compose-panel-site.json"), "utf8"));
            if (!manifest.ok) throw new Error(manifest.reason);
            const publish = async (request: GitReleaseRequest): Promise<GitReleaseResult> => fakeRelease(request.stackDir);
            const first = await publishManagedSiteBaseline({
                stackDir,
                manifest: manifest.manifest,
                attemptId: "attempt0001",
                publish,
            });
            expect(first).toEqual({ kind: "published", releaseId: SHA, reused: false });
            expect(await readlink(join(stackDir, "site", "runtime", "current"))).toBe(`releases/${SHA}`);
            expect((await readBaseline(stackDir, "acme-shop")).ok).toBe(true);

            const second = await publishManagedSiteBaseline({
                stackDir,
                manifest: manifest.manifest,
                attemptId: "attempt0002",
                publish,
            });
            expect(second.kind).toBe("refused");
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("leaves the site without a pointer when the fetch fails", async () => {
        const { root, stackDir } = await site();
        try {
            const manifest = parseManagedSiteManifest(await readFile(join(stackDir, "compose-panel-site.json"), "utf8"));
            if (!manifest.ok) throw new Error(manifest.reason);
            const result = await publishManagedSiteBaseline({
                stackDir,
                manifest: manifest.manifest,
                attemptId: "attempt0001",
                publish: async () => ({
                    ok: false,
                    phase: "fetch",
                    reason: "The configured branch could not be fetched.",
                    unconfirmed: false,
                    cleanup: "removed",
                }),
            });
            expect(result.kind).toBe("failed");
            await expect(readlink(join(stackDir, "site", "runtime", "current"))).rejects.toThrow();
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
