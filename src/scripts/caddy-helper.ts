// Entry point of the privileged Caddy helper (ADR 0030). Installed on the
// host (not in the panel container) and activated on demand through a systemd
// socket: standard input is the connection, standard output carries the
// single-line JSON answer. It can also run attached to pipes for tests.
//
// Protocol: one JSON object per line, request and answer each bounded. Exit 0
// with `{ok:false}` for refusals (operational outcome), non-zero for crashes
// (the panel then reports an unknown outcome, never success).
import { writeSync } from "node:fs";
import { createCaddyRunner, helperDeadlineMs, parseHelperEnv, runHelperRequest } from "../caddy-helper.ts";

/** Upper bound for one request line: attach/detach carry four short fields. */
const MAX_REQUEST_BYTES = 8 * 1024;

function fail(message: string, code: number): never {
    try {
        writeSync(1, `${JSON.stringify({ ok: false, error: message, code: "unknown" })}\n`);
    } catch {
        /* the panel already treats a missing answer as unknown */
    }
    process.exit(code);
}

let env: ReturnType<typeof parseHelperEnv>;
try {
    env = parseHelperEnv(process.env);
} catch (error) {
    console.error(`Refused: ${error instanceof Error ? error.message : "invalid helper configuration."} Nothing was changed.`);
    process.exit(4);
}

// Overall deadline for one request, including every Caddy subprocess and the
// rollback reload (derived from the per-command timeout, see helperDeadlineMs).
setTimeout(
    () => fail("The helper did not answer in time. Check Caddy on the host: the outcome is unknown.", 3),
    helperDeadlineMs(env!),
).unref?.();

async function readLine(capped: number): Promise<string | null> {
    const stream = Bun.stdin.stream();
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value || value.byteLength === 0) continue;
            const room = capped - total;
            if (room <= 0) return null;
            const slice = value.byteLength <= room ? value : value.subarray(0, room);
            chunks.push(slice);
            total += slice.byteLength;
            const text = Buffer.concat(chunks).toString("utf8");
            const index = text.indexOf("\n");
            if (index >= 0) return text.slice(0, index);
            if (total >= capped) return null;
        }
    } finally {
        reader.releaseLock();
    }
    const text = Buffer.concat(chunks).toString("utf8");
    return text ? text : null;
}

const line = await readLine(MAX_REQUEST_BYTES);
if (line === null) fail("The helper request was empty or too large. Nothing was changed.", 2);
let request: unknown;
try {
    request = JSON.parse(line!);
} catch {
    fail("The helper request was not valid JSON. Nothing was changed.", 2);
}
try {
    const response = await runHelperRequest(request, env!, { runCaddy: createCaddyRunner(env!) });
    writeSync(1, `${JSON.stringify(response)}\n`);
    process.exit(0);
} catch (error) {
    console.error(`Failed: ${error instanceof Error ? error.message : "unexpected error"}`);
    fail("The helper failed unexpectedly. Check Caddy on the host: the outcome is unknown.", 1);
}
