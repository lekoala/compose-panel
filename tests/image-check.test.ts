import { describe, expect, test } from "bun:test";
import {
    ImageCheckBusyError,
    ImageCheckManager,
    ImageCheckRefusedError,
    classifyRemoteResult,
    normalizeRepository,
    parseRemoteManifest,
    resolveLocalDigest,
    summarizeCheck,
    type ImageCheckView,
    type ImageCheckTarget,
} from "../src/image-check.ts";
import type { ComposeProvider, ServiceImageFact } from "../src/compose-provider.ts";
import type { CommandResult } from "../src/docker.ts";
import type { ImageDetails } from "../src/compose-state.ts";

const target: ImageCheckTarget = { project: "demo", composeFile: "/srv/demo/compose.yaml", cwd: "/srv/demo" };
const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "", timedOut: false, truncated: false });
const digest = (fill: string) => `sha256:${fill.repeat(64)}`;

function detail(overrides: Partial<ImageDetails> = {}): ImageDetails {
    return { id: digest("a"), repoTags: ["app:1"], repoDigests: [], created: null, labels: {}, ...overrides };
}

function manifest(remoteDigest: string): CommandResult {
    return ok(JSON.stringify({ mediaType: "application/vnd.oci.image.index.v1+json", digest: remoteDigest }));
}

interface ProviderScript {
    facts?: Map<string, ServiceImageFact> | (() => Map<string, ServiceImageFact> | null);
    local?: ImageDetails[] | (() => ImageDetails[]);
    remote?: (ref: string) => Promise<CommandResult> | CommandResult;
}

function dockerRow(value: ImageDetails) {
    return {
        Id: value.id,
        RepoTags: value.repoTags,
        RepoDigests: value.repoDigests,
        Created: value.created,
        Config: { Labels: value.labels },
        ...(value.descriptor ? { Descriptor: value.descriptor } : {}),
    };
}

function providerOf(script: ProviderScript = {}) {
    const calls = { facts: 0, local: 0, remote: [] as string[] };
    const provider = {
        serviceImageFacts: async () => {
            calls.facts += 1;
            return typeof script.facts === "function"
                ? script.facts()
                : (script.facts ?? new Map([["app", { image: "app:1", build: false }]]));
        },
        inspectImages: async () => {
            calls.local += 1;
            const details =
                typeof script.local === "function" ? script.local() : (script.local ?? [detail({ repoDigests: [`app@${digest("b")}`] })]);
            return ok(JSON.stringify(details.map(dockerRow)));
        },
        inspectRemoteManifest: async (ref: string) => {
            calls.remote.push(ref);
            return script.remote ? await script.remote(ref) : manifest(digest("b"));
        },
    } as unknown as ComposeProvider;
    return { provider, calls };
}

async function settled(manager: ImageCheckManager, stack: string): Promise<ImageCheckView> {
    for (let i = 0; i < 500; i += 1) {
        const view = manager.forStack(stack);
        if (view && view.status === "done") return view;
        await Bun.sleep(1);
    }
    throw new Error("the check did not finish");
}

describe("parseRemoteManifest", () => {
    test("reads the top-level digest of an index or a single manifest", () => {
        expect(parseRemoteManifest(JSON.stringify({ mediaType: "application/vnd.oci.image.index.v1+json", digest: digest("c") }))).toEqual({
            digest: digest("c"),
        });
        expect(
            parseRemoteManifest(JSON.stringify({ mediaType: "application/vnd.docker.distribution.manifest.v2+json", digest: digest("d") })),
        ).toEqual({
            digest: digest("d"),
        });
    });

    test("refuses anything else: no digest, unexpected media type, not JSON", () => {
        expect(parseRemoteManifest("{}")).toBeNull();
        expect(parseRemoteManifest(JSON.stringify({ digest: "sha256:short" }))).toBeNull();
        expect(parseRemoteManifest(JSON.stringify({ mediaType: "text/plain", digest: digest("e") }))).toBeNull();
        expect(parseRemoteManifest("not json")).toBeNull();
        expect(parseRemoteManifest("[]")).toBeNull();
    });
});

describe("classifyRemoteResult", () => {
    const failure = (text: string): CommandResult => ({ code: 1, stdout: "", stderr: text, timedOut: false, truncated: false });

    test("maps the failure to one known reason", () => {
        expect(classifyRemoteResult({ ...failure(""), timedOut: true })).toBe("timeout");
        expect(classifyRemoteResult(failure("ERROR: app:1: not found"))).toBe("not-found");
        expect(classifyRemoteResult(failure("unexpected status from HEAD request: 401 Unauthorized"))).toBe("unauthorized");
        expect(classifyRemoteResult(failure("TOOMANYREQUESTS: rate limit exceeded"))).toBe("rate-limited");
        expect(classifyRemoteResult(failure("docker: unknown command: docker buildx"))).toBe("unsupported");
        expect(classifyRemoteResult(failure("something odd"))).toBe("invalid-output");
    });
});

describe("normalizeRepository", () => {
    test("resolves Docker Hub prefixes, tags and digests to the repository", () => {
        expect(normalizeRepository("nginx")).toBe("nginx");
        expect(normalizeRepository("nginx:1.27")).toBe("nginx");
        expect(normalizeRepository("docker.io/library/nginx:1.27")).toBe("nginx");
        expect(normalizeRepository("index.docker.io/library/nginx")).toBe("nginx");
        expect(normalizeRepository("ghcr.io/acme/app:stable")).toBe("ghcr.io/acme/app");
        expect(normalizeRepository("localhost:5000/acme/app:1@sha256:" + "f".repeat(64))).toBe("localhost:5000/acme/app");
    });
});

describe("resolveLocalDigest", () => {
    test("prefers the per-reference descriptor of an index or manifest", () => {
        const resolved = resolveLocalDigest(
            detail({
                descriptor: { digest: digest("1"), mediaType: "application/vnd.oci.image.index.v1+json" },
                repoDigests: [`app@${digest("2")}`],
            }),
            "app:1",
        );
        expect(resolved).toEqual({ kind: "digest", reference: "app:1", digest: digest("1") });
    });

    test("ignores a descriptor with an unexpected media type and falls back to RepoDigests", () => {
        const resolved = resolveLocalDigest(
            detail({ descriptor: { digest: digest("1"), mediaType: "text/plain" }, repoDigests: [`app@${digest("2")}`] }),
            "app:1",
        );
        expect(resolved).toEqual({ kind: "digest", reference: "app:1", digest: digest("2") });
    });

    test("accepts one unambiguous RepoDigests entry of the same normalized repository", () => {
        const resolved = resolveLocalDigest(
            detail({
                repoTags: ["docker.io/library/nginx:1.27"],
                repoDigests: [`nginx@${digest("3")}`, `ghcr.io/acme/other@${digest("4")}`],
            }),
            "docker.io/library/nginx:1.27",
        );
        expect(resolved).toEqual({ kind: "digest", reference: "docker.io/library/nginx:1.27", digest: digest("3") });
    });

    test("stays unknown when the image carries another tag of the same repository (classic store)", () => {
        // Docker records a repository digest per image, not per tag: after
        // pulling `repo:a` and retagging `repo:b`, one RepoDigests entry says
        // nothing about which tag produced it.
        const retagged = detail({
            repoTags: ["repo:a", "repo:b"],
            repoDigests: [`repo@${digest("8")}`],
        });
        expect(resolveLocalDigest(retagged, "repo:b")).toEqual({
            kind: "unknown",
            reference: "repo:b",
            reason: "ambiguous-local-digest",
        });
        // A single matching tag is still accepted.
        expect(resolveLocalDigest(detail({ repoTags: ["repo:b"], repoDigests: [`repo@${digest("8")}`] }), "repo:b")).toEqual({
            kind: "digest",
            reference: "repo:b",
            digest: digest("8"),
        });
    });

    test("stays unknown when no or several local digests are recorded", () => {
        expect(resolveLocalDigest(undefined, "app:1")).toEqual({ kind: "unknown", reference: "app:1", reason: "no-local-digest" });
        expect(resolveLocalDigest(detail({ repoDigests: [] }), "app:1")).toEqual({
            kind: "unknown",
            reference: "app:1",
            reason: "no-local-digest",
        });
        expect(resolveLocalDigest(detail({ repoDigests: [`other@${digest("5")}`] }), "app:1")).toEqual({
            kind: "unknown",
            reference: "app:1",
            reason: "no-local-digest",
        });
        expect(resolveLocalDigest(detail({ repoDigests: [`app@${digest("6")}`, `app@${digest("7")}`] }), "app:1")).toEqual({
            kind: "unknown",
            reference: "app:1",
            reason: "ambiguous-local-digest",
        });
        // Malformed entries never become an answer.
        expect(resolveLocalDigest(detail({ repoDigests: ["app@sha256:short", "app"] }), "app:1")).toEqual({
            kind: "unknown",
            reference: "app:1",
            reason: "no-local-digest",
        });
    });
});

describe("summarizeCheck", () => {
    test("counts compared, updates, unknown and untracked services", () => {
        const view: ImageCheckView = {
            stack: "demo",
            status: "done",
            startedAt: 1,
            finishedAt: 2,
            discarded: false,
            services: [
                { service: "a", reference: "a:1", verdict: { kind: "up-to-date", localDigest: digest("a"), remoteDigest: digest("a") } },
                {
                    service: "b",
                    reference: "b:1",
                    verdict: { kind: "update-available", localDigest: digest("a"), remoteDigest: digest("b") },
                },
                { service: "c", reference: "c:1", verdict: { kind: "unknown", reason: "timeout" } },
                { service: "d", reference: null, verdict: { kind: "not-tracked", reason: "build" } },
            ],
        };
        expect(summarizeCheck(view)).toEqual({ compared: 2, updates: 1, unknown: 1, untracked: 1 });
    });
});

describe("ImageCheckManager", () => {
    test("compares the remote digest with the local one and publishes the verdict", async () => {
        const { provider, calls } = providerOf();
        const manager = new ImageCheckManager(provider);
        const started = await manager.start({ stack: "demo", target });
        expect(started.status).toBe("running");
        const view = await settled(manager, "demo");
        expect(view.discarded).toBe(false);
        expect(view.services).toEqual([
            {
                service: "app",
                reference: "app:1",
                verdict: { kind: "up-to-date", localDigest: digest("b"), remoteDigest: digest("b") },
            },
        ]);
        expect(calls.remote).toEqual(["app:1"]);
        // The provider is read again to prove the stack did not change.
        expect(calls.facts).toBe(2);
        expect(calls.local).toBe(2);
        expect(manager.isRunning()).toBe(false);
    });

    test("reports an update when the registry tag moved", async () => {
        const { provider } = providerOf({
            local: [detail({ repoDigests: [`app@${digest("b")}`] })],
            remote: () => manifest(digest("c")),
        });
        const manager = new ImageCheckManager(provider);
        await manager.start({ stack: "demo", target });
        const view = await settled(manager, "demo");
        expect(view.services[0]!.verdict).toEqual({
            kind: "update-available",
            localDigest: digest("b"),
            remoteDigest: digest("c"),
        });
    });

    test("skips build, digest-pinned and image-ID services without any registry call", async () => {
        const facts = new Map<string, ServiceImageFact>([
            ["built", { image: "app:local", build: true }],
            ["pinned", { image: `app@${digest("a")}`, build: false }],
            ["byid", { image: digest("a"), build: false }],
            ["plain", { image: null, build: false }],
        ]);
        const { provider, calls } = providerOf({ facts });
        const manager = new ImageCheckManager(provider);
        await manager.start({ stack: "demo", target });
        const view = await settled(manager, "demo");
        expect(calls.remote).toEqual([]);
        expect(view.services.map((entry) => [entry.service, entry.verdict.kind])).toEqual([
            ["built", "not-tracked"],
            ["byid", "not-tracked"],
            ["pinned", "not-tracked"],
            ["plain", "not-tracked"],
        ]);
    });

    test("stays unknown without a registry call when the local digest is ambiguous", async () => {
        const { provider, calls } = providerOf({
            local: [detail({ repoDigests: [`app@${digest("b")}`, `app@${digest("c")}`] })],
        });
        const manager = new ImageCheckManager(provider);
        await manager.start({ stack: "demo", target });
        const view = await settled(manager, "demo");
        expect(calls.remote).toEqual([]);
        expect(view.services[0]!.verdict).toEqual({ kind: "unknown", reason: "ambiguous-local-digest" });
    });

    test("classifies a registry failure instead of inventing a verdict", async () => {
        const { provider } = providerOf({
            remote: () => ({ code: 1, stdout: "", stderr: "ERROR: app:1: not found", timedOut: false, truncated: false }),
        });
        const manager = new ImageCheckManager(provider);
        await manager.start({ stack: "demo", target });
        expect((await settled(manager, "demo")).services[0]!.verdict).toEqual({ kind: "unknown", reason: "not-found" });
    });

    test("discards a result when a mutation starts while the check runs", async () => {
        let release!: () => void;
        const blocked = new Promise<void>((resolve) => {
            release = resolve;
        });
        const { provider } = providerOf({
            remote: async () => {
                await blocked;
                return manifest(digest("b"));
            },
        });
        const manager = new ImageCheckManager(provider);
        await manager.start({ stack: "demo", target });
        manager.changed("demo");
        release();
        const view = await settled(manager, "demo");
        expect(view.discarded).toBe(true);
        expect(view.services).toEqual([]);
    });

    test("discards a result when the local digest changed meanwhile", async () => {
        let reads = 0;
        const { provider } = providerOf({
            local: () => {
                reads += 1;
                return [detail({ repoDigests: [`app@${digest(reads === 1 ? "b" : "c")}`] })];
            },
        });
        const manager = new ImageCheckManager(provider);
        await manager.start({ stack: "demo", target });
        const view = await settled(manager, "demo");
        expect(reads).toBeGreaterThanOrEqual(2);
        expect(view.discarded).toBe(true);
    });

    test("discards a result when the references changed meanwhile", async () => {
        let reads = 0;
        const { provider } = providerOf({
            facts: () => {
                reads += 1;
                return new Map([["app", { image: reads === 1 ? "app:1" : "app:2", build: false }]]);
            },
        });
        const manager = new ImageCheckManager(provider);
        await manager.start({ stack: "demo", target });
        expect((await settled(manager, "demo")).discarded).toBe(true);
    });

    test("runs one check at a time for the whole panel", async () => {
        let release!: () => void;
        const blocked = new Promise<void>((resolve) => {
            release = resolve;
        });
        const { provider } = providerOf({
            remote: async () => {
                await blocked;
                return manifest(digest("b"));
            },
        });
        const manager = new ImageCheckManager(provider);
        await manager.start({ stack: "demo", target });
        await expect(manager.start({ stack: "other", target })).rejects.toBeInstanceOf(ImageCheckBusyError);
        release();
        await settled(manager, "demo");
        for (let i = 0; i < 100 && manager.isRunning(); i += 1) await Bun.sleep(1);
        // The slot is free again.
        await manager.start({ stack: "other", target });
    });

    test("refuses when the effective configuration cannot be read", async () => {
        const { provider } = providerOf({ facts: () => null });
        const manager = new ImageCheckManager(provider);
        await expect(manager.start({ stack: "demo", target })).rejects.toBeInstanceOf(ImageCheckRefusedError);
        expect(manager.isRunning()).toBe(false);
    });

    test("drops a finished verdict when the stack changes", async () => {
        const { provider } = providerOf();
        const manager = new ImageCheckManager(provider);
        await manager.start({ stack: "demo", target });
        const view = await settled(manager, "demo");
        expect(view.status).toBe("done");
        manager.changed("demo");
        expect(manager.forStack("demo")).toBeNull();
    });

    test("a mutation on any stack drops every stored verdict (shared tags)", async () => {
        const { provider } = providerOf();
        const manager = new ImageCheckManager(provider);
        await manager.start({ stack: "demo", target });
        await settled(manager, "demo");
        await manager.start({ stack: "other", target });
        await settled(manager, "other");
        expect(manager.forStack("demo")).not.toBeNull();
        expect(manager.forStack("other")).not.toBeNull();
        // A Pull in one stack changes the engine-wide image store: the other
        // stack's verdict may compare against a digest that just moved.
        manager.imagesChanged();
        expect(manager.forStack("demo")).toBeNull();
        expect(manager.forStack("other")).toBeNull();
    });

    test("a mutation on another stack discards an in-flight check", async () => {
        let release!: () => void;
        const blocked = new Promise<void>((resolve) => {
            release = resolve;
        });
        const { provider } = providerOf({
            remote: async () => {
                await blocked;
                return manifest(digest("b"));
            },
        });
        const manager = new ImageCheckManager(provider);
        await manager.start({ stack: "demo", target });
        manager.imagesChanged();
        release();
        expect((await settled(manager, "demo")).discarded).toBe(true);
    });
});
