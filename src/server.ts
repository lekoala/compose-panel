import { createApp } from "./app.ts";
import { createComposeProvider } from "./compose-provider.ts";
import { loadConfig } from "./config.ts";
import { createDockerRunner } from "./docker.ts";
import { resolveRoot } from "./stacks.ts";

const config = loadConfig();
const stacksRoot = await resolveRoot(config.stacksDir);
const runner = createDockerRunner({
    dockerPath: config.dockerPath,
    timeoutMs: config.dockerTimeoutMs,
    maxBytes: config.dockerMaxBytes,
});
const provider = createComposeProvider({ runner, engine: config.composeEngine, dockerPath: config.dockerPath });
const capabilities = await provider.detect();
if (!capabilities.available) {
    console.warn(`Compose provider "${capabilities.engine}" did not answer; stack status will be reported as unknown.`);
}
const app = createApp({ config, stacksRoot, provider });

// IMPORTANT: hardcoded loopback bind, never configurable (ADR 0010). Remote
// access goes through an SSH tunnel or a TLS reverse proxy on the same host
// (COMPOSE_PANEL_PUBLIC_ORIGIN), never through a published port.
const server = Bun.serve({
    hostname: "127.0.0.1",
    port: config.port,
    fetch: request => app.fetch(request),
});

if (config.publicOrigin) {
    console.info(`Reverse proxy mode: public origin ${config.publicOrigin}, Secure cookies ${config.cookieSecure ? "on" : "OFF"}, client address from the last X-Forwarded-For entry.`);
    if (!config.cookieSecure) console.warn("Plain-HTTP public origin (development mode only): the password and session cookie travel in clear.");
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
