import { describe, expect, test } from "bun:test";
import {
    buildSiteFile,
    isLoopbackHostBinding,
    isValidDomain,
    isValidServiceName,
    isValidStackName,
    isValidUpstreamPort,
    normalizeDomain,
    parseSiteFile,
    siteFilename,
} from "../src/caddy.ts";

describe("isValidDomain", () => {
    test("accepts ordinary public domains", () => {
        expect(isValidDomain("app.example.com")).toBe(true);
        expect(isValidDomain("shop.example.com")).toBe(true);
        expect(isValidDomain("a-b.example-domain.com")).toBe(true);
    });

    test("normalizes case and surrounding whitespace", () => {
        expect(normalizeDomain("  App.Example.COM  ")).toBe("app.example.com");
        expect(isValidDomain("App.Example.COM")).toBe(true);
    });

    test("refuses wildcards, single labels, ports, paths and IP literals", () => {
        expect(isValidDomain("*.example.com")).toBe(false);
        expect(isValidDomain("localhost")).toBe(false);
        expect(isValidDomain("app.example.com:8080")).toBe(false);
        expect(isValidDomain("app.example.com/path")).toBe(false);
        expect(isValidDomain("192.0.2.1")).toBe(false);
        expect(isValidDomain("app.example.com.")).toBe(false);
        expect(isValidDomain("app..example.com")).toBe(false);
        expect(isValidDomain("-app.example.com")).toBe(false);
        expect(isValidDomain(`app.${"a".repeat(64)}.com`)).toBe(false);
        expect(isValidDomain("")).toBe(false);
    });
});

describe("service, stack and port validation", () => {
    test("accepts usual names and ports", () => {
        expect(isValidServiceName("web")).toBe(true);
        expect(isValidServiceName("api_v2.1")).toBe(true);
        expect(isValidStackName("web")).toBe(true);
        expect(isValidUpstreamPort(8080)).toBe(true);
        expect(isValidUpstreamPort(1)).toBe(true);
        expect(isValidUpstreamPort(65535)).toBe(true);
    });

    test("refuses option-like service names and out-of-range ports", () => {
        expect(isValidServiceName("-web")).toBe(false);
        expect(isValidServiceName("")).toBe(false);
        expect(isValidStackName("Web")).toBe(false);
        expect(isValidUpstreamPort(0)).toBe(false);
        expect(isValidUpstreamPort(65536)).toBe(false);
        expect(isValidUpstreamPort(Number.NaN)).toBe(false);
    });

    test("only loopback bindings are eligible", () => {
        expect(isLoopbackHostBinding("127.0.0.1")).toBe(true);
        expect(isLoopbackHostBinding("::1")).toBe(true);
        expect(isLoopbackHostBinding("0.0.0.0")).toBe(false);
        expect(isLoopbackHostBinding("192.0.2.10")).toBe(false);
        expect(isLoopbackHostBinding("")).toBe(false);
    });

    test("derives the file name from a valid domain only", () => {
        expect(siteFilename("app.example.com")).toBe("app.example.com.caddy");
        expect(siteFilename("*.example.com")).toBeNull();
    });
});

describe("buildSiteFile and parseSiteFile", () => {
    test("round-trips a canonical file", () => {
        const file = buildSiteFile({ domain: "app.example.com", stack: "web", service: "web", port: 8080 });
        expect(file.endsWith("\n")).toBe(true);
        const parsed = parseSiteFile(file);
        expect(parsed).toEqual({ ok: true, value: { domain: "app.example.com", stack: "web", service: "web", port: 8080 } });
    });

    test("build output is deterministic for the same request", () => {
        const request = { domain: "App.Example.COM", stack: "web", service: "web", port: 8080 };
        expect(buildSiteFile(request)).toBe(buildSiteFile(request));
    });

    test("refuses a foreign file without the ownership header", () => {
        const foreign = "app.example.com {\n\treverse_proxy 127.0.0.1:8080\n}\n";
        const parsed = parseSiteFile(foreign);
        expect(parsed.ok).toBe(false);
    });

    test("refuses an externally modified managed file instead of adopting it", () => {
        const file = buildSiteFile({ domain: "app.example.com", stack: "web", service: "web", port: 8080 });
        const withExtra = file.replace("}\n", "\tbasic_auth admin secret\n}\n");
        expect(parseSiteFile(withExtra).ok).toBe(false);
        const swapped = file.replace("127.0.0.1:8080", "0.0.0.0:8080");
        expect(parseSiteFile(swapped).ok).toBe(false);
        const truncated = file.split("\n").slice(0, 5).join("\n");
        expect(parseSiteFile(truncated).ok).toBe(false);
    });

    test("throws on invalid build input", () => {
        expect(() => buildSiteFile({ domain: "*.example.com", stack: "web", service: "web", port: 8080 })).toThrow();
        expect(() => buildSiteFile({ domain: "app.example.com", stack: "Web", service: "web", port: 8080 })).toThrow();
        expect(() => buildSiteFile({ domain: "app.example.com", stack: "web", service: "web", port: 0 })).toThrow();
    });
});
