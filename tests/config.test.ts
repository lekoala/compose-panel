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
