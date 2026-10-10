import { expect, test } from "bun:test";
import { formatSseEvent, formatSseHeartbeat, sseHeaders } from "../src/sse.ts";

test("encodes a single event frame", () => {
    expect(formatSseEvent("snapshot", '{"status":"running"}')).toBe('event: snapshot\ndata: {"status":"running"}\n\n');
});

test("splits multi-line data into one data line each", () => {
    expect(formatSseEvent("output", "a\nb")).toBe("event: output\ndata: a\ndata: b\n\n");
});

test("supports empty data and explicit ids", () => {
    expect(formatSseEvent("end", "", 7)).toBe("event: end\nid: 7\ndata:\n\n");
});

test("heartbeat is a comment frame clients ignore", () => {
    expect(formatSseHeartbeat()).toBe(": ping\n\n");
});

test("headers declare an unbuffered, non-cached event stream", () => {
    const headers = sseHeaders();
    expect(headers["Content-Type"]).toBe("text/event-stream; charset=utf-8");
    expect(headers["Cache-Control"]).toBe("no-store");
    expect(headers["X-Accel-Buffering"]).toBe("no");
});
