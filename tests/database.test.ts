import { describe, expect, test } from "bun:test";
import { buildExplorerUrl, isExplorerHref, normalizeDatabaseExplorerUrl, parseDatabaseExplorer } from "../src/database.ts";

describe("parseDatabaseExplorer", () => {
    test("returns null when the extension is absent", () => {
        expect(parseDatabaseExplorer("services:\n  app:\n    image: nginx\n")).toEqual({ ok: true, value: null });
    });

    test("returns null when x-compose-panel has no database block", () => {
        expect(parseDatabaseExplorer("x-compose-panel:\n  toolbox:\n    sources: []\n")).toEqual({ ok: true, value: null });
    });

    test("reads a label and scalar query parameters", () => {
        const source = "x-compose-panel:\n  database:\n    label: LibreDB\n    query:\n      connection: seed:shop-staging\n";
        expect(parseDatabaseExplorer(source)).toEqual({
            ok: true,
            value: { label: "LibreDB", query: { connection: "seed:shop-staging" } },
        });
    });

    test("accepts a query without a label and a label without a query", () => {
        const queryOnly = parseDatabaseExplorer("x-compose-panel:\n  database:\n    query:\n      db: shop\n");
        expect(queryOnly.ok && queryOnly.value).toEqual({ label: null, query: { db: "shop" } });
        const labelOnly = parseDatabaseExplorer("x-compose-panel:\n  database:\n    label: Adminer\n");
        expect(labelOnly.ok && labelOnly.value).toEqual({ label: "Adminer", query: {} });
    });

    test("ignores unknown keys inside the block", () => {
        const source = "x-compose-panel:\n  database:\n    label: Adminer\n    extra: whatever\n    query:\n      db: shop\n";
        const parsed = parseDatabaseExplorer(source);
        expect(parsed.ok && parsed.value?.query).toEqual({ db: "shop" });
    });

    test("rejects bare numbers and accepts booleans", () => {
        // A bare number is parsed by YAML into a value whose textual form may
        // differ from what was written; quoting is required instead.
        expect(parseDatabaseExplorer("x-compose-panel:\n  database:\n    query:\n      port: 5432\n").ok).toBe(false);
        expect(parseDatabaseExplorer("x-compose-panel:\n  database:\n    query:\n      port: '0123'\n").ok).toBe(true);
        const bool = parseDatabaseExplorer("x-compose-panel:\n  database:\n    query:\n      ssl: true\n");
        expect(bool.ok && bool.value?.query).toEqual({ ssl: "true" });
    });

    test("refuses a database block that is not a mapping", () => {
        expect(parseDatabaseExplorer("x-compose-panel:\n  database: libredb\n").ok).toBe(false);
        expect(parseDatabaseExplorer("x-compose-panel:\n  database: [libredb]\n").ok).toBe(false);
    });

    test("refuses a non-string or over-long label", () => {
        expect(parseDatabaseExplorer("x-compose-panel:\n  database:\n    label: 12\n").ok).toBe(false);
        expect(parseDatabaseExplorer(`x-compose-panel:\n  database:\n    label: ${"a".repeat(65)}\n`).ok).toBe(false);
    });

    test("refuses a query that is not a mapping", () => {
        expect(parseDatabaseExplorer("x-compose-panel:\n  database:\n    query: shop\n").ok).toBe(false);
    });

    test("refuses non-scalar query values", () => {
        expect(parseDatabaseExplorer("x-compose-panel:\n  database:\n    query:\n      a:\n        nested: 1\n").ok).toBe(false);
        expect(parseDatabaseExplorer("x-compose-panel:\n  database:\n    query:\n      a: [1, 2]\n").ok).toBe(false);
        expect(parseDatabaseExplorer("x-compose-panel:\n  database:\n    query:\n      a:\n").ok).toBe(false);
    });

    test("refuses an empty or over-long query value", () => {
        expect(parseDatabaseExplorer("x-compose-panel:\n  database:\n    query:\n      a: ''\n").ok).toBe(false);
        expect(parseDatabaseExplorer(`x-compose-panel:\n  database:\n    query:\n      a: ${"x".repeat(257)}\n`).ok).toBe(false);
    });

    test("refuses control characters in a key or a value", () => {
        expect(parseDatabaseExplorer('x-compose-panel:\n  database:\n    query:\n      "a\\u0007": v\n').ok).toBe(false);
        expect(parseDatabaseExplorer('x-compose-panel:\n  database:\n    query:\n      a: "x\\u0007y"\n').ok).toBe(false);
    });

    test("refuses more than 16 parameters", () => {
        const lines = Array.from({ length: 17 }, (_, index) => `      k${index}: v${index}`).join("\n");
        expect(parseDatabaseExplorer(`x-compose-panel:\n  database:\n    query:\n${lines}\n`).ok).toBe(false);
    });

    test("refuses invalid YAML", () => {
        expect(parseDatabaseExplorer("services: [\n").ok).toBe(false);
    });
});

describe("normalizeDatabaseExplorerUrl", () => {
    test("returns null for an empty value", () => {
        expect(normalizeDatabaseExplorerUrl("", false)).toBeNull();
        expect(normalizeDatabaseExplorerUrl("   ", false)).toBeNull();
    });

    test("normalizes an https origin", () => {
        expect(normalizeDatabaseExplorerUrl("https://db.example.com", false)).toBe("https://db.example.com");
        expect(normalizeDatabaseExplorerUrl("https://db.example.com/", false)).toBe("https://db.example.com");
        expect(normalizeDatabaseExplorerUrl("https://db.example.com:8443", false)).toBe("https://db.example.com:8443");
    });

    test("refuses plain http outside development", () => {
        expect(() => normalizeDatabaseExplorerUrl("http://db.example.com", false)).toThrow(/https/i);
        expect(normalizeDatabaseExplorerUrl("http://db.example.com", true)).toBe("http://db.example.com");
    });

    test("refuses credentials, a path, a query or a fragment", () => {
        expect(() => normalizeDatabaseExplorerUrl("https://user:pass@db.example.com", false)).toThrow();
        expect(() => normalizeDatabaseExplorerUrl("https://db.example.com/app", false)).toThrow();
        expect(() => normalizeDatabaseExplorerUrl("https://db.example.com/?x=1", false)).toThrow();
        expect(() => normalizeDatabaseExplorerUrl("https://db.example.com/#frag", false)).toThrow();
    });

    test("refuses a non-http(s) or malformed URL", () => {
        expect(() => normalizeDatabaseExplorerUrl("ftp://db.example.com", false)).toThrow();
        expect(() => normalizeDatabaseExplorerUrl("not a url", false)).toThrow();
    });
});

describe("buildExplorerUrl", () => {
    test("builds the LibreDB deep link", () => {
        expect(buildExplorerUrl("https://db.example.com", { connection: "seed:shop-staging" })).toBe(
            "https://db.example.com/?connection=seed%3Ashop-staging",
        );
    });

    test("builds a multi-parameter Adminer link", () => {
        const url = buildExplorerUrl("https://db.example.com", { pgsql: "shop-db", db: "shop", username: "libredb_ro" });
        expect(url).toContain("pgsql=shop-db");
        expect(url).toContain("db=shop");
        expect(url).toContain("username=libredb_ro");
    });

    test("returns the bare base URL for an empty query", () => {
        expect(buildExplorerUrl("https://db.example.com", {})).toBe("https://db.example.com/");
    });
});

describe("isExplorerHref", () => {
    test("accepts an http(s) link without credentials", () => {
        expect(isExplorerHref("https://db.example.com/?db=shop")).toBe(true);
        expect(isExplorerHref("http://db.example.com/")).toBe(true);
    });

    test("accepts a long link built from bounded parameters", () => {
        const url = buildExplorerUrl("https://db.example.com", { a: "x".repeat(256), b: "y".repeat(256) });
        expect(url.length).toBeGreaterThan(512);
        expect(isExplorerHref(url)).toBe(true);
    });

    test("refuses a non-http scheme, credentials or an over-long value", () => {
        expect(isExplorerHref("javascript:alert(1)")).toBe(false);
        expect(isExplorerHref("https://user:pass@db.example.com/")).toBe(false);
        expect(isExplorerHref(`https://db.example.com/?a=${"x".repeat(20 * 1024)}`)).toBe(false);
        expect(isExplorerHref("not a url")).toBe(false);
    });
});
