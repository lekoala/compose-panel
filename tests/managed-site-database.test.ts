import { describe, expect, test } from "bun:test";
import type { Stats } from "node:fs";
import type { ManagedSiteManifest } from "../src/managed-site.ts";
import { MANAGED_SITE_DATABASE_ENV_MAX_BYTES } from "../src/managed-site.ts";
import { checkManagedSiteDatabaseEnvFile } from "../src/managed-site-database.ts";

const stackDir = "/opt/stacks/acme-shop";
const manifest: ManagedSiteManifest = {
    version: 2,
    siteId: "acme-shop",
    owner: "managed",
    project: "acme-shop",
    services: { gateway: "gateway", runtime: "runtime" },
    gateway: { port: 41001 },
    publicRoot: "public",
    runtime: { profile: "php-front-controller", image: "php:8.3-fpm-alpine" },
    database: { kind: "existing", engine: "mariadb", network: "acme-db" },
    deploy: { kind: "bind-mount", git: { url: "https://github.com/acme/shop.git", ref: "refs/heads/main" } },
    generation: "2",
};

function stat(options: { mode?: number; uid?: number; size?: number; file?: boolean; link?: boolean } = {}): Stats {
    return {
        isFile: () => options.file ?? true,
        isSymbolicLink: () => options.link ?? false,
        mode: options.mode ?? 0o100600,
        uid: options.uid ?? 1000,
        size: options.size ?? 16,
    } as unknown as Stats;
}

async function check(value: Stats | Error, options: { ownerUid?: number | null; manifest?: ManagedSiteManifest } = {}) {
    return await checkManagedSiteDatabaseEnvFile(stackDir, options.manifest ?? manifest, {
        ownerUid: options.ownerUid !== undefined ? options.ownerUid : 1000,
        lstat: async () => {
            if (value instanceof Error) throw value;
            return value;
        },
    });
}

describe("checkManagedSiteDatabaseEnvFile", () => {
    test("does nothing when no database is declared", async () => {
        const result = await check(new Error("must not be called"), {
            manifest: { ...manifest, version: 1, database: undefined, generation: "1" },
        });
        expect(result).toEqual({ ok: true });
    });

    test("accepts a regular 0600 file owned by the panel account", async () => {
        expect(await check(stat())).toEqual({ ok: true });
    });

    test("refuses a missing, non-regular or symlinked file", async () => {
        expect((await check(Object.assign(new Error("missing"), { code: "ENOENT" }))).ok).toBe(false);
        expect((await check(stat({ file: false }))).ok).toBe(false);
        expect((await check(stat({ link: true }))).ok).toBe(false);
        expect((await check(new Error("denied"))).ok).toBe(false);
    });

    test("refuses group or other access, another owner and an oversized file", async () => {
        expect((await check(stat({ mode: 0o100644 }))).ok).toBe(false);
        expect((await check(stat({ mode: 0o100640 }))).ok).toBe(false);
        expect((await check(stat({ uid: 1001 }))).ok).toBe(false);
        expect((await check(stat({ size: MANAGED_SITE_DATABASE_ENV_MAX_BYTES + 1 }))).ok).toBe(false);
    });

    test("does not check ownership when the platform has no process uid", async () => {
        expect(await check(stat({ uid: 9999 }), { ownerUid: null })).toEqual({ ok: true });
    });
});
