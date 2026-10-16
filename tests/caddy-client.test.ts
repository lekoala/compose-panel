import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaddyHelperError, callCaddyHelper, parseHelperResponse } from "../src/caddy-client.ts";

describe("parseHelperResponse", () => {
    test("accepts a matching success answer", () => {
        const parsed = parseHelperResponse({ ok: true, action: "status", sites: [], unparseable: [], importConfigured: true }, "status");
        expect(parsed).toMatchObject({ ok: true, action: "status", importConfigured: true });
    });

    test("passes refusals through as data", () => {
        expect(parseHelperResponse({ ok: false, error: "No.", code: "conflict" }, "attach"))
            .toEqual({ ok: false, error: "No.", code: "conflict" });
    });

    test("rebuilds a status answer from validated sites only", () => {
        const site = { domain: "app.example.com", stack: "web", service: "web", port: 8080 };
        const parsed = parseHelperResponse({ ok: true, action: "status", sites: [{ ...site, extra: "dropped" }], unparseable: ["x.caddy"], importConfigured: false }, "status");
        expect(parsed).toEqual({ ok: true, action: "status", sites: [site], unparseable: ["x.caddy"], importConfigured: false });
    });

    test("rejects a status answer with malformed sites", () => {
        const base = { ok: true, action: "status", unparseable: [], importConfigured: true };
        const site = { domain: "app.example.com", stack: "web", service: "web", port: 8080 };
        for (const sites of [
            null,
            [null],
            [{ ...site, port: "8080<script>" }],
            [{ ...site, port: 0 }],
            [{ ...site, domain: "<b>x</b>.example.com" }],
            [{ ...site, domain: "APP.example.com" }],
            [{ ...site, stack: "../etc" }],
            [{ ...site, service: "-rm" }],
        ]) {
            expect(() => parseHelperResponse({ ...base, sites }, "status")).toThrow(CaddyHelperError);
        }
        expect(() => parseHelperResponse({ ...base, sites: [], unparseable: [42] }, "status")).toThrow(CaddyHelperError);
        expect(() => parseHelperResponse({ ...base, sites: [], importConfigured: "yes" }, "status")).toThrow(CaddyHelperError);
    });

    test("rejects a mismatched action, a bad code and non-objects", () => {
        expect(() => parseHelperResponse({ ok: true, action: "status", sites: [] }, "attach")).toThrow(CaddyHelperError);
        expect(() => parseHelperResponse({ ok: false, error: "No.", code: "nope" }, "attach")).toThrow(CaddyHelperError);
        expect(() => parseHelperResponse({ ok: false, error: 42, code: "failed" }, "attach")).toThrow(CaddyHelperError);
        expect(() => parseHelperResponse(null, "status")).toThrow(CaddyHelperError);
        expect(() => parseHelperResponse("ok", "status")).toThrow(CaddyHelperError);
    });
});

// Unix-socket round trips against an in-process fake helper. Linux only: the
// panel only ever dials the socket on its Linux deployment.
describe.skipIf(process.platform !== "linux")("callCaddyHelper", () => {
    let counter = 0;

    interface Server {
        socketPath: string;
        close: () => void;
    }

    async function serve(answer: string, options: { silent?: boolean; chunked?: boolean } = {}): Promise<Server> {
        const socketPath = join(await mkdtemp(join(tmpdir(), "compose-panel-caddy-client-")), `helper-${process.pid}-${counter++}.sock`);
        await rm(socketPath, { force: true });
        const pending = new Map<object, number[]>();
        const server = Bun.listen({
            unix: socketPath,
            socket: {
                open(socket) { pending.set(socket, []); },
                data(socket, data) {
                    const seen = pending.get(socket) ?? [];
                    for (const byte of data) seen.push(byte);
                    pending.set(socket, seen);
                    const text = Buffer.from(seen).toString("utf8");
                    if (!text.includes("\n") || options.silent) return;
                    pending.delete(socket);
                    try {
                        if (options.chunked) {
                            for (const part of answer.match(/.{1,7}/gs) ?? []) socket.write(part);
                        } else {
                            socket.write(answer);
                        }
                    } catch { /* the client may have gone */ }
                    try { socket.end(); } catch { /* already gone */ }
                },
                close(socket) { pending.delete(socket); },
                error(socket) { try { socket.end(); } catch { /* already gone */ } pending.delete(socket); },
            },
        });
        return { socketPath, close: () => server.stop() };
    }

    test("round-trips a request and a chunked answer", async () => {
        const server = await serve(`${JSON.stringify({ ok: true, action: "status", sites: [], unparseable: [], importConfigured: true })}\n`, { chunked: true });
        try {
            const response = await callCaddyHelper(server.socketPath, { action: "status" }, { timeoutMs: 5000 });
            expect(response).toEqual({ ok: true, action: "status", sites: [], unparseable: [], importConfigured: true });
        } finally {
            server.close();
        }
    });

    test("times out on a silent helper", async () => {
        const server = await serve("", { silent: true });
        try {
            await expect(callCaddyHelper(server.socketPath, { action: "status" }, { timeoutMs: 200 })).rejects.toThrow(CaddyHelperError);
        } finally {
            server.close();
        }
    });

    test("refuses a missing socket, malformed JSON and oversized answers", async () => {
        await expect(callCaddyHelper("/nonexistent-dir/helper.sock", { action: "status" }, { timeoutMs: 1000 }))
            .rejects.toThrow(CaddyHelperError);
        const broken = await serve("not json\n");
        try {
            await expect(callCaddyHelper(broken.socketPath, { action: "status" }, { timeoutMs: 2000 })).rejects.toThrow(CaddyHelperError);
        } finally {
            broken.close();
        }
        const big = await serve(`${JSON.stringify({ ok: true, action: "status", sites: [], pad: "x".repeat(3000) })}\n`);
        try {
            await expect(callCaddyHelper(big.socketPath, { action: "status" }, { timeoutMs: 2000, maxResponseBytes: 64 }))
                .rejects.toThrow(CaddyHelperError);
        } finally {
            big.close();
        }
    });
});
