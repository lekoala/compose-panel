/** The production listener also owns the fallback for errors outside routing. */
export function startHttpServer(port: number, fetch: (request: Request) => Response | Promise<Response>) {
    return Bun.serve({
        // Hard-coded loopback, including development and preview (ADR 0012).
        hostname: "127.0.0.1",
        port,
        development: false,
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
