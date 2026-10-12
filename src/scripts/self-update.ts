// Entry point of the one-shot updater container (ADR 0018). Started by the
// panel with fixed, validated arguments; never run inside the panel itself.
import { createComposeProvider } from "../compose-provider.ts";
import { createDockerRunner } from "../docker.ts";
import { UPDATER_EXIT } from "../self-update.ts";
import { UpdaterArgsError, parseUpdaterArgs, runSelfUpdate } from "../self-update-run.ts";

let args: ReturnType<typeof parseUpdaterArgs>;
try {
    args = parseUpdaterArgs(Bun.argv.slice(2));
} catch (error) {
    console.error(`Refused: ${error instanceof UpdaterArgsError ? error.message : "invalid arguments."} Nothing was changed.`);
    process.exit(UPDATER_EXIT.refused);
}

const runner = createDockerRunner({ timeoutMs: 30_000, maxBytes: 1024 * 1024 });
const provider = createComposeProvider({ runner });
const stamp = () => new Date().toISOString().slice(0, 19).replace("T", " ");
let code: number;
try {
    code = await runSelfUpdate(args, {
        runner,
        provider,
        log: line => console.log(`${stamp()} ${line}`),
        write: chunk => process.stdout.write(chunk),
        fileExists: path => Bun.file(path).exists(),
        sleep: ms => Bun.sleep(ms),
        now: () => Date.now(),
    });
} catch (error) {
    console.error(`${stamp()} Failed: ${error instanceof Error ? error.message : "unexpected error"}`);
    code = UPDATER_EXIT.failed;
}
process.exit(code);
