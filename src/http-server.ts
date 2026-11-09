/** The production listener also owns the fallback for errors outside routing. */
export function startHttpServer(port: number, fetch: (request: Request) => Response | Promise<Response>) {
    return Bun.serve({
        // Hard-coded loopback, including development and preview (ADR 0012).
        hostname: "127.0.0.1",
        port,
        development: false,
        // Diagnostics can spend 5 s each on project/container discovery, then
        // 10 s on info/stats and another 10 s on an on-demand disk read. Bun's
        // default 10 s idle deadline can reset the socket before we can return
        // either the result or the bounded Docker timeout warning.
        idleTimeout: 60,
        fetch,
        error() {
            // The thrown value may contain configuration or credentials.
            console.error("An unhandled request error reached the HTTP server.");
            return new Response("Internal error.", {
                status: 500,
                headers: {
                    "Content-Type": "text/plain; charset=utf-8",
                    "Cache-Control": "no-store",
                    "X-Content-Type-Options": "nosniff",
                    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
                },
            });
        },
    });
}
