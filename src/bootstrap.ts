import { createApp, type App } from "./app.ts";
import { createComposeProvider, type ComposeCapabilities } from "./compose-provider.ts";
import type { AppConfig } from "./config.ts";
import { createDockerRunner, type DockerRunner } from "./docker.ts";
import { resolveRoot } from "./stacks.ts";

/**
 * Production wiring of the panel, shared by `src/server.ts` and its tests.
 * Every Docker boundary (Compose provider, container inspector, self-update,
 * application action runner) gets the same real runner: `createApp` falls back
 * to an unavailable runner for anything not given, which once made Docker look
 * unreachable outside Compose calls.
 */
export async function bootstrap(
    config: AppConfig,
    options: { createRunner?: (settings: { dockerPath: string; timeoutMs: number; maxBytes: number }) => DockerRunner } = {},
): Promise<{ app: App; stacksRoot: string; capabilities: ComposeCapabilities }> {
    const stacksRoot = await resolveRoot(config.stacksDir);
    const runner = (options.createRunner ?? createDockerRunner)({
        dockerPath: config.dockerPath,
        timeoutMs: config.dockerTimeoutMs,
        maxBytes: config.dockerMaxBytes,
    });
    const provider = createComposeProvider({ runner, engine: config.composeEngine, dockerPath: config.dockerPath });
    const capabilities = await provider.detect();
    const app = createApp({ config, stacksRoot, provider, runner });
    return { app, stacksRoot, capabilities };
}
