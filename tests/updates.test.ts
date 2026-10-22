import { describe, expect, test } from "bun:test";
import type { CommandResult } from "../src/docker.ts";
import type { ComposeProvider } from "../src/compose-provider.ts";
import { createComposeProvider, isImageReference } from "../src/compose-provider.ts";
import type { ComposeService } from "../src/compose-state.ts";
import { linkFor, loadImageUpdates, normalizeReference } from "../src/updates.ts";
import { servicesSection, updateText } from "../src/html.ts";

const OLD = `sha256:${"a".repeat(64)}`;
const NEW = `sha256:${"b".repeat(64)}`;
const REDIS = `sha256:${"c".repeat(64)}`;
const result = (stdout: string, code = 0): CommandResult => ({ code, stdout, stderr: "", timedOut: false, truncated: false });

function service(name: string, image: string | null): ComposeService {
    return { name, state: "running", health: null, exitCode: 0, container: `demo-${name}-1`, image };
}

function fakeProvider(inspect: unknown[], calls: string[][] = []): ComposeProvider {
    const base = createComposeProvider({ runner: async () => result("") });
    return {
        ...base,
        projectImages: async () =>
            result(
                JSON.stringify([
                    { ContainerName: "demo-app-1", ID: OLD },
                    { ContainerName: "demo-cache-1", ID: REDIS },
                ]),
            ),
        inspectImages: async (refs) => {
            calls.push(refs);
            return result(JSON.stringify(inspect), 1);
        },
    };
}

const input = { project: "demo", composeFile: "compose.yaml", cwd: "/stacks/demo" };

describe("loadImageUpdates", () => {
    test("reports a service whose tag now points to a newer local image, with from → to", async () => {
        const provider = fakeProvider([
            {
                Id: NEW,
                RepoTags: ["nginx:1.27-alpine"],
                RepoDigests: [`nginx@sha256:${"1".repeat(64)}`],
                Created: "2026-10-05T10:00:00Z",
                Config: {
                    Labels: {
                        "org.opencontainers.image.version": "1.27.2",
                        "org.opencontainers.image.source": "https://github.com/nginxinc/docker-nginx",
                    },
                },
            },
            {
                Id: OLD,
                RepoTags: [],
                RepoDigests: [`nginx@sha256:${"0".repeat(64)}`],
                Created: "2026-09-01T10:00:00Z",
                Config: { Labels: { "org.opencontainers.image.version": "1.27.1" } },
            },
            { Id: REDIS, RepoTags: ["redis:7"], RepoDigests: [], Created: "2026-08-01T00:00:00Z", Config: { Labels: {} } },
        ]);
        const updates = await loadImageUpdates(provider, input, [service("app", "nginx:1.27-alpine"), service("cache", "redis:7")]);
        expect(Object.keys(updates)).toEqual(["app"]);
        const app = updates.app!;
        expect(app.from.version).toBe("1.27.1");
        expect(app.to.version).toBe("1.27.2");
        expect(updateText(app)).toBe("1.27.1 → 1.27.2");
        expect(app.link).toEqual({ href: "https://github.com/nginxinc/docker-nginx/releases", label: "Release notes" });
    });

    test("ignores images pinned by digest and asks nothing when no service has a tag", async () => {
        const calls: string[][] = [];
        const provider = fakeProvider([], calls);
        expect(await loadImageUpdates(provider, input, [service("app", `nginx@sha256:${"9".repeat(64)}`), service("db", null)])).toEqual(
            {},
        );
        expect(calls).toEqual([]);
    });

    test("never invents an update when Docker fails", async () => {
        const failing: ComposeProvider = { ...fakeProvider([]), projectImages: async () => result("", 1) };
        expect(await loadImageUpdates(failing, input, [service("app", "nginx:1.27-alpine")])).toEqual({});
        const throwing: ComposeProvider = {
            ...fakeProvider([]),
            inspectImages: async () => {
                throw new Error("boom");
            },
        };
        expect(await loadImageUpdates(throwing, input, [service("app", "nginx:1.27-alpine")])).toEqual({});
    });

    test("falls back to build dates, then digests, when versions are missing or equal", () => {
        const base = { image: "x:1", link: null };
        expect(
            updateText({
                ...base,
                from: { version: null, created: "2026-09-01", digest: null },
                to: { version: null, created: "2026-10-05", digest: null },
            }),
        ).toBe("built 2026-09-01 → built 2026-10-05");
        expect(
            updateText({
                ...base,
                from: { version: "7", created: null, digest: "sha256:aaaaaaaaaaaa" },
                to: { version: "7", created: null, digest: "sha256:bbbbbbbbbbbb" },
            }),
        ).toBe("7 (sha256:aaaaaaaaaaaa) → 7 (sha256:bbbbbbbbbbbb)");
    });

    test("escapes untrusted label text in the version summary", () => {
        const base = { image: "x:1", link: null };
        expect(
            updateText({
                ...base,
                from: { version: "<img src=x>", created: null, digest: null },
                to: { version: "2", created: null, digest: null },
            }),
        ).toBe("&lt;img src=x&gt; → 2");
    });
});

describe("linkFor", () => {
    test("prefers release notes for GitHub sources, then the source, then the image page", () => {
        expect(linkFor("x:1", { "org.opencontainers.image.source": "https://github.com/acme/app.git" })?.href).toBe(
            "https://github.com/acme/app/releases",
        );
        expect(linkFor("x:1", { "org.opencontainers.image.source": "https://gitlab.com/acme/app" })).toEqual({
            href: "https://gitlab.com/acme/app",
            label: "Source",
        });
        expect(linkFor("x:1", { "org.opencontainers.image.url": "https://acme.example/app" })?.label).toBe("Image page");
    });

    test("falls back to Docker Hub only for images hosted there", () => {
        expect(linkFor("nginx:1.27", {})?.href).toBe("https://hub.docker.com/_/nginx");
        expect(linkFor("docker.io/library/redis:7", {})?.href).toBe("https://hub.docker.com/_/redis");
        expect(linkFor("louislam/uptime-kuma:1", {})?.href).toBe("https://hub.docker.com/r/louislam/uptime-kuma");
        expect(linkFor("ghcr.io/acme/app:1", {})).toBeNull();
        expect(linkFor("registry.local:5000/app:1", {})).toBeNull();
    });

    test("ignores label URLs that are not http(s)", () => {
        expect(linkFor("ghcr.io/acme/app:1", { "org.opencontainers.image.source": "javascript:alert(1)" })).toBeNull();
        expect(linkFor("ghcr.io/acme/app:1", { "org.opencontainers.image.url": "data:text/html,<script>" })).toBeNull();
    });
});

describe("rendering", () => {
    test("escapes label-derived text and links", () => {
        const html = servicesSection([service("app", "nginx:1")], "running", {
            app: {
                image: "nginx:1",
                from: { version: "<b>1</b>", created: null, digest: null },
                to: { version: '2"><script>x</script>', created: null, digest: null },
                link: { href: 'https://example.com/?a="><script>', label: "Source" },
            },
        });
        expect(html).toContain("state-update");
        expect(html).not.toContain("<script>");
        expect(html).not.toContain("<b>1</b>");
        expect(html).toContain('rel="noopener noreferrer"');
    });
});

describe("references", () => {
    test("normalizes Docker Hub references like Docker does", () => {
        expect(normalizeReference("nginx")).toBe("nginx:latest");
        expect(normalizeReference("docker.io/library/nginx:1.27")).toBe("nginx:1.27");
        expect(normalizeReference("registry:5000/app")).toBe("registry:5000/app:latest");
    });

    test("only image references or IDs reach the CLI, after `--`", async () => {
        expect(isImageReference("nginx:1.27-alpine")).toBe(true);
        expect(isImageReference(OLD)).toBe(true);
        expect(isImageReference("--format={{.}}")).toBe(false);
        expect(isImageReference("a b")).toBe(false);
        const seen: string[][] = [];
        const provider = createComposeProvider({
            runner: async (args) => {
                seen.push(args);
                return result("[]");
            },
        });
        await provider.inspectImages(["nginx:1", "-v", "nginx:1"]);
        expect(seen).toEqual([["image", "inspect", "--", "nginx:1"]]);
    });
});
