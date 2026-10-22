import { expect, test } from "bun:test";
import { createComposeProvider } from "../src/compose-provider.ts";
import { deployedImage, managedBy, metadataUrl, projectMetadata, type DeclaredMetadata, type DeployedImage } from "../src/deployment.ts";
import { deploymentSection, managedByBadge, operationControls } from "../src/html.ts";
import { loadImageUpdates } from "../src/updates.ts";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadStackDetail } from "../src/status.ts";

const oldId = `sha256:${"a".repeat(64)}`;
const newId = `sha256:${"b".repeat(64)}`;
const ok = (stdout: string) => ({ code: 0, stdout, stderr: "", timedOut: false, truncated: false });
const input = { project: "actual-project", cwd: "/stacks/demo", composeFile: "/stacks/demo/compose.yaml", envFile: "/stacks/demo/.env" };

test("projects only bounded allow-listed labels, with explicit Compose context", async () => {
    const value = {
        services: {
            app: {
                environment: { SECRET: "private" },
                labels: {
                    "stack.version": "1.2",
                    "stack.build.url": "https://ci.example/build/42",
                    secret: "private",
                    "stack.branch": "x".repeat(513),
                },
            },
        },
    };
    const calls: string[][] = [];
    const provider = createComposeProvider({
        runner: async (args) => {
            calls.push(args);
            return ok(JSON.stringify(value));
        },
    });
    const metadata = await provider.stackMetadata(input);
    expect(metadata).toEqual({ app: { "stack.version": "1.2", "stack.build.url": "https://ci.example/build/42" } });
    expect(JSON.stringify(metadata)).not.toContain("private");
    expect(calls).toEqual([
        [
            "compose",
            "-p",
            input.project,
            "--env-file",
            input.envFile,
            "--project-directory",
            input.cwd,
            "-f",
            input.composeFile,
            "config",
            "--format",
            "json",
        ],
    ]);
    expect(projectMetadata({ services: [] })).toBeNull();
});

test("failed, truncated, timed-out and malformed config returns unavailable metadata", async () => {
    for (const result of [
        { ...ok("private"), code: 1 },
        { ...ok("{}"), truncated: true },
        { ...ok("{}"), timedOut: true },
        ok("not json"),
    ]) {
        const provider = createComposeProvider({ runner: async () => result });
        expect(await provider.stackMetadata(input)).toBeNull();
    }
});

test("deployed metadata uses each container's image ID after a tag changes, including pinned images", async () => {
    const calls: string[][] = [];
    const provider = createComposeProvider({
        runner: async (args) => {
            calls.push(args);
            if (args.includes("images"))
                return ok(
                    JSON.stringify([
                        { ContainerName: "app-1", ID: oldId },
                        { ContainerName: "app-2", ID: newId },
                        { ContainerName: "db-1", ID: oldId },
                    ]),
                );
            return ok(
                JSON.stringify([
                    {
                        Id: oldId,
                        RepoTags: [],
                        RepoDigests: [],
                        Config: {
                            Labels: {
                                "org.opencontainers.image.version": "1",
                                "org.opencontainers.image.revision": "old-commit",
                                "org.opencontainers.image.source": "https://git.example/app",
                            },
                        },
                    },
                    {
                        Id: newId,
                        RepoTags: ["app:latest"],
                        RepoDigests: [`app@sha256:${"c".repeat(64)}`],
                        Config: { Labels: { "org.opencontainers.image.version": "2" } },
                    },
                ]),
            );
        },
    });
    const deployed: DeployedImage[] = [];
    const services = [
        { name: "app", container: "app-1", image: "app:latest" },
        { name: "app", container: "app-2", image: "app:latest" },
        { name: "db", container: "db-1", image: `app@sha256:${"d".repeat(64)}` },
    ].map((service) => ({ ...service, state: "running", health: null, exitCode: 0 }));
    const updates = await loadImageUpdates(provider, input, services, deployed);
    expect(updates.app?.from.version).toBe("1");
    expect(deployed.map((image) => image.version)).toEqual(["1", "2", "1"]);
    expect(deployed[0]?.digests).toEqual([]);
    expect(deployed[0]?.revision).toBe("old-commit");
    expect(deployed[1]?.digests).toEqual([`app@sha256:${"c".repeat(64)}`]);
    expect(calls).toHaveLength(2);
});

test("an image dropped by the containerd store is read from its container's inherited OCI labels", async () => {
    const calls: string[][] = [];
    const provider = createComposeProvider({
        runner: async (args) => {
            calls.push(args);
            if (args.includes("images")) return ok(JSON.stringify([{ ContainerName: "app-1", ID: oldId }]));
            if (args[0] === "container") {
                return ok(
                    JSON.stringify([
                        {
                            Name: "/app-1",
                            Image: oldId,
                            Config: {
                                Image: "app:latest",
                                Labels: {
                                    "org.opencontainers.image.version": "1",
                                    "org.opencontainers.image.revision": "commit-1",
                                    "com.docker.compose.project": "actual-project",
                                },
                            },
                        },
                    ]),
                );
            }
            // The old image ID is gone; only the retagged image remains.
            const found = args.includes("app:latest")
                ? [
                      {
                          Id: newId,
                          RepoTags: ["app:latest"],
                          RepoDigests: [],
                          Config: { Labels: { "org.opencontainers.image.version": "2" } },
                      },
                  ]
                : [];
            return { ...ok(JSON.stringify(found)), code: args.includes(oldId) ? 1 : 0 };
        },
    });
    const deployed: DeployedImage[] = [];
    // Compose then reports the bare image ID instead of the configured tag.
    const updates = await loadImageUpdates(
        provider,
        input,
        [{ name: "app", container: "app-1", image: oldId, state: "running", health: null, exitCode: 0 }],
        deployed,
    );
    expect(deployed).toHaveLength(1);
    expect(deployed[0]).toMatchObject({ imageId: oldId, version: "1", revision: "commit-1", digests: [] });
    expect(updates.app?.image).toBe("app:latest");
    expect(updates.app?.from.version).toBe("1");
    expect(updates.app?.to.version).toBe("2");
    expect(calls.slice(2)).toEqual([
        ["container", "inspect", "--", "app-1"],
        ["image", "inspect", "--", "app:latest"],
    ]);
});

test("container labels are not used when the container reports a different image", async () => {
    const provider = createComposeProvider({
        runner: async (args) => {
            if (args.includes("images")) return ok(JSON.stringify([{ ContainerName: "app-1", ID: oldId }]));
            if (args[0] === "container")
                return ok(
                    JSON.stringify([{ Name: "/app-1", Image: newId, Config: { Labels: { "org.opencontainers.image.version": "2" } } }]),
                );
            return { ...ok("[]"), code: 1 };
        },
    });
    const deployed: DeployedImage[] = [];
    await loadImageUpdates(
        provider,
        input,
        [{ name: "app", container: "app-1", image: "app:latest", state: "running", health: null, exitCode: 0 }],
        deployed,
    );
    expect(deployed).toEqual([]);
});

test("container inspect drops names that are not container names", async () => {
    const calls: string[][] = [];
    const provider = createComposeProvider({
        runner: async (args) => {
            calls.push(args);
            return ok("[]");
        },
    });
    await provider.inspectContainers(["-v", "../x", "app-1", "app-1"]);
    expect(calls).toEqual([["container", "inspect", "--", "app-1"]]);
    calls.length = 0;
    await provider.inspectContainers(["--format"]);
    expect(calls).toEqual([]);
});

test("escapes metadata and refuses active or credential-bearing links", () => {
    const image = deployedImage("<app>", "app-1", {
        id: oldId,
        repoTags: [],
        repoDigests: [],
        created: null,
        labels: { "org.opencontainers.image.version": "<script>x</script>", "org.opencontainers.image.source": "javascript:alert(1)" },
    });
    expect(image.source).toBeNull();
    for (const url of ["javascript:alert(1)", "data:text/html,x", "https://user:password@example.com", "/relative"])
        expect(metadataUrl(url)).toBeNull();
    const html = deploymentSection([image], {
        app: { "stack.url": "javascript:alert(1)", "stack.build.url": 'https://ci.example/?q="x"' },
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('rel="noopener noreferrer"');
});

test("failed image reads do not invent a deployed version", async () => {
    const provider = createComposeProvider({ runner: async () => ({ ...ok("secret"), code: 1 }) });
    const deployed: DeployedImage[] = [];
    expect(
        await loadImageUpdates(
            provider,
            input,
            [{ name: "app", container: "app-1", image: "app:latest", state: "running", health: null, exitCode: 0 }],
            deployed,
        ),
    ).toEqual({});
    expect(deployed).toEqual([]);
});

test("renders a metadata disclosure only when it contains actual fields", () => {
    const emptyCases: (DeclaredMetadata | null | undefined)[] = [undefined, null, {}, { app: {} }, { app: { "stack.version": "" } }];
    for (const declared of emptyCases) {
        expect(deploymentSection([], declared)).not.toContain("<details>");
    }
    const html = deploymentSection([], { empty: {}, app: { "stack.version": "1.2.3" } });
    expect(html).toContain("<details>");
    expect(html).toContain("<dd><code>1.2.3</code></dd>");
    expect(html).not.toContain("<h3>empty</h3>");
});

test("undeployed stacks omit the deployed card and failed config stays visible outside a disclosure", () => {
    expect(deploymentSection([], {}, false)).toBe("");
    const unavailable = deploymentSection([], null, false);
    expect(unavailable).toContain('class="note note-warn"');
    expect(unavailable).not.toContain("<details>");
    const image = deployedImage("app", "app-1", { id: oldId, repoTags: [], repoDigests: [], created: null, labels: {} });
    const declared = deploymentSection([image], { app: { "stack.version": "declared-v2" } }, false);
    expect(declared).toContain("<details>");
    expect(declared).toContain("declared-v2");
    expect(declared).not.toContain(oldId);
});

test.skipIf(process.platform !== "linux")("an unsafe .env prevents config metadata reads without breaking Docker status", async () => {
    const root = await mkdtemp(join(tmpdir(), "cp-metadata-"));
    const cwd = join(root, "demo");
    const composeFile = join(cwd, "compose.yaml");
    const calls: string[][] = [];
    try {
        await mkdir(cwd);
        await writeFile(composeFile, "services:\n  app:\n    image: app:latest\n");
        await writeFile(join(root, "secret"), "SECRET=private\n");
        await symlink(join(root, "secret"), join(cwd, ".env"));
        const provider = createComposeProvider({
            runner: async (args) => {
                calls.push(args);
                if (args.includes("ls")) return ok(JSON.stringify([{ Name: "demo", Status: "running(1)", ConfigFiles: composeFile }]));
                if (args.includes("ps"))
                    return ok(JSON.stringify([{ Service: "app", Name: "app-1", Image: "app:latest", State: "running" }]));
                return ok("[]");
            },
        });
        const status = await loadStackDetail(root, "demo", provider);
        expect(status.state).toBe("running");
        expect(status.declared).toBeNull();
        expect(calls.some((args) => args.includes("config"))).toBe(false);
        expect(calls.some((args) => args.includes("ps") || args.includes("images"))).toBe(false);
        expect(status.services).toEqual([]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("a declared deployment owner is kept only when every declaring service agrees", () => {
    expect(projectMetadata({ services: { app: { labels: { "stack.managed-by": "CI" } } } })).toEqual({ app: { "stack.managed-by": "CI" } });
    expect(managedBy({ app: { "stack.managed-by": "CI" }, worker: { "stack.managed-by": "CI" }, db: {} })).toBe("CI");
    expect(managedBy({ app: { "stack.managed-by": "CI" }, worker: { "stack.managed-by": "Other" } })).toBeNull();
    const empty: (DeclaredMetadata | null | undefined)[] = [undefined, null, {}, { app: { "stack.version": "1" } }];
    for (const declared of empty) expect(managedBy(declared)).toBeNull();
});

test("the deployment owner is escaped and only marks managed stacks", () => {
    expect(managedByBadge(null)).toBe("");
    const badge = managedByBadge("<b>CI</b>");
    expect(badge).toContain("&lt;b&gt;CI&lt;/b&gt;");
    expect(badge).not.toContain("<b>");
    const plain = operationControls("demo", "token", { busy: false, state: "running" });
    const managed = operationControls("demo", "token", { busy: false, state: "running", managedBy: "<b>CI</b>" });
    expect(plain).not.toContain("CI");
    expect(managed).toContain("&lt;b&gt;CI&lt;/b&gt;");
    expect(managed).not.toContain("<b>");
    // Informational only: the same actions stay available.
    const buttons = (html: string) => html.match(/name="action" value="[a-z+-]+"/g);
    expect(buttons(managed)).toEqual(buttons(plain));
});
