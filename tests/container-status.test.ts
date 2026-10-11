import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveRoot } from "../src/stacks.ts";
import { loadContainers, loadManagedStacks } from "../src/container-status.ts";
import type { ComposeProvider } from "../src/compose-provider.ts";
import type { CommandResult } from "../src/docker.ts";
import type { ContainerInspector } from "../src/containers.ts";

const ok: CommandResult = { code: 0, stdout: "", stderr: "", timedOut: false, truncated: false };

let root: string;

beforeAll(async () => {
    root = await resolveRoot(await mkdtemp(join(tmpdir(), "compose-panel-containers-")));
    await mkdir(join(root, "blog"));
    await writeFile(join(root, "blog", "compose.yaml"), "services:\n  web:\n    image: nginx:alpine\n");
});

afterAll(async () => {
    await rm(root, { recursive: true, force: true });
});

function fakeProvider(projects: { Name: string; Status: string; ConfigFiles: string }[] = []): ComposeProvider {
    return {
        listProjects: async () => ({ ...ok, stdout: JSON.stringify(projects) }),
    } as unknown as ComposeProvider;
}

function fakeInspector(stdout: string, result: Partial<CommandResult> = {}): ContainerInspector {
    const value: CommandResult = { ...ok, stdout, ...result };
    return { engine: "docker", list: async () => value, inspect: async () => value, logs: async () => value };
}

type Fields = [string, string, string, string, string, string, string, string, string, string, string, string, string];

function line(fields: Fields): string {
    return fields.map(value => JSON.stringify(value)).join("\t");
}

const managedFile = (): string => join(root, "blog", "compose.yaml");

describe("loadManagedStacks", () => {
    test("resolves the canonical compose file and the deployed project name", async () => {
        const provider = fakeProvider([{ Name: "blog", Status: "running(1)", ConfigFiles: managedFile() }]);
        const stacks = await loadManagedStacks(root, provider);
        expect(stacks).toEqual([{ name: "blog", composeFile: managedFile(), project: "blog" }]);
    });

    test("leaves the project unknown when discovery has no match", async () => {
        const stacks = await loadManagedStacks(root, fakeProvider());
        expect(stacks).toEqual([{ name: "blog", composeFile: managedFile(), project: null }]);
    });
});

describe("loadContainers", () => {
    test("classifies managed by path, and external/standalone by labels", async () => {
        const provider = fakeProvider([{ Name: "blog", Status: "running(1)", ConfigFiles: managedFile() }]);
        const stdout = [
            line(["aaaaaaaaaaaa", "blog-web-1", "nginx:1.27", "running", "Up 1 hour", "none", "", "", "80/tcp", "blog", "web", managedFile(), root]),
            line(["bbbbbbbbbbbb", "watchtower", "watchtower:latest", "running", "Up 3 days", "none", "", "", "", "watchtower", "watchtower", "", ""]),
            line(["cccccccccccc", "legacy", "redis:7", "running", "Up 5 minutes", "none", "", "", "6379/tcp", "", "", "", ""]),
        ].join("\n");
        const result = await loadContainers(root, provider, fakeInspector(stdout));
        expect(result.note).toBeNull();
        expect(result.containers.map(container => [container.name, container.category])).toEqual([
            ["blog-web-1", "managed"],
            ["watchtower", "external"],
            ["legacy", "standalone"],
        ]);
        expect(result.containers[0]!.stack).toBe("blog");
    });

    test("reports Docker trouble and unexpected output as notes", async () => {
        const provider = fakeProvider();
        expect((await loadContainers(root, provider, fakeInspector("", { code: 1 }))).note).toContain("not reachable");
        expect((await loadContainers(root, provider, fakeInspector("", { timedOut: true }))).note).toContain("did not respond in time");
        expect((await loadContainers(root, provider, fakeInspector("garbage"))).note).toContain("unexpected container list");
    });

    test("a missing stacks directory still lists containers", async () => {
        const gone = join(root, "does-not-exist");
        const result = await loadContainers(gone, fakeProvider(), fakeInspector(line(["cccccccccccc", "legacy", "redis:7", "running", "Up", "none", "", "", "", "", "", "", ""])));
        expect(result.note).toBeNull();
        expect(result.containers[0]!.category).toBe("standalone");
    });
});
