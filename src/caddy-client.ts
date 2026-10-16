/**
 * Panel-side client for the privileged Caddy helper (ADR 0030).
 *
 * The helper listens on a Unix socket mounted into the panel container. Every
 * call sends one bounded JSON line and reads one bounded JSON answer with an
 * explicit timeout. Transport problems (missing socket, timeout, oversized or
 * malformed answer) throw `CaddyHelperError` and the panel answers 503: an
 * unknown outcome is never reported as success. Helper refusals come back as
 * data (`{ok:false}`) so the panel can map them to 400/409/500 honestly.
 */

import type { HelperRequest, HelperResponse } from "./caddy-helper.ts";

export class CaddyHelperError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "CaddyHelperError";
    }
}

export interface CaddyCallOptions {
    timeoutMs: number;
    /** Upper bound for one request line. */
    maxRequestBytes?: number;
    /** Upper bound for one answer line. */
    maxResponseBytes?: number;
}

const DEFAULT_MAX_REQUEST_BYTES = 8 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

const CODES = new Set(["invalid", "conflict", "unavailable", "failed", "unknown"]);

/**
 * Defensive shape check on the helper answer. The helper is trusted code, but
 * the socket is a boundary: a malformed answer is a transport failure, never
 * an object the panel acts on.
 */
export function parseHelperResponse(raw: unknown, action: string): HelperResponse {
    if (!isRecord(raw) || typeof raw.ok !== "boolean") throw new CaddyHelperError("The Caddy helper gave an unexpected answer.");
    if (raw.ok) {
        if (raw.action !== action) throw new CaddyHelperError("The Caddy helper gave an unexpected answer.");
        return raw as HelperResponse;
    }
    if (typeof raw.error !== "string" || !CODES.has(raw.code as string)) {
        throw new CaddyHelperError("The Caddy helper gave an unexpected answer.");
    }
    return raw as HelperResponse;
}

export async function callCaddyHelper(
    socketPath: string,
    request: HelperRequest,
    options: CaddyCallOptions,
): Promise<HelperResponse> {
    if (!socketPath.startsWith("/")) throw new CaddyHelperError("The Caddy helper socket is not configured.");
    const maxRequest = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
    const maxResponse = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    const payload = `${JSON.stringify(request)}\n`;
    if (Buffer.byteLength(payload, "utf8") > maxRequest) throw new CaddyHelperError("The Caddy helper request is too large.");
    return new Promise<HelperResponse>((resolve, reject) => {
        let settled = false;
        const fail = (error: Error): void => {
            if (settled) return;
            settled = true;
            try { socket.end(); } catch { /* already gone */ }
            reject(error);
        };
        const timer = setTimeout(() => fail(new CaddyHelperError("The Caddy helper did not answer in time.")), options.timeoutMs);
        let socket: { write: (data: string) => void; end: () => void };
        const chunks: Buffer[] = [];
        let total = 0;
        const onLine = (line: string): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { socket.end(); } catch { /* already gone */ }
            let parsed: unknown;
            try {
                parsed = JSON.parse(line);
            } catch {
                reject(new CaddyHelperError("The Caddy helper gave an unexpected answer."));
                return;
            }
            try {
                resolve(parseHelperResponse(parsed, request.action));
            } catch (error) {
                reject(error instanceof Error ? error : new CaddyHelperError("The Caddy helper gave an unexpected answer."));
            }
        };
        const feed = (data: Uint8Array): void => {
            if (settled) return;
            if (total + data.byteLength > maxResponse) {
                fail(new CaddyHelperError("The Caddy helper answer is too large."));
                return;
            }
            const copy = Buffer.from(data);
            chunks.push(copy);
            total += copy.byteLength;
            const text = Buffer.concat(chunks).toString("utf8");
            const index = text.indexOf("\n");
            if (index >= 0) onLine(text.slice(0, index));
        };
        Bun.connect({
            unix: socketPath,
            socket: {
                open(nextSocket) {
                    socket = nextSocket;
                    try {
                        socket.write(payload);
                    } catch {
                        fail(new CaddyHelperError("The Caddy helper socket is not reachable."));
                    }
                },
                data(_socket, data) { feed(data); },
                close() { fail(new CaddyHelperError("The Caddy helper closed the connection.")); },
                error(_socket, _error) { fail(new CaddyHelperError("The Caddy helper socket is not reachable.")); },
            },
        }).catch(() => fail(new CaddyHelperError("The Caddy helper socket is not reachable.")));
    });
}
