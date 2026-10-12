import { bootstrap } from "./bootstrap.ts";
import { loadConfig } from "./config.ts";

const config = loadConfig();
const { app, capabilities } = await bootstrap(config);
if (!capabilities.available) {
    console.warn(`Compose provider "${capabilities.engine}" did not answer; stack status will be reported as unknown.`);
}

// IMPORTANT: hardcoded loopback bind, never configurable (ADR 0010 / 0012).
// Remote access goes through an SSH tunnel or a TLS reverse proxy on the same
// host (COMPOSE_PANEL_PROXY_ORIGINS), never through a published port.
const server = Bun.serve({
    hostname: "127.0.0.1",
    port: config.port,
    fetch: request => app.fetch(request),
});

const loopbackEnabled = config.proxyOrigins.length === 0 || config.allowLoopback;
if (config.proxyOrigins.length > 0) {
    console.info(`Reverse proxy mode: origins ${config.proxyOrigins.join(", ")}; loopback access ${loopbackEnabled ? "enabled" : "disabled"}; X-Forwarded-* trusted only on a proxy origin.`);
}
if (config.proxyOrigins.some(origin => origin.startsWith("http:"))) {
    console.warn("An http proxy origin (development mode only): the password and session cookie travel in clear.");
}
if (config.cookieSecure && loopbackEnabled) {
    console.warn("COMPOSE_PANEL_COOKIE_SECURE=true marks cookies Secure on the plain-HTTP loopback listener; sign-in through an SSH tunnel can fail in some browsers.");
}
if (process.env.COMPOSE_PANEL_LOGIN_BLOCK_MS) {
    console.warn("COMPOSE_PANEL_LOGIN_BLOCK_MS is ignored: failed sign-ins are now delayed, never locked out (ADR 0009). Use COMPOSE_PANEL_LOGIN_BACKOFF_MAX_MS.");
}
if (config.devMode) {
    console.warn("COMPOSE_PANEL_DEV=true: development mode. Weak usernames are allowed; never use this in production.");
}
if (config.allowOpaqueOrigin) {
    console.warn("COMPOSE_PANEL_ALLOW_OPAQUE_ORIGIN=true: an absent/opaque Origin is accepted for same-origin requests. Local testing only.");
}
console.info(`Compose Panel listening on http://127.0.0.1:${server.port} (loopback only; single admin: ${config.adminUser})`);

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, async () => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.info(`${signal} received; refusing new operations and draining up to ${config.shutdownGraceMs} ms.`);
        await app.beginShutdown(config.shutdownGraceMs);
        server.stop(true);
        process.exit(0);
    });
}
