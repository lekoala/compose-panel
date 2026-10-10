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

describe("loadConfig reverse proxy mode", () => {
    const user = { ...base, COMPOSE_PANEL_ADMIN_USER: "lekoala" };

    test("direct loopback by default: no proxy trust, plain cookies", () => {
        const config = loadConfig(user);
        expect(config.publicOrigin).toBeNull();
        expect(config.trustProxy).toBe(false);
        expect(config.cookieSecure).toBe(false);
    });

    test("an https public origin turns on Secure cookies and the forwarded address", () => {
        const config = loadConfig({ ...user, COMPOSE_PANEL_PUBLIC_ORIGIN: "https://panel.example.com" });
        expect(config.publicOrigin).toBe("https://panel.example.com");
        expect(config.cookieSecure).toBe(true);
        expect(config.trustProxy).toBe(true);
    });

    test("refuses a plain-http public origin outside development", () => {
        expect(() => loadConfig({ ...user, COMPOSE_PANEL_PUBLIC_ORIGIN: "http://panel.example.com" })).toThrow(/https/);
        const dev = loadConfig({ ...user, COMPOSE_PANEL_PUBLIC_ORIGIN: "http://panel.localhost:8080", COMPOSE_PANEL_DEV: "true" });
        expect(dev.cookieSecure).toBe(false);
        expect(dev.trustProxy).toBe(true);
    });

    test("refuses switching off Secure cookies or the forwarded address behind a proxy", () => {
        const origin = { ...user, COMPOSE_PANEL_PUBLIC_ORIGIN: "https://panel.example.com" };
        expect(() => loadConfig({ ...origin, COMPOSE_PANEL_COOKIE_SECURE: "false" })).toThrow(/COOKIE_SECURE/);
        expect(() => loadConfig({ ...origin, COMPOSE_PANEL_TRUST_PROXY: "false" })).toThrow(/TRUST_PROXY/);
    });

    test("refuses trusting forwarded headers without a public origin", () => {
        expect(() => loadConfig({ ...user, COMPOSE_PANEL_TRUST_PROXY: "true" })).toThrow(/PUBLIC_ORIGIN/);
    });
});
