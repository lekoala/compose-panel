import { afterEach, describe, expect, test } from "bun:test";
import { createManagedSiteProbe } from "../src/managed-site-probe.ts";
import { MANAGED_SITE_PROBE_PATH } from "../src/managed-site-deploy.ts";

const SHA = "a".repeat(40);
const servers: Array<ReturnType<typeof Bun.serve>> = [];

function serve(handler: (request: Request) => Response | Promise<Response>): number {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
    servers.push(server);
    return server.port!;
}

afterEach(() => {
    for (const server of servers.splice(0)) server.stop(true);
});

describe("createManagedSiteProbe", () => {
    test("reads the fixed probe path on the loopback binding", async () => {
        const seen: { path: string | null } = { path: null };
        const port = serve((request) => {
            seen.path = new URL(request.url).pathname;
            return new Response(`${SHA}\n`, { status: 200, headers: { "Content-Type": "text/plain" } });
        });
        const probe = createManagedSiteProbe();
        expect(await probe(port)).toEqual({ status: 200, body: `${SHA}\n` });
        expect(seen.path).toBe(MANAGED_SITE_PROBE_PATH);
    });

    test("does not follow a redirect", async () => {
        const port = serve(() => new Response(null, { status: 302, headers: { Location: "/elsewhere" } }));
        const probe = createManagedSiteProbe();
        expect(await probe(port)).toBeNull();
    });

    test("refuses an oversized body instead of buffering it", async () => {
        const port = serve(() => new Response("x".repeat(600), { status: 200 }));
        const probe = createManagedSiteProbe();
        expect(await probe(port)).toBeNull();
    });

    test("refuses a body without a declared length once it exceeds the cap", async () => {
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode("x".repeat(400)));
                controller.enqueue(new TextEncoder().encode("x".repeat(400)));
                controller.close();
            },
        });
        const port = serve(() => new Response(stream, { status: 200 }));
        const probe = createManagedSiteProbe();
        expect(await probe(port)).toBeNull();
    });

    test("returns null on a slow answer and on a refused connection", async () => {
        const slow = serve(async () => {
            await Bun.sleep(200);
            return new Response(`${SHA}\n`);
        });
        const probe = createManagedSiteProbe({ timeoutMs: 50 });
        expect(await probe(slow)).toBeNull();

        const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
        const port = closed.port!;
        closed.stop(true);
        expect(await probe(port)).toBeNull();
    });

    test("refuses an invalid port without calling fetch", async () => {
        let called = false;
        const probe = createManagedSiteProbe({
            fetchImpl: (async () => {
                called = true;
                return new Response("");
            }) as unknown as typeof fetch,
        });
        expect(await probe(0)).toBeNull();
        expect(await probe(65536)).toBeNull();
        expect(await probe(1.5)).toBeNull();
        expect(called).toBe(false);
    });
});
