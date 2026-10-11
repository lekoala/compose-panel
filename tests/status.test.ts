import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createComposeProvider } from "../src/compose-provider.ts";
import { resolveRoot } from "../src/stacks.ts";
import type { ComposeProvider } from "../src/compose-provider.ts";
import type { CommandResult } from "../src/docker.ts";
import { StackError } from "../src/stacks.ts";
import { loadProjects, loadStackStates } from "../src/status.ts";

const ok: CommandResult = { code: 0, stdout: "[]", stderr: "", timedOut: false, truncated: false };

function stubProvider(result: Partial<CommandResult> & { stdout?: string }): ComposeProvider {
    return {
        listProjects: async () => ({ ...ok, ...result }),
    } as unknown as ComposeProvider;
}

describe("loadStackStates without a stacks directory", () => {
    test("fails closed with 503 and never calls Docker", async () => {
        const gone = await mkdtemp(join(tmpdir(), "compose-panel-gone-"));
        await rm(gone, { recursive: true, force: true });
        let dockerCalls = 0;
        const provider = createComposeProvider({
            runner: async () => { dockerCalls += 1; return { code: 0, stdout: "[]", stderr: "", timedOut: false, truncated: false }; },
        });
        const logged: unknown[][] = [];
        const origError = console.error;
        console.error = (...args: unknown[]) => { logged.push(args); };
        try {
            const error = await loadStackStates(gone, provider).then(
                () => null,
                (failure: unknown) => failure,
            );
            expect(error).toBeInstanceOf(StackError);
            expect((error as StackError).status).toBe(503);
        } finally {
            console.error = origError;
        }
        expect(dockerCalls).toBe(0);
        expect(logged).toEqual([]);
    });
});

describe("loadProjects with a truncated Docker list", () => {
    test("a truncated list is never parsed as complete", async () => {
        const discovery = await loadProjects(stubProvider({ stdout: "[]", truncated: true }));
        expect(discovery.projects).toEqual([]);
        expect(discovery.note).toContain("may be incomplete");
    });

    test("a truncated list marks every stack unknown instead of not-created", async () => {
        const root = await resolveRoot(await mkdtemp(join(tmpdir(), "compose-panel-status-")));
        try {
            await mkdir(join(root, "blog"));
            await writeFile(join(root, "blog", "compose.yaml"), "services:\n  web:\n    image: nginx:alpine\n");
            const { stacks, dockerNote } = await loadStackStates(root, stubProvider({ stdout: "[]", truncated: true }));
            expect(dockerNote).toContain("may be incomplete");
            expect(stacks).toHaveLength(1);
            expect(stacks[0]!.state).toBe("unknown");
            expect(stacks[0]!.note).toContain("may be incomplete");
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
