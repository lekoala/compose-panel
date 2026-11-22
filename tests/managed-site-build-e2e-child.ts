import { readFileSync, writeFileSync } from "node:fs";
import { runComposerPreparation } from "../src/managed-site-build.ts";

/**
 * One Composer preparation in its own process, so the end-to-end suite can
 * send SIGTERM while the install container is running and observe that the
 * panel's shutdown path stops it and removes the container.
 *
 * Usage: bun tests/managed-site-build-e2e-child.ts <config.json>
 * The JSON carries the build request plus `result`, the file written with the
 * outcome once the cleanup has completed.
 */
interface ChildConfig {
    stackDir: string;
    attemptId: string;
    tree: string;
    phpMinor: string;
    timeoutMs: number;
    result: string;
}

const config = JSON.parse(readFileSync(process.argv[2] ?? "", "utf8")) as ChildConfig;
const controller = new AbortController();
process.on("SIGTERM", () => controller.abort());
const outcome = await runComposerPreparation({
    stackDir: config.stackDir,
    attemptId: config.attemptId,
    tree: config.tree,
    phpMinor: config.phpMinor,
    timeoutMs: config.timeoutMs,
    signal: controller.signal,
});
writeFileSync(config.result, `${JSON.stringify(outcome)}\n`);
