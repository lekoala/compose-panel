import { describe, expect, test } from "bun:test";
import { buildManagedSite, generatedGatewayPort, parseManagedSiteDraft, renderManagedSiteArtifacts } from "../src/managed-site-generate.ts";
import { parseManagedSiteManifest } from "../src/managed-site.ts";

const STACK = "/opt/stacks/acme-shop";

function draft(overrides: Record<string, string> = {}) {
    return {
        name: "acme-shop",
        siteId: "acme-shop",
        project: "acme-shop",
        port: "41001",
        gitUrl: "https://github.com/acme/shop.git",
        gitRef: "refs/heads/main",
        channel: "php-8.3",
        paths: "",
        ...overrides,
    };
}

describe("parseManagedSiteDraft", () => {
    test("defaults the site id and project to the stack name", () => {
        const result = parseManagedSiteDraft(draft({ siteId: "", project: "" }));
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.draft.siteId).toBe("acme-shop");
        expect(result.draft.project).toBe("acme-shop");
        expect(result.draft.port).toBe(41001);
        expect(result.draft.paths).toEqual([]);

        const underscored = parseManagedSiteDraft(draft({ name: "acme_shop", siteId: "", project: "" }));
        expect(underscored.ok).toBe(true);
        if (!underscored.ok) return;
        expect(underscored.draft.siteId).toBe("acme-shop");
        expect(underscored.draft.project).toBe("acme_shop");
    });

    test("keeps declared persistent roots and removes blank lines", () => {
        const result = parseManagedSiteDraft(draft({ paths: "shared/uploads\n\nshared/cache\nshared/uploads" }));
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.draft.paths).toEqual(["shared/uploads", "shared/cache"]);
    });

    test("refuses a port outside the reserved range and unsafe paths", () => {
        expect(parseManagedSiteDraft(draft({ port: "40999" })).ok).toBe(false);
        expect(parseManagedSiteDraft(draft({ port: "42000" })).ok).toBe(false);
        expect(parseManagedSiteDraft(draft({ port: "80" })).ok).toBe(false);
        expect(parseManagedSiteDraft(draft({ paths: "uploads" })).ok).toBe(false);
        expect(parseManagedSiteDraft(draft({ paths: "shared/../etc" })).ok).toBe(false);
        expect(parseManagedSiteDraft(draft({ paths: "shared/a/../../etc" })).ok).toBe(false);
    });
});

describe("buildManagedSite", () => {
    test("renders a deterministic manifest, Compose file and gateway policy", () => {
        const first = buildManagedSite({
            stackDir: STACK,
            siteId: "acme-shop",
            project: "acme-shop",
            port: 41001,
            gitUrl: "https://github.com/acme/shop.git",
            gitRef: "refs/heads/main",
            channel: "php-8.3",
            paths: ["shared/uploads"],
        });
        const second = buildManagedSite({
            stackDir: STACK,
            siteId: "acme-shop",
            project: "acme-shop",
            port: 41001,
            gitUrl: "https://github.com/acme/shop.git",
            gitRef: "refs/heads/main",
            channel: "php-8.3",
            paths: ["shared/uploads"],
        });
        expect(first.ok && second.ok).toBe(true);
        if (!first.ok || !second.ok) return;
        expect(second.manifestSource).toBe(first.manifestSource);
        expect(second.artifacts).toEqual(first.artifacts);

        const parsed = parseManagedSiteManifest(first.manifestSource);
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        expect(parsed.manifest.owner).toBe("managed");
        expect(parsed.manifest.gateway).toEqual({ port: 41001 });
        expect(parsed.manifest.runtime.image).toBe("php:8.3-fpm-alpine");

        expect(first.artifacts.compose).toContain('"127.0.0.1:41001:80"');
        expect(first.artifacts.compose).toContain(
            `source: '${STACK}/site/runtime'\n        target: '${STACK}/site/runtime'\n        read_only: true`,
        );
        expect(first.artifacts.compose).toContain(`source: '${STACK}/site/shared/uploads'`);
        expect(first.artifacts.compose).toContain("image: php:8.3-fpm-alpine");
        expect(first.artifacts.compose).not.toContain("build:");
        expect(generatedGatewayPort(first.artifacts.compose)).toBe(41001);
        expect(generatedGatewayPort(first.artifacts.compose.replace("127.0.0.1:41001", "127.0.0.1:9999"))).toBe(9999);
        expect(generatedGatewayPort("services:\n  gateway:\n    image: nginx\n")).toBeNull();
        expect(first.artifacts.gateway).toContain(`root ${STACK}/site/runtime/current/public;`);
        expect(first.artifacts.gateway).toContain(`SCRIPT_FILENAME ${STACK}/site/runtime/current/.compose-panel/revision.php;`);
        expect(first.artifacts.gateway).toContain("resolver 127.0.0.11 valid=10s ipv6=off;");
        expect(first.artifacts.gateway).toContain("set $php_fpm runtime:9000;");
        expect(first.artifacts.gateway).toContain("fastcgi_pass $php_fpm;");
        expect(first.artifacts.gateway).not.toContain("fastcgi_pass runtime:9000;");
        expect(first.artifacts.gateway).toContain("location = /index.php");
        expect(first.artifacts.gateway).toContain("location ~ \\.php$ {\n\t\tdeny all;");
        expect(first.artifacts.gateway).not.toContain("$document_root/profile.php");
        expect(first.artifacts.opcache).toContain("opcache.validate_timestamps=0");
    });

    test("adds the fixed Composer build to the manifest without changing the generated files", () => {
        const base = {
            stackDir: STACK,
            siteId: "acme-shop",
            project: "acme-shop",
            port: 41001,
            gitUrl: "https://github.com/acme/shop.git",
            gitRef: "refs/heads/main",
            channel: "php-8.3",
        };
        const plain = buildManagedSite(base);
        const built = buildManagedSite({ ...base, composer: true });
        expect(plain.ok && built.ok).toBe(true);
        if (!plain.ok || !built.ok) return;
        const parsedPlain = parseManagedSiteManifest(plain.manifestSource);
        const parsedBuilt = parseManagedSiteManifest(built.manifestSource);
        expect(parsedPlain.ok).toBe(true);
        expect(parsedBuilt.ok).toBe(true);
        if (!parsedPlain.ok || !parsedBuilt.ok) return;
        expect(parsedPlain.manifest.build).toBeUndefined();
        expect(parsedBuilt.manifest.build).toEqual({ kind: "composer" });
        expect(built.artifacts).toEqual(plain.artifacts);
        expect(built.manifestSource).toContain('"build": {\n    "kind": "composer"\n  }');
    });

    test("quotes persistent mount paths as YAML single-quoted scalars", () => {
        const built = buildManagedSite({
            stackDir: STACK,
            siteId: "acme-shop",
            project: "acme-shop",
            port: 41001,
            gitUrl: "https://github.com/acme/shop.git",
            gitRef: "refs/heads/main",
            channel: "php-8.3",
            paths: ["shared/a#b", "shared/it's"],
        });
        expect(built.ok).toBe(true);
        if (!built.ok) return;
        expect(built.artifacts.compose).toContain(`source: '${STACK}/site/shared/a#b'`);
        expect(built.artifacts.compose).toContain(`source: '${STACK}/site/shared/it''s'`);
    });

    test("refuses another channel, a non-canonical path and an unknown generation", () => {
        const unknown = buildManagedSite({
            stackDir: STACK,
            siteId: "acme-shop",
            project: "acme-shop",
            port: 41001,
            gitUrl: "https://github.com/acme/shop.git",
            gitRef: "refs/heads/main",
            channel: "php-7.4",
        });
        expect(unknown.ok).toBe(false);

        const relative = buildManagedSite({
            stackDir: "stacks/acme-shop",
            siteId: "acme-shop",
            project: "acme-shop",
            port: 41001,
            gitUrl: "https://github.com/acme/shop.git",
            gitRef: "refs/heads/main",
            channel: "php-8.3",
        });
        expect(relative.ok).toBe(false);

        const spaced = buildManagedSite({
            stackDir: "/opt/my stacks/acme-shop",
            siteId: "acme-shop",
            project: "acme-shop",
            port: 41001,
            gitUrl: "https://github.com/acme/shop.git",
            gitRef: "refs/heads/main",
            channel: "php-8.3",
        });
        expect(spaced.ok).toBe(false);

        const built = buildManagedSite({
            stackDir: STACK,
            siteId: "acme-shop",
            project: "acme-shop",
            port: 41001,
            gitUrl: "https://github.com/acme/shop.git",
            gitRef: "refs/heads/main",
            channel: "php-8.3",
        });
        expect(built.ok).toBe(true);
        if (!built.ok) return;
        const future = { ...built.manifest, generation: "2" };
        expect(renderManagedSiteArtifacts(STACK, future).ok).toBe(false);
    });

    test("an opt-in manifest has no generated artifacts", () => {
        const parsed = parseManagedSiteManifest(
            JSON.stringify({
                version: 1,
                siteId: "acme-shop",
                owner: "opt-in",
                project: "acme-shop",
                services: { gateway: "web", runtime: "php" },
                publicRoot: "public",
                runtime: { profile: "php-front-controller" },
                deploy: { kind: "bind-mount", git: { url: "https://github.com/acme/shop.git", ref: "refs/heads/main" } },
            }),
        );
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        expect(renderManagedSiteArtifacts(STACK, parsed.manifest).ok).toBe(false);
    });
});
