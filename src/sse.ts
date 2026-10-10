/** Minimal Server-Sent Events encoder. No dependencies, no buffering. */

/** Encode one SSE frame. Multi-line data is split into one `data:` line each. */
export function formatSseEvent(event: string, data: string, id?: number): string {
    let frame = "";
    if (event) frame += `event: ${event}\n`;
    if (id !== undefined) frame += `id: ${id}\n`;
    if (data === "") {
        frame += "data:\n";
    } else {
        for (const line of data.split("\n")) frame += `data: ${line}\n`;
    }
    return `${frame}\n`;
}

/** Keep-alive comment. EventSource ignores it; proxies may not close an idle stream. */
export function formatSseHeartbeat(): string {
    return ": ping\n\n";
}

export function sseHeaders(): Record<string, string> {
    return {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "same-origin",
        "X-Frame-Options": "DENY",
        // Tell buffering proxies not to hold back frames.
        "X-Accel-Buffering": "no",
    };
}
