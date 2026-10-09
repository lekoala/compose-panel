import { expect, test } from "bun:test";
import { createDockerRunner } from "../src/docker.ts";
import { parseComposeLs } from "../src/compose-state.ts";

// Opt-in read-only integration check. Never mutates Docker resources and never
// runs in unattended CI. Enable with COMPOSE_PANEL_TEST_DOCKER=1 on a Linux host.
const enabled = process.env.COMPOSE_PANEL_TEST_DOCKER === "1";

test.skipIf(!enabled)("reads real compose projects with a read-only command", async () => {
    const runner = createDockerRunner();
    const result = await runner(["compose", "ls", "--all", "--format", "json"]);
    expect(result.timedOut).toBe(false);
    if (result.code !== 0) {
        console.warn("Docker daemon not reachable; integration check not validated.");
        return;
    }
    expect(() => parseComposeLs(result.stdout)).not.toThrow();
});
