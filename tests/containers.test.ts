import { describe, expect, test } from "bun:test";
import {
    CONTAINER_LIST_FORMAT,
    CONTAINER_LOG_TAIL_DEFAULT,
    ContainerRefError,
    createContainerInspector,
    isContainerId,
    sanitizeTailLines,
} from "../src/containers.ts";
import { CONTAINER_LIST_FIELD_COUNT, parseContainerLs } from "../src/container-state.ts";
import type { CommandResult, DockerRunner } from "../src/docker.ts";

const ok: CommandResult = { code: 0, stdout: "", stderr: "", timedOut: false, truncated: false };
const ID = "df48a7b63a0a611b2a1b7050ac56f05338b4eaf24ee1ef83c456fa56beecc10d";

function recording(result: CommandResult = ok) {
    const calls: { args: string[]; options?: Parameters<DockerRunner>[1] }[] = [];
    const runner: DockerRunner = async (args, options) => {
        calls.push({ args, options });
        return result;
    };
    return { runner, calls };
}

describe("createContainerInspector", () => {
    test("builds the Docker inspector by default", () => {
        expect(createContainerInspector({ runner: recording().runner }).engine).toBe("docker");
    });

    test("refuses Podman and unknown engines explicitly", () => {
        expect(() => createContainerInspector({ runner: recording().runner, engine: "podman" })).toThrow(/not implemented/);
        expect(() => createContainerInspector({ runner: recording().runner, engine: "lxc" })).toThrow(/Unknown container engine/);
    });
});

describe("DockerContainerInspector", () => {
    test("lists containers with a fixed, structured format and no shell", async () => {
        const { runner, calls } = recording();
        await createContainerInspector({ runner }).list();
        expect(calls[0]!.args).toEqual(["container", "ls", "-a", "--no-trunc", "--format", CONTAINER_LIST_FORMAT]);
        // The Compose labels are read individually, never by parsing `.Labels`.
        expect(CONTAINER_LIST_FORMAT).toContain('{{.Label "com.docker.compose.project" | json}}');
        expect(CONTAINER_LIST_FORMAT).toContain('{{.Label "com.docker.compose.project.config_files" | json}}');
        for (const arg of calls[0]!.args) expect(arg).not.toBe("-c");
    });

    test("the list format and the parser agree on the field count", () => {
        expect(CONTAINER_LIST_FORMAT.split("\\t")).toHaveLength(CONTAINER_LIST_FIELD_COUNT);
    });

    test("inspects a validated container id with an explicit argument array", async () => {
        const { runner, calls } = recording();
        await createContainerInspector({ runner }).inspect(ID);
        expect(calls[0]!.args).toEqual(["container", "inspect", "--", ID]);
    });

    test("reads a bounded log snapshot, sanitizing the tail", async () => {
        const { runner, calls } = recording();
        const inspector = createContainerInspector({ runner });
        await inspector.logs({ id: ID, tailLines: 500, maxBytes: 4096 });
        expect(calls[0]!.args).toEqual(["container", "logs", "--tail", "500", "--timestamps", "--", ID]);
        expect(calls[0]!.options?.maxBytes).toBe(4096);
        // No `--no-color`: `docker logs` does not support it.
        expect(calls[0]!.args).not.toContain("--no-color");
    });

    test("rejects an invalid container id before spawning anything", () => {
        const { runner, calls } = recording();
        const inspector = createContainerInspector({ runner });
        for (const bad of ["", "not-hex", "../escape", "-f", ID + "x"]) {
            expect(() => inspector.inspect(bad)).toThrow(ContainerRefError);
            expect(() => inspector.logs({ id: bad })).toThrow(ContainerRefError);
        }
        expect(calls).toHaveLength(0);
    });
});

describe("sanitizeTailLines", () => {
    test("keeps only allow-listed values and defaults otherwise", () => {
        expect(sanitizeTailLines(100)).toBe(100);
        expect(sanitizeTailLines(1000)).toBe(1000);
        expect(sanitizeTailLines(-1)).toBe(CONTAINER_LOG_TAIL_DEFAULT);
        expect(sanitizeTailLines(1.5)).toBe(CONTAINER_LOG_TAIL_DEFAULT);
        expect(sanitizeTailLines(999999)).toBe(CONTAINER_LOG_TAIL_DEFAULT);
        expect(sanitizeTailLines(undefined)).toBe(CONTAINER_LOG_TAIL_DEFAULT);
    });

    test("the default is itself an allowed value", () => {
        expect(sanitizeTailLines(CONTAINER_LOG_TAIL_DEFAULT)).toBe(CONTAINER_LOG_TAIL_DEFAULT);
    });
});

describe("isContainerId", () => {
    test("accepts short and full hex ids, rejects anything else", () => {
        expect(isContainerId(ID)).toBe(true);
        expect(isContainerId(ID.slice(0, 12))).toBe(true);
        expect(isContainerId("DF48A7B63A0A")).toBe(false);
        expect(isContainerId("short")).toBe(false);
        expect(isContainerId("")).toBe(false);
    });
});

describe("list output round-trips through the parser", () => {
    test("a realistic line parses with its Compose labels", async () => {
        const line = [
            JSON.stringify(ID),
            JSON.stringify("demo-app-1"),
            JSON.stringify("nginx:1.27"),
            JSON.stringify("running"),
            JSON.stringify("Up 2 hours (healthy)"),
            JSON.stringify("healthy"),
            JSON.stringify("2026-10-05 08:31:11 +0200 CEST"),
            JSON.stringify("5 days ago"),
            JSON.stringify("0.0.0.0:8080->80/tcp"),
            JSON.stringify("demo"),
            JSON.stringify("app"),
            JSON.stringify("/app/stacks/demo/compose.yaml"),
            JSON.stringify("/app/stacks/demo"),
        ].join("\t");
        const { runner } = recording({ ...ok, stdout: line });
        const result = await createContainerInspector({ runner }).list();
        const [container] = parseContainerLs(result.stdout);
        expect(container!.id).toBe(ID);
        expect(container!.project).toBe("demo");
        expect(container!.configFiles).toEqual(["/app/stacks/demo/compose.yaml"]);
    });
});
