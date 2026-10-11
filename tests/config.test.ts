import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";

const base = { STACKS_DIR: "/stacks", COMPOSE_PANEL_ADMIN_PASSWORD_HASH: "$argon2id$fake" };

describe("loadConfig admin username", () => {
    test("refuses the default 'admin' outside development", () => {
        expect(() => loadConfig({ ...base })).toThrow(/common name/i);
    });

    test("refuses a weak username case-insensitively", () => {
        expect(() => loadConfig({ ...base, COMPOSE_PANEL_ADMIN_USER: "root" })).toThrow();
        expect(() => loadConfig({ ...base, COMPOSE_PANEL_ADMIN_USER: "ADMIN" })).toThrow();
    });

    test("accepts a unique username", () => {
        const config = loadConfig({ ...base, COMPOSE_PANEL_ADMIN_USER: "lekoala" });
        expect(config.adminUser).toBe("lekoala");
        expect(config.devMode).toBe(false);
    });

    test("allows a weak username in development mode", () => {
        const config = loadConfig({ ...base, COMPOSE_PANEL_ADMIN_USER: "admin", COMPOSE_PANEL_DEV: "true" });
        expect(config.adminUser).toBe("admin");
        expect(config.devMode).toBe(true);
    });

    test("defaults the opaque-origin relaxation to false", () => {
        const config = loadConfig({ ...base, COMPOSE_PANEL_ADMIN_USER: "lekoala" });
        expect(config.allowOpaqueOrigin).toBe(false);
        expect(config.devMode).toBe(false);
    });
});

describe("loadConfig audit and login backoff", () => {
    test("defaults the audit log on, daily, with a derived directory", () => {
        const config = loadConfig({ ...base, COMPOSE_PANEL_ADMIN_USER: "lekoala" });
        expect(config.audit.enabled).toBe(true);
        expect(config.audit.dir).toBeNull();
        expect(config.audit.rotation).toBe("day");
        expect(config.audit.retainFiles).toBe(31);
        expect(config.loginRateLimit.backoffMaxMs).toBe(2000);
    });

    test("parses audit overrides", () => {
        const config = loadConfig({
            ...base,
            COMPOSE_PANEL_ADMIN_USER: "lekoala",
            COMPOSE_PANEL_AUDIT_ENABLED: "false",
            COMPOSE_PANEL_AUDIT_DIR: "/var/log/compose-panel",
            COMPOSE_PANEL_AUDIT_ROTATION: "month",
            COMPOSE_PANEL_AUDIT_RETAIN_FILES: "12",
            COMPOSE_PANEL_LOGIN_BACKOFF_MAX_MS: "5000",
        });
        expect(config.audit.enabled).toBe(false);
        expect(config.audit.dir).toBe("/var/log/compose-panel");
        expect(config.audit.rotation).toBe("month");
        expect(config.audit.retainFiles).toBe(12);
        expect(config.loginRateLimit.backoffMaxMs).toBe(5000);
    });

    test("rejects an unknown rotation", () => {
        expect(() => loadConfig({ ...base, COMPOSE_PANEL_ADMIN_USER: "lekoala", COMPOSE_PANEL_AUDIT_ROTATION: "hourly" })).toThrow(/ROTATION/);
    });
});

describe("loadConfig timezone", () => {
    const user = { ...base, COMPOSE_PANEL_ADMIN_USER: "lekoala" };

    test("defaults to the reader's browser zone", () => {
        expect(loadConfig(user).timeZone).toBe("");
    });

    test("accepts a valid IANA time zone", () => {
        expect(loadConfig({ ...user, COMPOSE_PANEL_TIMEZONE: "Europe/Brussels" }).timeZone).toBe("Europe/Brussels");
    });

    test("rejects an invalid time zone", () => {
        expect(() => loadConfig({ ...user, COMPOSE_PANEL_TIMEZONE: "Mars/Olympus" })).toThrow(/TIMEZONE/);
    });
});

describe("loadConfig proxy origins", () => {
    const user = { ...base, COMPOSE_PANEL_ADMIN_USER: "lekoala" };

    test("direct loopback by default: no origins, plain cookies", () => {
        const config = loadConfig(user);
        expect(config.proxyOrigins).toEqual([]);
        expect(config.allowLoopback).toBe(false);
        expect(config.cookieSecure).toBe(false);
    });

    test("parses a comma-separated origin list, normalized", () => {
        const config = loadConfig({ ...user, COMPOSE_PANEL_PROXY_ORIGINS: "https://panel.example.com, https://oracle.example.ts.net:8443/" });
        expect(config.proxyOrigins).toEqual(["https://panel.example.com", "https://oracle.example.ts.net:8443"]);
    });

    test("refuses a plain-http origin outside development", () => {
        expect(() => loadConfig({ ...user, COMPOSE_PANEL_PROXY_ORIGINS: "http://panel.example.com" })).toThrow(/https/);
        const dev = loadConfig({ ...user, COMPOSE_PANEL_PROXY_ORIGINS: "http://panel.localhost:8080", COMPOSE_PANEL_DEV: "true" });
        expect(dev.proxyOrigins).toEqual(["http://panel.localhost:8080"]);
        expect(dev.cookieSecure).toBe(false);
    });

    test("refuses credentials, empty entries and duplicates", () => {
        expect(() => loadConfig({ ...user, COMPOSE_PANEL_PROXY_ORIGINS: "https://user:pass@panel.example.com" })).toThrow(/credentials/);
        expect(() => loadConfig({ ...user, COMPOSE_PANEL_PROXY_ORIGINS: "https://panel.example.com," })).toThrow(/empty/);
        expect(() => loadConfig({ ...user, COMPOSE_PANEL_PROXY_ORIGINS: "https://panel.example.com,https://panel.example.com" })).toThrow(/twice/);
    });

    test("parses allowLoopback, off by default", () => {
        expect(loadConfig(user).allowLoopback).toBe(false);
        expect(loadConfig({ ...user, COMPOSE_PANEL_ALLOW_LOOPBACK: "true" }).allowLoopback).toBe(true);
    });

    test("COMPOSE_PANEL_COOKIE_SECURE still controls the direct path", () => {
        expect(loadConfig({ ...user, COMPOSE_PANEL_COOKIE_SECURE: "true" }).cookieSecure).toBe(true);
    });

    test("refuses the legacy COMPOSE_PANEL_PUBLIC_ORIGIN at startup", () => {
        expect(() => loadConfig({ ...user, COMPOSE_PANEL_PUBLIC_ORIGIN: "https://panel.example.com" })).toThrow(/no longer supported/);
    });

    test("refuses the legacy COMPOSE_PANEL_TRUST_PROXY at startup", () => {
        expect(() => loadConfig({ ...user, COMPOSE_PANEL_TRUST_PROXY: "true" })).toThrow(/no longer supported/);
    });
});

describe("loadConfig stacks path aliases", () => {
    const user = { ...base, COMPOSE_PANEL_ADMIN_USER: "lekoala" };

    test("defaults to no aliases", () => {
        expect(loadConfig(user).hostStacksPathAliases).toEqual([]);
    });

    test("parses hostPrefix=panelPrefix entries", () => {
        const config = loadConfig({ ...user, COMPOSE_PANEL_STACKS_PATH_ALIASES: "/opt/stacks=/app/stacks, /srv=/data" });
        expect(config.hostStacksPathAliases).toEqual([
            { from: "/opt/stacks", to: "/app/stacks" },
            { from: "/srv", to: "/data" },
        ]);
    });

    test("refuses malformed entries", () => {
        expect(() => loadConfig({ ...user, COMPOSE_PANEL_STACKS_PATH_ALIASES: "/opt/stacks" })).toThrow(/hostPrefix=panelPrefix/);
        expect(() => loadConfig({ ...user, COMPOSE_PANEL_STACKS_PATH_ALIASES: "=/app" })).toThrow(/hostPrefix=panelPrefix/);
        expect(() => loadConfig({ ...user, COMPOSE_PANEL_STACKS_PATH_ALIASES: "/opt/stacks=" })).toThrow(/hostPrefix=panelPrefix/);
        expect(() => loadConfig({ ...user, COMPOSE_PANEL_STACKS_PATH_ALIASES: "/a=/b," })).toThrow(/empty entry/);
    });

    test("refuses relative prefixes and dot-dot segments", () => {
        expect(() => loadConfig({ ...user, COMPOSE_PANEL_STACKS_PATH_ALIASES: "opt/stacks=/app/stacks" })).toThrow(/absolute prefixes/);
        expect(() => loadConfig({ ...user, COMPOSE_PANEL_STACKS_PATH_ALIASES: "/opt/stacks=app/stacks" })).toThrow(/absolute prefixes/);
        expect(() => loadConfig({ ...user, COMPOSE_PANEL_STACKS_PATH_ALIASES: "/opt/../stacks=/app/stacks" })).toThrow(/\.\./);
        expect(() => loadConfig({ ...user, COMPOSE_PANEL_STACKS_PATH_ALIASES: "/opt/stacks=/app/../stacks" })).toThrow(/\.\./);
    });
});

describe("loadConfig compose engine", () => {
    const user = { ...base, COMPOSE_PANEL_ADMIN_USER: "lekoala" };

    test("defaults to docker", () => {
        expect(loadConfig(user).composeEngine).toBe("docker");
    });

    test("refuses podman and unknown engines at startup", () => {
        expect(() => loadConfig({ ...user, COMPOSE_PANEL_COMPOSE_ENGINE: "podman" })).toThrow(/not implemented yet/);
        expect(() => loadConfig({ ...user, COMPOSE_PANEL_COMPOSE_ENGINE: "containerd" })).toThrow(/not supported/);
    });
});
