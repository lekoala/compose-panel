import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { resolveRoot } from "./stacks.ts";

const config = loadConfig();
const stacksRoot = await resolveRoot(config.stacksDir);
const app = createApp({ config, stacksRoot });

// IMPORTANT: hardcoded loopback bind. Do not expose the panel until the proxy,
// TLS and cookie policy (COMPOSE_PANEL_COOKIE_SECURE, PUBLIC_ORIGIN) are reviewed.
const server = Bun.serve({
    hostname: "127.0.0.1",
    port: config.port,
    fetch: request => app.fetch(request),
});

if (!config.cookieSecure) {
    console.warn("Session cookies are not Secure. Keep the panel on 127.0.0.1; set COMPOSE_PANEL_COOKIE_SECURE=true behind TLS.");
}
if (config.publicOrigin && !config.cookieSecure) {
    console.warn("COMPOSE_PANEL_PUBLIC_ORIGIN is set but cookies are not Secure; set COMPOSE_PANEL_COOKIE_SECURE=true behind TLS.");
}
console.info(`Compose Panel on http://127.0.0.1:${server.port} (single admin: ${config.adminUser})`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
        server.stop(true);
        process.exit(0);
    });
}
