import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createComposeProvider } from "../src/compose-provider.ts";
import { resolveRoot } from "../src/stacks.ts";
import type { ComposeProvider } from "../src/compose-provider.ts";
import type { CommandResult } from "../src/docker.ts";
import { StackError } from "../src/stacks.ts";
import { loadProjects, loadStackDetail, loadStackStates } from "../src/status.ts";

const ok: CommandResult = { code: 0, stdout: "[]", stderr: "", timedOut: false, truncated: false };

test.skipIf(process.platform === "win32")("detail refuses an unsafe env before any config-consuming Docker read", async () => {
    const root = await resolveRoot(await mkdtemp(join(tmpdir(), "cp-detail-env-")));
    const cwd = join(root, "demo");
    const composeFile = join(cwd, "compose.yaml");
    const calls: string[][] = [];
    const provider = createComposeProvider({ runner: async args => {
        calls.push(args);
        return { ...ok, stdout: JSON.stringify([{ Name: "actual-project", Status: "running(1)", ConfigFiles: composeFile }]) };
    } });
    try {
        await mkdir(cwd);
        await writeFile(composeFile, "services: {}\n");
        await writeFile(join(root, "private.env"), "SECRET=do-not-read\n");
        await symlink(join(root, "private.env"), join(cwd, ".env"));
        const detail = await loadStackDetail(root, "demo", provider);
        expect(detail.state).toBe("running");
        expect(detail.services).toEqual([]);
        expect(calls).toEqual([["compose", "ls", "--all", "--format", "json"]]);
    } finally { await rm(root, { recursive: true, force: true }); }
});

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

test("detail loads config and services concurrently and preserves Docker state when metadata fails", async () => {
    const root = await resolveRoot(await mkdtemp(join(tmpdir(), "cp-detail-parallel-")));
    const file = join(root, "demo", "compose.yaml");
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let configStarted!: () => void;
    let servicesStarted!: () => void;
    const bothStarted = Promise.all([
        new Promise<void>(resolve => { configStarted = resolve; }),
        new Promise<void>(resolve => { servicesStarted = resolve; }),
    ]);
    const provider = createComposeProvider({ runner: async () => ok });
    provider.listProjects = async () => ({ ...ok, stdout: JSON.stringify([{ Name: "demo", Status: "running(1)", ConfigFiles: file }]) });
    provider.stackMetadata = async () => { configStarted(); await gate; throw new Error("private-config-output"); };
    provider.projectServices = async () => {
        servicesStarted();
        await gate;
        return { ...ok, stdout: JSON.stringify([{ Name: "demo-app-1", Service: "app", State: "running", Image: "busybox" }]) };
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let task: ReturnType<typeof loadStackDetail> | undefined;
    try {
        await mkdir(join(root, "demo"));
        await writeFile(file, "services:\n  app:\n    image: busybox\n");
        task = loadStackDetail(root, "demo", provider);
        const started = await Promise.race([
            bothStarted.then(() => true),
            new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 1000); }),
        ]);
        expect(started).toBe(true);
        release();
        const detail = await task;
        expect(detail.state).toBe("running");
        expect(detail.services).toHaveLength(1);
        expect(detail.declared).toBeNull();
        expect(JSON.stringify(detail)).not.toContain("private-config-output");
    } finally {
        clearTimeout(timer);
        release();
        await task;
        await rm(root, { recursive: true, force: true });
    }
});
