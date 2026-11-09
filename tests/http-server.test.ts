import { expect, test, spyOn } from "bun:test";
import { startHttpServer } from "../src/http-server.ts";

test("a slow diagnostics response survives Bun's default socket idle deadline", async () => {
    const server = startHttpServer(0, async () => {
        // A disk read is allowed ten seconds, after the other diagnostics have
        // already run. Exercise a real socket rather than calling app.fetch.
        await Bun.sleep(22_000);
        return new Response("diagnostics fixture", { headers: { "Cache-Control": "no-store" } });
    });
    try {
        const response = await fetch(`http://127.0.0.1:${server.port}/server?disk=1`, {
            signal: AbortSignal.timeout(28_000),
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(await response.text()).toBe("diagnostics fixture");
    } finally {
        await server.stop(true);
    }
}, 30_000);

test("uncaught request errors return a private production response", async () => {
    const log = spyOn(console, "error").mockImplementation(() => {});
    const server = startHttpServer(0, async () => {
        throw new Error("fixture-password-/private/source.ts");
    });
    try {
        expect(server.hostname).toBe("127.0.0.1");
        expect(server.development).toBe(false);
        const response = await fetch(`http://127.0.0.1:${server.port}/login`);
        expect(response.status).toBe(500);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("content-type")).toStartWith("text/plain");
        expect(await response.text()).not.toContain("fixture-password");
        expect(JSON.stringify(log.mock.calls)).not.toContain("fixture-password");
    } finally {
        await server.stop(true);
        log.mockRestore();
    }
});
