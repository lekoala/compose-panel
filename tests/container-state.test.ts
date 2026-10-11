import { describe, expect, test } from "bun:test";
import {
    ContainerStateError,
    classifyContainers,
    matchesContainerFilter,
    normalizeComposePath,
    parseContainerFilter,
    parseContainerInspect,
    parseContainerLs,
    type ContainerSummary,
    type ManagedStack,
} from "../src/container-state.ts";

const ID = "df48a7b63a0a611b2a1b7050ac56f05338b4eaf24ee1ef83c456fa56beecc10d";

/** One `docker container ls` line: fields tab-separated, each JSON-encoded. */
function line(values: (string | null)[]): string {
    return values.map(value => JSON.stringify(value ?? "")).join("\t");
}

function row(overrides: Partial<Record<number, string | null>> = {}): string {
    const fields: (string | null)[] = [
        ID, "demo-app-1", "nginx:1.27", "running", "Up 2 hours (healthy)", "healthy",
        "2026-10-05 08:31:11 +0200 CEST", "5 days ago", "0.0.0.0:8080->80/tcp",
        "demo", "app", "/app/stacks/demo/compose.yaml", "/app/stacks/demo",
    ];
    for (const [index, value] of Object.entries(overrides)) {
        if (value !== undefined) fields[Number(index)] = value;
    }
    return line(fields);
}

function summary(overrides: Partial<ContainerSummary> = {}): ContainerSummary {
    return {
        id: ID,
        name: "demo-app-1",
        image: "nginx:1.27",
        state: "running",
        status: "Up 2 hours (healthy)",
        health: "healthy",
        createdAt: "2026-10-05 08:31:11 +0200 CEST",
        runningFor: "5 days ago",
        ports: "0.0.0.0:8080->80/tcp",
        project: null,
        service: null,
        configFiles: [],
        workingDir: null,
        ...overrides,
    };
}

describe("parseContainerLs", () => {
    test("parses a full row with the Compose labels", () => {
        const [container] = parseContainerLs(row());
        expect(container).toEqual({
            id: ID,
            name: "demo-app-1",
            image: "nginx:1.27",
            state: "running",
            status: "Up 2 hours (healthy)",
            health: "healthy",
            createdAt: "2026-10-05 08:31:11 +0200 CEST",
            runningFor: "5 days ago",
            ports: "0.0.0.0:8080->80/tcp",
            project: "demo",
            service: "app",
            configFiles: ["/app/stacks/demo/compose.yaml"],
            workingDir: "/app/stacks/demo",
        });
    });

    test("normalizes missing labels and health to null", () => {
        const [container] = parseContainerLs(row({ 5: "none", 9: null, 10: null, 11: null, 12: null }));
        expect(container!.health).toBeNull();
        expect(container!.project).toBeNull();
        expect(container!.service).toBeNull();
        expect(container!.workingDir).toBeNull();
        expect(container!.configFiles).toEqual([]);
    });

    test("splits several config files and cleans a leading slash / multiple names", () => {
        const [container] = parseContainerLs(row({ 1: "/demo-app-1,alias", 11: "/a/compose.yaml, /a/extra.yaml" }));
        expect(container!.name).toBe("demo-app-1");
        expect(container!.configFiles).toEqual(["/a/compose.yaml", "/a/extra.yaml"]);
    });

    test("a value containing a quote or a tab cannot desynchronize the columns", () => {
        const [container] = parseContainerLs(row({ 4: 'Started\twith "quotes" and a tab' }));
        expect(container!.status).toBe('Started\twith "quotes" and a tab');
        expect(container!.project).toBe("demo");
    });

    test("empty output means no containers", () => expect(parseContainerLs("")).toEqual([]));

    test("rejects malformed output", () => {
        expect(() => parseContainerLs("not a container line")).toThrow(ContainerStateError);
        expect(() => parseContainerLs(row().split("\t").slice(0, 5).join("\t"))).toThrow(ContainerStateError);
        const badId = row({ 0: "not-hex" });
        expect(() => parseContainerLs(badId)).toThrow(ContainerStateError);
        const brokenJson = row().replace('"nginx:1.27"', "not-json");
        expect(() => parseContainerLs(brokenJson)).toThrow(ContainerStateError);
    });
});

describe("parseContainerInspect", () => {
    const imageId = `sha256:${"a".repeat(64)}`;
    const inspect = JSON.stringify([{
        Id: ID,
        Name: "/demo-app-1",
        Created: "2026-10-05T08:31:11.123456789Z",
        Image: imageId,
        Config: { Image: "nginx:1.27", Env: ["SECRET_TOKEN=super-secret"], Labels: { "com.docker.compose.project": "demo" } },
        State: {
            Status: "running", Running: true, Paused: false, Restarting: false, ExitCode: 0,
            StartedAt: "2026-10-05T08:31:12Z", FinishedAt: "0001-01-01T00:00:00Z", Health: { Status: "healthy" },
        },
        HostConfig: { RestartPolicy: { Name: "unless-stopped" } },
        NetworkSettings: {
            Ports: {
                "80/tcp": [{ HostIp: "0.0.0.0", HostPort: "8080" }],
                "443/tcp": null,
                "9000/tcp": [{ HostIp: "127.0.0.1", HostPort: "9000" }],
            },
        },
        Mounts: [
            { Type: "bind", Source: "/host/data", Destination: "/data", Mode: "ro", RW: false },
            { Type: "volume", Source: "demo_data", Destination: "/var/lib", Mode: "", RW: true },
        ],
    }]);

    test("projects only the whitelisted fields", () => {
        const details = parseContainerInspect(inspect);
        expect(details.name).toBe("demo-app-1");
        expect(details.image).toBe("nginx:1.27");
        expect(details.imageId).toBe(imageId);
        expect(details.state).toBe("running");
        expect(details.running).toBe(true);
        expect(details.exitCode).toBe(0);
        expect(details.health).toBe("healthy");
        expect(details.restartPolicy).toBe("unless-stopped");
    });

    test("never exposes Config.Env", () => {
        expect(JSON.stringify(parseContainerInspect(inspect))).not.toContain("super-secret");
    });

    test("flattens published ports and flags all-interface bindings", () => {
        expect(parseContainerInspect(inspect).ports).toEqual([
            { container: "443/tcp", host: null, publicInterface: false },
            { container: "80/tcp", host: "0.0.0.0:8080", publicInterface: true },
            { container: "9000/tcp", host: "127.0.0.1:9000", publicInterface: false },
        ]);
    });

    test("brackets IPv6 host bindings", () => {
        const ipv6 = JSON.stringify([{
            Id: ID, Name: "/v6", Config: { Image: "nginx" }, State: { Status: "running" },
            NetworkSettings: { Ports: { "80/tcp": [{ HostIp: "::", HostPort: "80" }] } },
        }]);
        expect(parseContainerInspect(ipv6).ports).toEqual([
            { container: "80/tcp", host: "[::]:80", publicInterface: true },
        ]);
    });

    test("projects mounts with a read-only flag", () => {
        expect(parseContainerInspect(inspect).mounts).toEqual([
            { type: "bind", source: "/host/data", destination: "/data", mode: "ro", readOnly: true },
            { type: "volume", source: "demo_data", destination: "/var/lib", mode: "", readOnly: false },
        ]);
    });

    test("rejects malformed or unrecognized inspect output", () => {
        expect(() => parseContainerInspect("")).toThrow(ContainerStateError);
        expect(() => parseContainerInspect("not json")).toThrow(ContainerStateError);
        expect(() => parseContainerInspect(JSON.stringify([{ Id: "not-hex" }]))).toThrow(ContainerStateError);
    });
});

describe("normalizeComposePath", () => {
    test("normalizes separators and trailing slashes", () => {
        expect(normalizeComposePath("C:\\stacks\\w\\compose.yaml")).toBe("C:/stacks/w/compose.yaml");
        expect(normalizeComposePath("/app/stacks/demo/")).toBe("/app/stacks/demo");
    });

    test("applies a host to panel prefix alias", () => {
        const aliases = [{ from: "D:\\www\\stacks", to: "/app/stacks" }];
        expect(normalizeComposePath("D:\\www\\stacks\\blog\\compose.yaml", aliases)).toBe("/app/stacks/blog/compose.yaml");
        // A path outside the alias is left untouched.
        expect(normalizeComposePath("D:\\other\\blog\\compose.yaml", aliases)).toBe("D:/other/blog/compose.yaml");
    });
});

describe("classifyContainers", () => {
    const stacks: ManagedStack[] = [
        { name: "blog", composeFile: "/app/stacks/blog/compose.yaml", project: "blog" },
        { name: "wiki", composeFile: "/app/stacks/wiki/docker-compose.yml", project: null },
    ];

    test("managed by an exact config file path", () => {
        const [container] = classifyContainers([summary({ configFiles: ["/app/stacks/blog/compose.yaml"], project: "blog" })], stacks);
        expect(container!.category).toBe("managed");
    });

    test("managed by a unique project name only when config_files is absent", () => {
        const [container] = classifyContainers([summary({ configFiles: [], project: "blog" })], stacks);
        expect(container!.category).toBe("managed");
    });

    test("external when the project matches but the path is unknown (migration mismatch)", () => {
        const [container] = classifyContainers(
            [summary({ configFiles: ["/opt/stacks/blog/compose.yaml"], project: "blog" })],
            stacks,
        );
        expect(container!.category).toBe("external");
    });

    test("external when the project name matches but no managed stack is deployed under it", () => {
        const [container] = classifyContainers([summary({ configFiles: [], project: "wiki" })], stacks);
        expect(container!.category).toBe("external");
    });

    test("external when several managed stacks share the project name", () => {
        const shared: ManagedStack[] = [
            { name: "a", composeFile: "/app/stacks/a/compose.yaml", project: "same" },
            { name: "b", composeFile: "/app/stacks/b/compose.yaml", project: "same" },
        ];
        const [container] = classifyContainers([summary({ configFiles: [], project: "same" })], shared);
        expect(container!.category).toBe("external");
    });

    test("external when the stack was removed but the container still runs", () => {
        const [container] = classifyContainers([summary({ configFiles: ["/gone/stacks/old/compose.yaml"], project: "old" })], stacks);
        expect(container!.category).toBe("external");
    });

    test("standalone without any Compose label", () => {
        const [container] = classifyContainers([summary({ project: null, service: null, configFiles: [] })], stacks);
        expect(container!.category).toBe("standalone");
    });

    test("managed through a host/panel path alias", () => {
        const aliases = [{ from: "D:\\www\\stacks", to: "/app/stacks" }];
        const [container] = classifyContainers(
            [summary({ configFiles: ["D:\\www\\stacks\\blog\\compose.yaml"], project: "blog" })],
            stacks,
            aliases,
        );
        expect(container!.category).toBe("managed");
    });
});

describe("container filters", () => {
    test("running includes active states", () => {
        for (const state of ["running", "restarting", "paused", "RUNNING"]) {
            expect(matchesContainerFilter(state, "running")).toBe(true);
        }
    });

    test("stopped includes every non-active state, including an unknown one", () => {
        for (const state of ["created", "exited", "dead", "removing", "mystery"]) {
            expect(matchesContainerFilter(state, "stopped")).toBe(true);
            expect(matchesContainerFilter(state, "running")).toBe(false);
        }
    });

    test("all matches everything", () => {
        expect(matchesContainerFilter("exited", "all")).toBe(true);
        expect(matchesContainerFilter("running", "all")).toBe(true);
    });

    test("parseContainerFilter defaults to running", () => {
        expect(parseContainerFilter("stopped")).toBe("stopped");
        expect(parseContainerFilter("all")).toBe("all");
        expect(parseContainerFilter("bogus")).toBe("running");
        expect(parseContainerFilter(null)).toBe("running");
    });
});
