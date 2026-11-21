import { readFileSync, writeFileSync } from "node:fs";
import { deployWithE2E, type ManagedSiteE2EConfig, type ManagedSiteE2EHooks } from "./helpers/managed-site-e2e.ts";

/**
 * One managed-site deploy in its own process, so the end-to-end suite can kill
 * it with SIGKILL at a chosen point and observe the durable state it left.
 *
 * Usage: bun tests/managed-site-e2e-child.ts <config.json>
 * The JSON carries a ManagedSiteE2EConfig plus `crash` ("after-stop",
 * "after-switch" or "none") and `flag`, the file written once the crash point
 * is reached. The parent polls that file, then kills this process.
 */
interface ChildConfig extends ManagedSiteE2EConfig {
    crash: "after-stop" | "after-switch" | "none";
    flag: string;
}

function blockAt(flag: string): () => Promise<void> {
    return async () => {
        writeFileSync(flag, "reached\n");
        // A pending promise alone does not keep Bun alive.
        setInterval(() => {}, 1000);
        await new Promise(() => {});
    };
}

const config = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as ChildConfig;
const hooks: ManagedSiteE2EHooks = {};
if (config.crash === "after-stop") hooks.afterStop = blockAt(config.flag);
if (config.crash === "after-switch") hooks.afterSwitch = blockAt(config.flag);

const result = await deployWithE2E(config, hooks);
process.stdout.write(`${JSON.stringify(result)}\n`);
