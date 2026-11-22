import { describe, expect, test } from "bun:test";
import type { ManagedSiteManifest } from "../src/managed-site.ts";
import { checkManagedSiteProfile, parseManagedSiteComposeFacts, type ManagedSiteComposeFacts } from "../src/managed-site-profile.ts";

const stackDir = "/opt/stacks/acme-shop";
const runtimeDir = `${stackDir}/site/runtime`;
const sharedDir = `${stackDir}/site/shared`;

const manifest: ManagedSiteManifest = {
    version: 1,
    siteId: "acme-shop",
    owner: "opt-in",
    project: "acme-shop",
    services: { gateway: "web", runtime: "php" },
    publicRoot: "public",
    runtime: { profile: "php-front-controller" },
    deploy: { kind: "bind-mount", git: { url: "https://github.com/acme/shop.git", ref: "refs/heads/main" } },
};

interface TestService {
    image?: unknown;
    build?: unknown;
    network_mode?: unknown;
    ports?: unknown;
    volumes?: unknown;
    tmpfs?: unknown;
    volumes_from?: unknown;
    networks?: unknown;
}

interface TestConfig {
    name?: unknown;
    services: Record<string, TestService>;
    networks?: Record<string, unknown>;
}

function baseConfig(): TestConfig {
    return {
        name: "acme-shop",
        services: {
            web: {
                image: "nginx:alpine",
                ports: [{ mode: "ingress", host_ip: "127.0.0.1", published: "18431", target: 80, protocol: "tcp" }],
                volumes: [
                    { type: "bind", source: runtimeDir, target: runtimeDir, read_only: true },
                    {
                        type: "bind",
                        source: `${stackDir}/generated/nginx-site.conf`,
                        target: "/etc/nginx/conf.d/default.conf",
                        read_only: true,
                    },
                ],
                networks: { default: null },
            },
            php: {
                image: "php:8.3-fpm-alpine",
                volumes: [
                    { type: "bind", source: runtimeDir, target: runtimeDir, read_only: true },
                    { type: "bind", source: sharedDir, target: sharedDir },
                ],
                networks: { default: null },
            },
        },
        networks: { default: { name: "acme-shop_default" } },
    };
}

function factsOf(config: TestConfig): ManagedSiteComposeFacts | null {
    return parseManagedSiteComposeFacts(JSON.stringify(config));
}

function check(config: TestConfig) {
    const facts = factsOf(config);
    if (!facts) throw new Error("fixture did not project");
    return checkManagedSiteProfile({ manifest, stackDir, facts });
}

function refused(config: TestConfig): boolean {
    const result = check(config);
    return result.ok === false && result.reason.length > 0;
}

function mutated(change: (config: TestConfig) => void): TestConfig {
    const config = baseConfig();
    change(config);
    return config;
}

describe("parseManagedSiteComposeFacts", () => {
    test("projects a valid configuration without leaking anything else", () => {
        const facts = factsOf(baseConfig());
        expect(facts).not.toBeNull();
        expect(facts!.name).toBe("acme-shop");
        expect([...facts!.services.keys()]).toEqual(["web", "php"]);
        expect(facts!.services.get("web")!.ports).toEqual([{ hostIp: "127.0.0.1", published: 18431, target: 80, protocol: "tcp" }]);
        expect(facts!.services.get("php")!.mounts[0]).toEqual({ type: "bind", source: runtimeDir, target: runtimeDir, readOnly: true });
        expect(facts!.externalNetworks).toEqual([]);
    });

    test("refuses malformed JSON and unexpected shapes", () => {
        expect(parseManagedSiteComposeFacts("not json")).toBeNull();
        expect(parseManagedSiteComposeFacts("{}")).toBeNull();
        expect(factsOf(mutated((config) => (config.services.web!.ports = "80")))).toBeNull();
        expect(factsOf(mutated((config) => (config.services.web!.volumes = [42])))).toBeNull();
        expect(factsOf(mutated((config) => (config.services.web!.ports = [{ target: 0 }])))).toBeNull();
        expect(factsOf(mutated((config) => delete config.services.web!.ports))).not.toBeNull();
        expect(parseManagedSiteComposeFacts(JSON.stringify({ services: { "bad name": {} } }))).toBeNull();
        expect(factsOf(mutated((config) => (config.networks = { default: "x" })))).toBeNull();
    });

    test("reads external networks declared as a boolean or an object", () => {
        expect(factsOf(mutated((config) => (config.networks = { shared: { external: true } })))!.externalNetworks).toEqual(["shared"]);
        expect(factsOf(mutated((config) => (config.networks = { shared: { external: { name: "other" } } })))!.externalNetworks).toEqual([
            "shared",
        ]);
        expect(factsOf(mutated((config) => (config.networks = { shared: { external: false } })))!.externalNetworks).toEqual([]);
    });

    test("accepts short port and volume syntax", () => {
        const config = mutated((value) => {
            value.services.web!.ports = ["127.0.0.1:18431:80"];
            value.services.web!.volumes = [`${runtimeDir}:${runtimeDir}:ro`];
            value.services.php!.volumes = [`${runtimeDir}:${runtimeDir}:ro`, `${sharedDir}:${sharedDir}`];
        });
        const facts = factsOf(config);
        expect(facts).not.toBeNull();
        expect(facts!.services.get("web")!.ports).toEqual([{ hostIp: "127.0.0.1", published: 18431, target: 80, protocol: "tcp" }]);
        expect(facts!.services.get("web")!.mounts[0]).toEqual({ type: "bind", source: runtimeDir, target: runtimeDir, readOnly: true });
        expect(check(config).ok).toBe(true);
    });

    test("refuses out-of-range ports and port ranges", () => {
        expect(factsOf(mutated((config) => (config.services.web!.ports = ["8080-8085:80"])))).toBeNull();
        expect(factsOf(mutated((config) => (config.services.web!.ports = [{ target: 80, published: "70000" }])))).toBeNull();
    });
});

describe("checkManagedSiteProfile", () => {
    test("accepts the declared gateway, runtime, mounts and loopback port", () => {
        expect(check(baseConfig())).toEqual({ ok: true });
    });

    test("accepts a declared persistent path under site/shared on the runtime only", () => {
        const declared = `${stackDir}/site/shared/uploads`;
        const config = mutated((value) => {
            value.services.php!.volumes = [
                { type: "bind", source: runtimeDir, target: runtimeDir, read_only: true },
                { type: "bind", source: declared, target: declared, read_only: false },
            ];
        });
        const facts = factsOf(config);
        if (!facts) throw new Error("fixture did not project");
        const result = checkManagedSiteProfile({
            manifest: {
                ...manifest,
                owner: "managed",
                gateway: { port: 18431 },
                runtime: { profile: "php-front-controller", image: "php:8.3-fpm-alpine" },
                generation: "1",
                paths: ["shared/uploads"],
            },
            stackDir,
            facts,
        });
        expect(result).toEqual({ ok: true });
    });

    test("refuses another or a missing effective project name", () => {
        expect(refused(mutated((config) => (config.name = "other")))).toBe(true);
        expect(refused(mutated((config) => delete config.name))).toBe(true);
    });

    test("refuses a missing gateway or runtime service", () => {
        expect(refused(mutated((config) => delete config.services.web))).toBe(true);
        expect(refused(mutated((config) => delete config.services.php))).toBe(true);
    });

    test("requires one loopback TCP port on the gateway and none on the runtime", () => {
        expect(refused(mutated((config) => (config.services.web!.ports = [])))).toBe(true);
        expect(
            refused(
                mutated(
                    (config) =>
                        (config.services.web!.ports = [
                            { host_ip: "127.0.0.1", published: "18431", target: 80, protocol: "tcp" },
                            { host_ip: "127.0.0.1", published: "18432", target: 81, protocol: "tcp" },
                        ]),
                ),
            ),
        ).toBe(true);
        expect(
            refused(
                mutated(
                    (config) => (config.services.web!.ports = [{ host_ip: "127.0.0.1", published: "18431", target: 80, protocol: "udp" }]),
                ),
            ),
        ).toBe(true);
        expect(
            refused(
                mutated(
                    (config) => (config.services.web!.ports = [{ host_ip: "0.0.0.0", published: "18431", target: 80, protocol: "tcp" }]),
                ),
            ),
        ).toBe(true);
        expect(refused(mutated((config) => (config.services.web!.ports = [{ published: "18431", target: 80, protocol: "tcp" }])))).toBe(
            true,
        );
        expect(refused(mutated((config) => (config.services.web!.ports = [{ host_ip: "127.0.0.1", target: 80, protocol: "tcp" }])))).toBe(
            true,
        );
        expect(
            refused(
                mutated(
                    (config) => (config.services.php!.ports = [{ host_ip: "127.0.0.1", published: "9000", target: 9000, protocol: "tcp" }]),
                ),
            ),
        ).toBe(true);
    });

    test("refuses an image-only or implicit-latest runtime", () => {
        expect(refused(mutated((config) => (config.services.php!.build = ".")))).toBe(true);
        expect(refused(mutated((config) => delete config.services.php!.image))).toBe(true);
        expect(refused(mutated((config) => (config.services.php!.image = "php")))).toBe(true);
        expect(check(mutated((config) => (config.services.php!.image = "php:latest"))).ok).toBe(true);
        expect(check(mutated((config) => (config.services.php!.image = `php@sha256:${"a".repeat(64)}`))).ok).toBe(true);
    });

    test("requires the same read-only runtime mount in both services", () => {
        expect(refused(mutated((config) => (config.services.web!.volumes = [])))).toBe(true);
        expect(refused(mutated((config) => (config.services.php!.volumes = [])))).toBe(true);
        expect(
            refused(
                mutated(
                    (config) =>
                        (config.services.php!.volumes = [
                            { type: "bind", source: `${stackDir}/site/runtime/`, target: runtimeDir, read_only: true },
                        ]),
                ),
            ),
        ).toBe(true);
        expect(
            refused(
                mutated(
                    (config) =>
                        (config.services.php!.volumes = [{ type: "bind", source: runtimeDir, target: "/srv/runtime", read_only: true }]),
                ),
            ),
        ).toBe(true);
        expect(
            refused(
                mutated(
                    (config) =>
                        (config.services.php!.volumes = [{ type: "bind", source: runtimeDir, target: runtimeDir, read_only: false }]),
                ),
            ),
        ).toBe(true);
        expect(
            refused(
                mutated(
                    (config) =>
                        (config.services.php!.volumes = [
                            { type: "bind", source: runtimeDir, target: runtimeDir, read_only: true },
                            { type: "bind", source: runtimeDir, target: runtimeDir, read_only: true },
                        ]),
                ),
            ),
        ).toBe(true);
        expect(
            refused(
                mutated(
                    (config) =>
                        (config.services.web!.volumes = [
                            { type: "bind", source: runtimeDir, target: runtimeDir, read_only: true },
                            { type: "volume", source: "cache", target: runtimeDir, read_only: true },
                        ]),
                ),
            ),
        ).toBe(true);
    });

    test("refuses a mount that masks current or exposes private state", () => {
        const added = (service: "web" | "php", mount: Record<string, unknown>) =>
            mutated((config) => {
                const current = config.services[service]!.volumes as Record<string, unknown>[] | undefined;
                config.services[service]!.volumes = [...(current ?? []), mount];
            });
        expect(
            refused(
                added("php", {
                    type: "bind",
                    source: `${runtimeDir}/current/public`,
                    target: `${runtimeDir}/current/public`,
                    read_only: true,
                }),
            ),
        ).toBe(true);
        expect(
            refused(added("web", { type: "bind", source: `${runtimeDir}/current`, target: `${runtimeDir}/current`, read_only: true })),
        ).toBe(true);
        expect(refused(added("php", { type: "bind", source: `${stackDir}/site/private`, target: "/private", read_only: true }))).toBe(true);
        expect(refused(added("php", { type: "bind", source: `${stackDir}/site/private/git`, target: "/git", read_only: true }))).toBe(true);
        expect(refused(added("php", { type: "bind", source: `${stackDir}/site/staging`, target: "/staging", read_only: true }))).toBe(true);
        expect(refused(added("web", { type: "bind", source: `${stackDir}/compose.yaml`, target: "/compose.yaml", read_only: true }))).toBe(
            true,
        );
        expect(refused(added("web", { type: "bind", source: `${stackDir}/.env`, target: "/.env", read_only: true }))).toBe(true);
        expect(
            refused(added("web", { type: "bind", source: "/data/uploads", target: `${stackDir}/site/private/x`, read_only: true })),
        ).toBe(true);
        expect(check(added("php", { type: "bind", source: sharedDir, target: "/data", read_only: false })).ok).toBe(false);
        // Same-path only: an alias of shared/ (or of any release path) is refused.
        expect(refused(added("php", { type: "bind", source: sharedDir, target: sharedDir, read_only: true }))).toBe(true);
        expect(refused(added("web", { type: "bind", source: sharedDir, target: sharedDir, read_only: false }))).toBe(true);
        expect(check(added("php", { type: "bind", source: sharedDir, target: sharedDir, read_only: false })).ok).toBe(true);
    });

    test("refuses parent binds, release aliases, non-canonical paths and volumes_from", () => {
        const added = (service: "web" | "php", mount: Record<string, unknown>) =>
            mutated((config) => {
                const current = config.services[service]!.volumes as Record<string, unknown>[] | undefined;
                config.services[service]!.volumes = [...(current ?? []), mount];
            });
        // The whole site tree, or its parent, exposes private/ and staging/.
        expect(refused(added("web", { type: "bind", source: `${stackDir}/site`, target: "/mnt/site", read_only: true }))).toBe(true);
        expect(refused(added("web", { type: "bind", source: stackDir, target: "/mnt/stack", read_only: true }))).toBe(true);
        expect(refused(added("web", { type: "bind", source: "/opt/stacks", target: "/stacks", read_only: true }))).toBe(true);
        // A write alias of one release, of releases/ or of runtime/ is not the
        // single accepted read-only runtime mount.
        expect(refused(added("php", { type: "bind", source: `${runtimeDir}/releases`, target: "/data", read_only: false }))).toBe(true);
        expect(refused(added("php", { type: "bind", source: `${runtimeDir}/releases`, target: "/data", read_only: true }))).toBe(true);
        expect(refused(added("php", { type: "bind", source: `${runtimeDir}/current/public`, target: "/www", read_only: true }))).toBe(true);
        expect(refused(added("php", { type: "bind", source: runtimeDir, target: "/runtime", read_only: true }))).toBe(true);
        // Non-canonical paths are refused instead of silently normalized.
        expect(
            refused(
                added("php", { type: "bind", source: `${runtimeDir}/../runtime`, target: `${runtimeDir}/../runtime`, read_only: true }),
            ),
        ).toBe(true);
        expect(refused(added("php", { type: "bind", source: `${stackDir}//site/artifacts`, target: "/artifacts", read_only: true }))).toBe(
            true,
        );
        expect(refused(added("php", { type: "bind", source: "/srv/data/", target: "/data", read_only: true }))).toBe(true);
        // volumes_from always mounts an unverified path.
        expect(refused(mutated((config) => (config.services.php!.volumes_from = ["web"])))).toBe(true);
        expect(refused(mutated((config) => (config.services.web!.volumes_from = ["other"])))).toBe(true);
    });

    test("refuses a tmpfs overlay on releases or current", () => {
        const inline = (target: string) =>
            mutated((config) => {
                config.services.php!.volumes = [...(config.services.php!.volumes as Record<string, unknown>[]), { type: "tmpfs", target }];
            });
        expect(refused(inline(`${runtimeDir}/current/public`))).toBe(true);
        expect(refused(inline(runtimeDir))).toBe(true);
        expect(refused(inline(`${stackDir}/site/private`))).toBe(true);
        expect(check(inline("/run/cache")).ok).toBe(true);
        expect(refused(mutated((config) => (config.services.php!.tmpfs = [`${runtimeDir}/current`])))).toBe(true);
        expect(refused(mutated((config) => (config.services.web!.tmpfs = [stackDir])))).toBe(true);
        expect(check(mutated((config) => (config.services.php!.tmpfs = ["/run", "/tmp"]))).ok).toBe(true);
    });

    test("checks every service, not only the declared pair", () => {
        const withThird = (service: Record<string, unknown>) =>
            mutated((config) => {
                config.services.worker = service;
            });
        expect(
            refused(
                withThird({
                    image: "alpine:3.20",
                    volumes: [{ type: "bind", source: `${stackDir}/site/private`, target: "/private", read_only: true }],
                }),
            ),
        ).toBe(true);
        expect(
            refused(withThird({ image: "alpine:3.20", volumes: [{ type: "bind", source: stackDir, target: "/stack", read_only: true }] })),
        ).toBe(true);
        expect(
            refused(
                withThird({ image: "alpine:3.20", volumes: [{ type: "bind", source: runtimeDir, target: runtimeDir, read_only: true }] }),
            ),
        ).toBe(true);
        expect(refused(withThird({ image: "alpine:3.20", network_mode: "host" }))).toBe(true);
        expect(refused(withThird({ image: "alpine:3.20", tmpfs: [`${runtimeDir}/current/public`] }))).toBe(true);
        expect(refused(withThird({ image: "alpine:3.20", volumes_from: ["php"] }))).toBe(true);
        expect(check(withThird({ image: "alpine:3.20" })).ok).toBe(true);
    });

    test("requires the gateway and runtime to share a project network", () => {
        expect(
            refused(
                mutated((config) => {
                    config.networks = { default: null, backend: null };
                    config.services.web!.networks = { default: null };
                    config.services.php!.networks = { backend: null };
                }),
            ),
        ).toBe(true);
        expect(
            check(
                mutated((config) => {
                    config.networks = { default: null, backend: null };
                    config.services.web!.networks = { default: null, backend: null };
                    config.services.php!.networks = { backend: null };
                }),
            ).ok,
        ).toBe(true);
    });

    test("refuses an external network or host networking", () => {
        expect(
            refused(
                mutated((config) => {
                    config.networks = { default: null, shared: { external: true } };
                    config.services.php!.networks = { default: null, shared: null };
                }),
            ),
        ).toBe(true);
        // A third service on an external network is refused too: ADR 0043
        // refuses any declared service, not only the declared pair.
        expect(
            refused(
                mutated((config) => {
                    config.networks = { default: null, shared: { external: true } };
                    config.services.worker = { image: "alpine:3.20", networks: { default: null, shared: null } };
                }),
            ),
        ).toBe(true);
        expect(refused(mutated((config) => (config.services.web!.network_mode = "host")))).toBe(true);
        expect(refused(mutated((config) => (config.services.php!.network_mode = "container:other")))).toBe(true);
    });
});
