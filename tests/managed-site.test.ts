import { describe, expect, test } from "bun:test";
import {
    isManagedSitePath,
    isManagedSiteReleaseId,
    isValidDeployGitUrl,
    isValidDeployRef,
    MANAGED_SITE_MANIFEST_MAX_BYTES,
    managedSiteReleasePath,
    parseManagedSiteManifest,
} from "../src/managed-site.ts";

type Json = Record<string, unknown>;

function optIn(overrides: Json = {}): Json {
    return {
        version: 1,
        siteId: "acme-shop",
        owner: "opt-in",
        project: "acme-shop",
        services: { gateway: "web", runtime: "php" },
        publicRoot: "public",
        runtime: { profile: "php-front-controller" },
        deploy: { kind: "bind-mount", git: { url: "https://github.com/acme/shop.git", ref: "refs/heads/main" } },
        ...overrides,
    };
}

function managed(overrides: Json = {}): Json {
    return optIn({
        owner: "managed",
        gateway: { port: 41001 },
        runtime: { profile: "php-front-controller", image: "php:8.3-fpm-alpine" },
        generation: "1",
        paths: ["shared/uploads"],
        ...overrides,
    });
}

function parse(value: unknown) {
    return parseManagedSiteManifest(JSON.stringify(value));
}

function rejected(value: unknown): boolean {
    const result = parse(value);
    return result.ok === false && result.reason.length > 0;
}

describe("parseManagedSiteManifest", () => {
    test("accepts an opt-in stack with the minimal deploy fields", () => {
        const result = parse(optIn());
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.manifest.owner).toBe("opt-in");
        expect(result.manifest.project).toBe("acme-shop");
        expect(result.manifest.runtime.image).toBeUndefined();
        expect(result.manifest.deploy.git.ref).toBe("refs/heads/main");
        expect(result.manifest.paths).toBeUndefined();
    });

    test("accepts a managed site with an explicit image, declared paths and a generation", () => {
        const result = parse(managed());
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.manifest.runtime.image).toBe("php:8.3-fpm-alpine");
        expect(result.manifest.paths).toEqual(["shared/uploads"]);
        expect(result.manifest.generation).toBe("1");
        expect(result.manifest.gateway).toEqual({ port: 41001 });
    });

    test("requires a reserved gateway port for a managed site and refuses one for an opt-in stack", () => {
        const { gateway: _drop, ...withoutGateway } = managed();
        expect(rejected(withoutGateway)).toBe(true);
        expect(rejected(optIn({ gateway: { port: 41001 } }))).toBe(true);
        expect(rejected(managed({ gateway: { port: 40999 } }))).toBe(true);
        expect(rejected(managed({ gateway: { port: 42000 } }))).toBe(true);
        expect(rejected(managed({ gateway: { port: "41001" } }))).toBe(true);
        expect(rejected(managed({ gateway: { port: 41001, host: "127.0.0.1" } }))).toBe(true);
    });

    test("accepts only a pinned runtime channel image in managed mode", () => {
        expect(rejected(managed({ runtime: { profile: "php-front-controller", image: "ghcr.io/acme/php:8.3" } }))).toBe(true);
        const result = parse(managed({ runtime: { profile: "php-front-controller", image: "php:8.4-fpm-alpine" } }));
        expect(result.ok).toBe(true);
    });

    test("refuses another version, a missing version and a string version", () => {
        expect(rejected(optIn({ version: 2 }))).toBe(true);
        expect(rejected(optIn({ version: "1" }))).toBe(true);
        const { version: _drop, ...withoutVersion } = optIn();
        expect(rejected(withoutVersion)).toBe(true);
    });

    test("refuses unknown fields at every level", () => {
        expect(rejected(optIn({ database: { host: "db" } }))).toBe(true);
        expect(rejected(optIn({ services: { gateway: "web", runtime: "php", worker: "queue" } }))).toBe(true);
        expect(rejected(optIn({ runtime: { profile: "php-front-controller", extensions: [] } }))).toBe(true);
        expect(
            rejected(
                optIn({
                    deploy: { kind: "bind-mount", backup: true, git: { url: "https://github.com/acme/shop.git", ref: "refs/heads/main" } },
                }),
            ),
        ).toBe(true);
        expect(
            rejected(
                optIn({
                    deploy: { kind: "bind-mount", git: { url: "https://github.com/acme/shop.git", ref: "refs/heads/main", key: "x" } },
                }),
            ),
        ).toBe(true);
    });

    test("refuses a duplicated field, including a nested one", () => {
        const top = JSON.stringify(optIn()).replace('"owner":"opt-in"', '"owner":"opt-in","owner":"opt-in"');
        expect(parseManagedSiteManifest(top).ok).toBe(false);
        const nested = JSON.stringify(optIn()).replace('"gateway":"web"', '"gateway":"web","gateway":"php"');
        expect(parseManagedSiteManifest(nested).ok).toBe(false);
    });

    test("refuses a top-level __proto__ field instead of adopting it", () => {
        const source = JSON.stringify(optIn()).replace(/^\{/, '{"__proto__":{"polluted":true},');
        const result = parseManagedSiteManifest(source);
        expect(result.ok).toBe(false);
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    test("refuses invalid JSON, trailing content, empty and oversized input", () => {
        expect(parseManagedSiteManifest("").ok).toBe(false);
        expect(parseManagedSiteManifest("{").ok).toBe(false);
        expect(parseManagedSiteManifest(JSON.stringify(optIn()) + "{}").ok).toBe(false);
        expect(parseManagedSiteManifest('{"version": NaN}').ok).toBe(false);
        const oversized = `{"padding":"${"a".repeat(MANAGED_SITE_MANIFEST_MAX_BYTES)}"}`;
        expect(parseManagedSiteManifest(oversized).ok).toBe(false);
    });

    test("refuses deeply nested JSON", () => {
        const nested = "[".repeat(20) + "]".repeat(20);
        expect(parseManagedSiteManifest(`{"version":${nested}}`).ok).toBe(false);
    });

    test("refuses a siteId that is not opaque and lowercase", () => {
        expect(rejected(optIn({ siteId: "Acme" }))).toBe(true);
        expect(rejected(optIn({ siteId: "ab" }))).toBe(true);
        expect(rejected(optIn({ siteId: "acme_shop" }))).toBe(true);
        expect(rejected(optIn({ siteId: "acme shop" }))).toBe(true);
        expect(rejected(optIn({ siteId: "-acme" }))).toBe(true);
        expect(rejected(optIn({ siteId: "a".repeat(65) }))).toBe(true);
    });

    test("refuses an owner outside the two values and a missing one", () => {
        expect(rejected(optIn({ owner: "generated" }))).toBe(true);
        expect(rejected(optIn({ owner: "MANAGED" }))).toBe(true);
        const { owner: _drop, ...withoutOwner } = optIn();
        expect(rejected(withoutOwner)).toBe(true);
    });

    test("refuses a project name that is not the exact lowercase Compose name", () => {
        expect(rejected(optIn({ project: "Acme-Shop" }))).toBe(true);
        expect(rejected(optIn({ project: "" }))).toBe(true);
        expect(rejected(optIn({ project: "acme shop" }))).toBe(true);
        expect(rejected(optIn({ project: "a".repeat(64) }))).toBe(true);
    });

    test("requires two distinct valid service names", () => {
        expect(rejected(optIn({ services: { gateway: "web" } }))).toBe(true);
        expect(rejected(optIn({ services: { gateway: "web", runtime: "web" } }))).toBe(true);
        expect(rejected(optIn({ services: { gateway: "-web", runtime: "php" } }))).toBe(true);
        expect(rejected(optIn({ services: { gateway: "web", runtime: "php --all" } }))).toBe(true);
    });

    test("refuses another publicRoot or runtime profile", () => {
        expect(rejected(optIn({ publicRoot: "web" }))).toBe(true);
        expect(rejected(optIn({ runtime: { profile: "php-nginx" } }))).toBe(true);
        expect(rejected(optIn({ publicRoot: undefined }))).toBe(true);
    });

    test("keeps runtime.image out of an opt-in stack", () => {
        expect(rejected(optIn({ runtime: { profile: "php-front-controller", image: "php:8.3-fpm" } }))).toBe(true);
    });

    test("requires an explicit image for a managed site and refuses a bare repository", () => {
        const result = managed();
        const withoutImage = { ...result, runtime: { profile: "php-front-controller" } };
        expect(rejected(withoutImage)).toBe(true);
        expect(rejected(managed({ runtime: { profile: "php-front-controller", image: "php" } }))).toBe(true);
        expect(rejected(managed({ runtime: { profile: "php-front-controller", image: "php:" } }))).toBe(true);
        expect(rejected(managed({ runtime: { profile: "php-front-controller", image: "ghcr.io/acme/php:" } }))).toBe(true);
        expect(rejected(managed({ runtime: { profile: "php-front-controller", image: "php@sha256:abc" } }))).toBe(true);
        expect(
            parse(
                managed({
                    runtime: {
                        profile: "php-front-controller",
                        image: `php:8.3-fpm-alpine@sha256:${"a".repeat(64)}`,
                    },
                }),
            ).ok,
        ).toBe(false);
        expect(parse(managed({ runtime: { profile: "php-front-controller", image: "php:8.4-fpm-alpine" } })).ok).toBe(true);
    });

    test("refuses a deploy block that is missing, has another kind or is not Git", () => {
        const { deploy: _drop, ...withoutDeploy } = optIn();
        expect(rejected(withoutDeploy)).toBe(true);
        expect(
            rejected(optIn({ deploy: { kind: "image", git: { url: "https://github.com/acme/shop.git", ref: "refs/heads/main" } } })),
        ).toBe(true);
        expect(rejected(optIn({ deploy: { kind: "bind-mount", git: { ref: "refs/heads/main" } } }))).toBe(true);
    });

    test("refuses HTTPS credentials, queries and fragments", () => {
        const withUrl = (url: string) => optIn({ deploy: { kind: "bind-mount", git: { url, ref: "refs/heads/main" } } });
        expect(rejected(withUrl("http://github.com/acme/shop.git"))).toBe(true);
        expect(rejected(withUrl("https://user:token@github.com/acme/shop.git"))).toBe(true);
        expect(rejected(withUrl("https://github.com/acme/shop.git?ref=main"))).toBe(true);
        expect(rejected(withUrl("https://github.com/acme/shop.git#main"))).toBe(true);
        expect(rejected(withUrl("https://github.com/acme/shop.git\n"))).toBe(true);
        expect(rejected(withUrl("not a url"))).toBe(true);
    });

    test("accepts explicit SSH destinations and refuses ambiguous URLs", () => {
        const withUrl = (url: string) => optIn({ deploy: { kind: "bind-mount", git: { url, ref: "refs/heads/main" } } });
        for (const url of ["ssh://git@github.com/acme/shop.git", "ssh://deploy@127.0.0.1:2222/acme/shop.git"]) {
            const result = parseManagedSiteManifest(JSON.stringify(withUrl(url)));
            expect(result.ok && result.manifest.deploy.git.url).toBe(url);
        }
        for (const url of [
            "git@github.com:acme/shop.git",
            "ssh://github.com/acme/shop.git",
            "ssh://git:password@github.com/acme/shop.git",
            "ssh://git@-host/acme/shop.git",
            "ssh://git@host:65536/acme/shop.git",
            "ssh://git@host:0/acme/shop.git",
            "ssh://git@host/acme/../shop.git",
            "ssh://git@host/acme%2Fshop.git",
            "ssh://git@host/acme/shop.git?ref=main",
            "ssh://git@host/acme/shop.git#main",
        ]) {
            expect(rejected(withUrl(url))).toBe(true);
        }
    });

    test("refuses a short, wildcarded or malformed ref", () => {
        const withRef = (ref: string) => optIn({ deploy: { kind: "bind-mount", git: { url: "https://github.com/acme/shop.git", ref } } });
        expect(rejected(withRef("main"))).toBe(true);
        expect(rejected(withRef("refs/tags/v1"))).toBe(true);
        expect(rejected(withRef("refs/heads/*"))).toBe(true);
        expect(rejected(withRef("refs/heads/../main"))).toBe(true);
        expect(rejected(withRef("refs/heads/feature//x"))).toBe(true);
        expect(rejected(withRef("refs/heads/feature/.hidden"))).toBe(true);
        expect(rejected(withRef("refs/heads/release.lock/v1"))).toBe(true);
        expect(rejected(withRef("refs/heads/a/b.lock"))).toBe(true);
        expect(rejected(withRef("refs/heads/@"))).toBe(true);
        expect(rejected(withRef("refs/heads/main.lock"))).toBe(true);
        expect(rejected(withRef("refs/heads/main "))).toBe(true);
        expect(rejected(withRef("refs/heads/main"))).toBe(false);
        expect(rejected(withRef("refs/heads/locked/release"))).toBe(false);
        expect(rejected(withRef("refs/heads/feat/oci-2.1_x"))).toBe(false);
    });

    test("keeps declared paths under shared/ and in managed mode only", () => {
        expect(rejected(optIn({ paths: ["shared/uploads"] }))).toBe(true);
        expect(rejected(managed({ paths: ["uploads"] }))).toBe(true);
        expect(rejected(managed({ paths: ["/shared/uploads"] }))).toBe(true);
        expect(rejected(managed({ paths: ["shared/../private"] }))).toBe(true);
        expect(rejected(managed({ paths: ["shared"] }))).toBe(true);
        expect(rejected(managed({ paths: ["shared/a", "shared/a"] }))).toBe(true);
        expect(rejected(managed({ paths: ["shared/a//b"] }))).toBe(true);
        expect(rejected(managed({ paths: ["shared\\a"] }))).toBe(true);
        expect(rejected(managed({ paths: Array.from({ length: 17 }, (_, index) => `shared/p${index}`) }))).toBe(true);
        expect(rejected(managed({ paths: ["shared/a/b", "shared/c"] }))).toBe(false);
    });

    test("requires a generation in managed mode and refuses one in opt-in mode", () => {
        expect(rejected(optIn({ generation: "1" }))).toBe(true);
        const withoutGeneration = managed();
        delete withoutGeneration.generation;
        expect(rejected(withoutGeneration)).toBe(true);
        expect(rejected(managed({ generation: "1.0 (dev)" }))).toBe(true);
        expect(rejected(managed({ generation: "1.0.0" }))).toBe(false);
    });
});

describe("managed-site layout helpers", () => {
    test("accepts only a full lowercase commit SHA as a release id", () => {
        expect(isManagedSiteReleaseId("a".repeat(40))).toBe(true);
        expect(isManagedSiteReleaseId("A".repeat(40))).toBe(false);
        expect(isManagedSiteReleaseId("a".repeat(39))).toBe(false);
        expect(isManagedSiteReleaseId("a".repeat(41))).toBe(false);
        expect(isManagedSiteReleaseId("../" + "a".repeat(37))).toBe(false);
        expect(managedSiteReleasePath("b".repeat(40))).toBe(`site/runtime/releases/${"b".repeat(40)}`);
    });

    test("accepts a contained relative shared path only", () => {
        expect(isManagedSitePath("shared/uploads")).toBe(true);
        expect(isManagedSitePath("shared/a/b")).toBe(true);
        expect(isManagedSitePath("shared")).toBe(false);
        expect(isManagedSitePath("shared/")).toBe(false);
        expect(isManagedSitePath("shared/./a")).toBe(false);
        expect(isManagedSitePath("shared/a/../b")).toBe(false);
        expect(isManagedSitePath("/shared/a")).toBe(false);
        expect(isManagedSitePath("private/a")).toBe(false);
        expect(isManagedSitePath("site/shared/a")).toBe(false);
        expect(isManagedSitePath("shared/" + "a".repeat(250))).toBe(false);
        expect(isManagedSitePath("shared/a\u0000b")).toBe(false);
    });

    test("validates URLs and refs through the exported helpers", () => {
        expect(isValidDeployGitUrl("https://git.example.com/acme/shop.git")).toBe(true);
        expect(isValidDeployGitUrl("https://git.example.com/acme/shop.git/")).toBe(true);
        expect(isValidDeployGitUrl("http://git.example.com/acme/shop.git")).toBe(false);
        expect(isValidDeployRef("refs/heads/main")).toBe(true);
        expect(isValidDeployRef("main")).toBe(false);
    });
});
