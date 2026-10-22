import { describe, expect, test } from "bun:test";
import {
    ComposeStateError,
    findProjectForStack,
    parseComposeLs,
    parseComposePs,
    summarizeProjectStatus,
    summarizeServices,
    type ComposeProject,
} from "../src/compose-state.ts";

describe("parseComposeLs", () => {
    test("parses a JSON array", () => {
        const projects = parseComposeLs(
            JSON.stringify([
                { Name: "demo", Status: "running(1)", ConfigFiles: "/opt/stacks/demo/compose.yaml" },
                { Name: "old", Status: "exited(2)", ConfigFiles: "/opt/stacks/old/compose.yaml" },
            ]),
        );
        expect(projects).toEqual([
            { name: "demo", status: "running(1)", configFiles: ["/opt/stacks/demo/compose.yaml"] },
            { name: "old", status: "exited(2)", configFiles: ["/opt/stacks/old/compose.yaml"] },
        ]);
    });

    test("splits multiple config files", () => {
        const projects = parseComposeLs(JSON.stringify([{ Name: "x", Status: "running(1)", ConfigFiles: "/a/c.yaml, /a/extra.yaml" }]));
        expect(projects[0]!.configFiles).toEqual(["/a/c.yaml", "/a/extra.yaml"]);
    });

    test("treats empty output as no projects", () => expect(parseComposeLs("")).toEqual([]));

    test("rejects malformed output", () => expect(() => parseComposeLs("{not json")).toThrow(ComposeStateError));
});

describe("parseComposePs", () => {
    test("parses a JSON array", () => {
        const services = parseComposePs(
            JSON.stringify([
                { Service: "app", State: "running", Health: "healthy", ExitCode: 0 },
                { Service: "init", State: "exited", ExitCode: 0 },
            ]),
        );
        expect(services).toEqual([
            { name: "app", state: "running", health: "healthy", exitCode: 0, container: null, image: null },
            { name: "init", state: "exited", health: null, exitCode: 0, container: null, image: null },
        ]);
    });

    test("parses JSON lines and falls back to the container name", () => {
        const stdout = [
            JSON.stringify({ Name: "demo-app-1", State: "running" }),
            JSON.stringify({ Name: "demo-db-1", State: "exited" }),
        ].join("\n");
        expect(parseComposePs(stdout).map((service) => service.name)).toEqual(["demo-app-1", "demo-db-1"]);
    });

    test("rejects malformed output", () => expect(() => parseComposePs("not json at all")).toThrow(ComposeStateError));
});

describe("summarizeServices", () => {
    test("no services means not created", () => expect(summarizeServices([])).toBe("not-created"));
    test("a running app wins over an init job exited 0", () => {
        expect(
            summarizeServices([
                { name: "init", state: "exited", health: null, exitCode: 0, container: null, image: null },
                { name: "app", state: "running", health: null, exitCode: null, container: null, image: null },
            ]),
        ).toBe("running");
    });
    test("all exited is stopped", () => {
        expect(summarizeServices([{ name: "app", state: "exited", health: null, exitCode: 0, container: null, image: null }])).toBe(
            "stopped",
        );
    });
    test("created only is stopped", () => {
        expect(summarizeServices([{ name: "app", state: "created", health: null, exitCode: null, container: null, image: null }])).toBe(
            "stopped",
        );
    });
    test("an unrecognized state is unknown", () => {
        expect(summarizeServices([{ name: "app", state: "dead-ish", health: null, exitCode: null, container: null, image: null }])).toBe(
            "unknown",
        );
    });
});

describe("summarizeProjectStatus", () => {
    test("maps compose ls statuses", () => {
        expect(summarizeProjectStatus("running(2)")).toBe("running");
        expect(summarizeProjectStatus("restarting(1)")).toBe("running");
        expect(summarizeProjectStatus("exited(1)")).toBe("stopped");
        expect(summarizeProjectStatus("created")).toBe("stopped");
        expect(summarizeProjectStatus("")).toBe("unknown");
        expect(summarizeProjectStatus("mystery")).toBe("unknown");
    });
});

describe("findProjectForStack", () => {
    const projects: ComposeProject[] = [
        { name: "demo", status: "running(1)", configFiles: ["/opt/stacks/demo/compose.yaml"] },
        { name: "dual", status: "running(1)", configFiles: ["/s/dual/compose.yaml", "/s/dual/extra.yaml"] },
        { name: "a", status: "running(1)", configFiles: ["/s/shared/compose.yaml"] },
        { name: "b", status: "running(1)", configFiles: ["/s/shared/compose.yaml"] },
    ];

    test("matches by file path, not by folder name", () => {
        const match = findProjectForStack(projects, "/opt/stacks/demo/compose.yaml");
        expect(match.project?.name).toBe("demo");
        expect(match.ambiguous).toBe(false);
    });

    test("normalizes Windows separators", () => {
        const match = findProjectForStack(projects, "C:\\opt\\stacks\\demo\\compose.yaml");
        expect(match.project).toBeNull();
        const win = findProjectForStack(
            [{ name: "w", status: "", configFiles: ["C:\\stacks\\w\\compose.yaml"] }],
            "C:/stacks/w/compose.yaml",
        );
        expect(win.project?.name).toBe("w");
    });

    test("returns no project when nothing matches", () => {
        const match = findProjectForStack(projects, "/opt/stacks/other/compose.yaml");
        expect(match.project).toBeNull();
        expect(match.ambiguous).toBe(false);
    });

    test("flags a project that spans more files than the stack", () => {
        const match = findProjectForStack(projects, "/s/dual/compose.yaml");
        expect(match.project).toBeNull();
        expect(match.ambiguous).toBe(true);
    });

    test("flags multiple projects matching the same file", () => {
        const match = findProjectForStack(projects, "/s/shared/compose.yaml");
        expect(match.ambiguous).toBe(true);
    });
});
