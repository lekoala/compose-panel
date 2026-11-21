/**
 * The fixed managed-site revision probe (ADR 0043): one bounded GET against the
 * gateway's actual 127.0.0.1 binding, fixed path, no redirects, no DNS lookup,
 * no TLS. Reading the answer is the caller's job; this module only refuses to
 * buffer more than a probe-sized body.
 */
import { MANAGED_SITE_PROBE_PATH, type ManagedSiteProbe, type ProbeAnswer } from "./managed-site-deploy.ts";

export const MANAGED_SITE_PROBE_BODY_MAX = 512;
export const MANAGED_SITE_PROBE_TIMEOUT_MS = 2000;

export interface ManagedSiteProbeOptions {
    timeoutMs?: number;
    /** Injectable for tests; production uses the platform fetch. */
    fetchImpl?: typeof fetch;
}

export function createManagedSiteProbe(options: ManagedSiteProbeOptions = {}): ManagedSiteProbe {
    const timeoutMs = options.timeoutMs ?? MANAGED_SITE_PROBE_TIMEOUT_MS;
    const fetchImpl = options.fetchImpl ?? fetch;
    return async (port: number): Promise<ProbeAnswer | null> => {
        // The port comes from a validated loopback binding; anything else is a
        // programming error, never a request value.
        if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetchImpl(`http://127.0.0.1:${port}${MANAGED_SITE_PROBE_PATH}`, {
                method: "GET",
                redirect: "error",
                signal: controller.signal,
                headers: { Accept: "text/plain" },
            });
            const body = await readBounded(response, MANAGED_SITE_PROBE_BODY_MAX);
            return body === null ? null : { status: response.status, body };
        } catch {
            return null;
        } finally {
            clearTimeout(timer);
        }
    };
}

async function readBounded(response: Response, maxBytes: number): Promise<string | null> {
    const declared = response.headers.get("content-length");
    if (declared !== null && Number(declared) > maxBytes) return null;
    const reader = response.body?.getReader();
    if (!reader) return "";
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value || value.byteLength === 0) continue;
            total += value.byteLength;
            if (total > maxBytes) {
                await reader.cancel().catch(() => {});
                return null;
            }
            chunks.push(value);
        }
    } finally {
        try {
            reader.releaseLock();
        } catch {
            /* already released */
        }
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
}
