import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createComposeProvider } from "../src/compose-provider.ts";
import { StackError } from "../src/stacks.ts";
import { loadStackStates } from "../src/status.ts";

describe("loadStackStates without a stacks directory", () => {
    test("fails closed with 503 and never calls Docker", async () => {
        const gone = await mkdtemp(join(tmpdir(), "compose-panel-gone-"));
        await rm(gone, { recursive: true, force: true });
        let dockerCalls = 0;
        const provider = createComposeProvider({
            runner: async () => { dockerCalls += 1; return { code: 0, stdout: "[]", stderr: "", timedOut: false, truncated: false }; },
        });
        const error = await loadStackStates(gone, provider).then(
            () => null,
            (failure: unknown) => failure,
        );
        expect(error).toBeInstanceOf(StackError);
        expect((error as StackError).status).toBe(503);
        expect(dockerCalls).toBe(0);
    });
});
