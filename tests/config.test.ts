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
