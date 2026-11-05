import { describe, expect, test } from "bun:test";
import {
    checkRolloutEligibility,
    parseRolloutDeclaration,
    parseRolloutInspect,
    projectRolloutLabels,
    verifiesCandidateIdentity,
    type RolloutDeclaration,
    type RolloutInspect,
    type RolloutRefusalCode,
    type ServiceRolloutFacts,
} from "../src/rollout.ts";

const ID = "a".repeat(64);

function facts(overrides: Partial<ServiceRolloutFacts> = {}): ServiceRolloutFacts {
    return {
        image: "ghcr.io/example/app:1.2.3",
        build: false,
        containerName: false,
        publishedPorts: false,
        replicas: [],
        networkMode: null,
        ipc: null,
        pid: null,
        volumesFrom: [],
        fixedAddresses: [],
        labels: {},
        namespaceDependents: [],
        ...overrides,
    };
}

function inspect(overrides: Partial<RolloutInspect> = {}): RolloutInspect {
    return {
        id: ID,
        status: "running",
        running: true,
        health: "healthy",
        imageRef: "ghcr.io/example/app:1.2.3",
        imageId: "sha256:" + "b".repeat(64),
        created: "2026-11-05T10:00:00.000000000Z",
        labels: {
            "com.docker.compose.project": "demo",
            "com.docker.compose.service": "web",
            "com.docker.compose.project.config_files": "/opt/stacks/demo/compose.yaml",
            "com.docker.compose.project.working_dir": "/opt/stacks/demo",
        },
        mountDestinations: [],
        ...overrides,
    };
}

function declaration(overrides: Partial<RolloutDeclaration> = {}): RolloutDeclaration {
    return {
        enabled: true,
        timeoutSeconds: 120,
        settleSeconds: 5,
        drainFile: null,
        drainDetectSeconds: 30,
        drainTimeSeconds: 20,
        stopTimeoutSeconds: 30,
        ...overrides,
    };
}

function parseInspect(value: unknown): RolloutInspect | null {
    return parseRolloutInspect(JSON.stringify(value));
}

describe("projectRolloutLabels", () => {
    test("keeps only panel.rollout keys as strings", () => {
        expect(
            projectRolloutLabels({
                "panel.rollout.enabled": "true",
                "panel.rollout.timeout": 120,
                "panel.rollout.drain-file": "/tmp/drain",
                "stack.version": "1",
                unrelated: "x",
            }),
        ).toEqual({ enabled: "true", drainFile: "/tmp/drain" });
    });

    test("returns an empty projection for a missing labels object", () => {
        expect(projectRolloutLabels(null)).toEqual({});
        expect(projectRolloutLabels([])).toEqual({});
    });
});

describe("parseRolloutDeclaration", () => {
    test("no label means not declared", () => {
        expect(parseRolloutDeclaration({})).toBeNull();
    });

    test("explicit false or another disabled spelling is not declared", () => {
        expect(parseRolloutDeclaration({ enabled: "false" })).toBeNull();
        expect(parseRolloutDeclaration({ enabled: "" })).toBeNull();
    });

    test("accepts true with defaults", () => {
        const parsed = parseRolloutDeclaration({ enabled: "true" });
        expect(parsed).toEqual({
            ok: true,
            value: {
                enabled: true,
                timeoutSeconds: 120,
                settleSeconds: 5,
                drainFile: null,
                drainDetectSeconds: 30,
                drainTimeSeconds: 20,
                stopTimeoutSeconds: 30,
            },
        });
    });

    test("accepts a complete declaration", () => {
        const parsed = parseRolloutDeclaration({
            enabled: " true ",
            timeout: "60",
            settle: "0",
            drainFile: "/tmp/drain",
            drainDetect: "10",
            drainTime: "15",
            stopTimeout: "45",
        });
        expect(parsed).not.toBeNull();
        if (!parsed || !parsed.ok) throw new Error("expected a valid declaration");
        expect(parsed.value.timeoutSeconds).toBe(60);
        expect(parsed.value.settleSeconds).toBe(0);
        expect(parsed.value.drainFile).toBe("/tmp/drain");
        expect(parsed.value.drainDetectSeconds).toBe(10);
        expect(parsed.value.drainTimeSeconds).toBe(15);
        expect(parsed.value.stopTimeoutSeconds).toBe(45);
    });

    test("refuses an enabled value that is not exactly true", () => {
        const parsed = parseRolloutDeclaration({ enabled: "yes" });
        expect(parsed?.ok).toBe(false);
        if (parsed && !parsed.ok) expect(parsed.code).toBe("invalid-declaration");
    });

    test("refuses out-of-bound, negative or non-integer numbers", () => {
        for (const [key, value] of [
            ["timeout", "0"],
            ["timeout", "601"],
            ["timeout", "-1"],
            ["timeout", "1.5"],
            ["settle", "61"],
            ["drainDetect", "4"],
            ["drainTime", "301"],
            ["stopTimeout", "0"],
        ] as const) {
            const parsed = parseRolloutDeclaration({ enabled: "true", [key]: value });
            expect(parsed?.ok).toBe(false);
        }
    });

    test("refuses an invalid drain path", () => {
        for (const path of ["tmp/drain", "/tmp/../etc/passwd", "/tmp/a\nb", "/tmp/" + "a".repeat(300), ""]) {
            const parsed = parseRolloutDeclaration({ enabled: "true", drainFile: path });
            if (path === "") {
                expect(parsed?.ok).toBe(true);
                expect(parsed && parsed.ok && parsed.value.drainFile).toBeNull();
            } else {
                expect(parsed?.ok).toBe(false);
            }
        }
    });

    test("refuses drain timings without a drain marker", () => {
        expect(parseRolloutDeclaration({ enabled: "true", drainDetect: "10" })?.ok).toBe(false);
        expect(parseRolloutDeclaration({ enabled: "true", drainTime: "10" })?.ok).toBe(false);
    });
});

describe("parseRolloutInspect", () => {
    test("projects only the allow-listed fields", () => {
        const parsed = parseInspect({
            Id: ID,
            Image: "sha256:" + "c".repeat(64),
            Created: "2026-11-05T10:00:00Z",
            State: { Status: "running", Running: true, Health: { Status: "healthy" } },
            Config: {
                Image: "app:1",
                Env: ["SECRET=value"],
                Args: ["--token", "secret"],
                Labels: {
                    "com.docker.compose.project": "demo",
                    "com.docker.compose.service": "web",
                    "com.docker.compose.project.config_files": "/opt/demo/compose.yaml",
                    "com.docker.compose.project.working_dir": "/opt/demo",
                    "panel.rollout.drain-file": "/tmp/drain",
                    unrelated: "value",
                },
            },
            Mounts: [{ Destination: "/tmp/drain" }, { Destination: "/data" }],
        });
        expect(parsed).toEqual({
            id: ID,
            status: "running",
            running: true,
            health: "healthy",
            imageRef: "app:1",
            imageId: "sha256:" + "c".repeat(64),
            created: "2026-11-05T10:00:00Z",
            labels: {
                "com.docker.compose.project": "demo",
                "com.docker.compose.service": "web",
                "com.docker.compose.project.config_files": "/opt/demo/compose.yaml",
                "com.docker.compose.project.working_dir": "/opt/demo",
                "panel.rollout.drain-file": "/tmp/drain",
            },
            mountDestinations: ["/tmp/drain", "/data"],
        });
    });

    test("refuses a short ID, missing state or malformed JSON", () => {
        expect(parseInspect({ Id: "abc", State: { Running: true } })).toBeNull();
        expect(parseInspect({ Id: ID })).toBeNull();
        expect(parseRolloutInspect("not json")).toBeNull();
        expect(parseRolloutInspect("")).toBeNull();
    });

    test("handles an absent healthcheck and an array answer", () => {
        const parsed = parseInspect([{ Id: ID, State: { Status: "running", Running: true } }]);
        expect(parsed?.health).toBeNull();
    });
});

describe("checkRolloutEligibility", () => {
    test("accepts a healthy, image-only service with one container", () => {
        expect(checkRolloutEligibility({ facts: facts(), declaration: declaration(), inspect: inspect(), containerCount: 1 })).toEqual({
            ok: true,
            image: "ghcr.io/example/app:1.2.3",
        });
    });

    test("refuses every conflicting Compose fact", () => {
        const cases: Array<[Partial<ServiceRolloutFacts> | null, RolloutRefusalCode]> = [
            [{ build: true }, "build"],
            [{ containerName: true }, "container-name"],
            [{ publishedPorts: true }, "published-ports"],
            [{ replicas: [2] }, "replicas"],
            [{ replicas: [Number.NaN] }, "replicas"],
            [{ networkMode: "host" }, "network-mode"],
            [{ networkMode: "none" }, "network-mode"],
            [{ networkMode: "service:db" }, "network-mode"],
            [{ ipc: "host" }, "shared-namespace"],
            [{ pid: "container:other" }, "shared-namespace"],
            [{ volumesFrom: ["db"] }, "shared-namespace"],
            [{ namespaceDependents: ["sidecar"] }, "shared-namespace"],
            [{ fixedAddresses: ["backend"] }, "fixed-address"],
            [{ image: null }, "no-image"],
        ];
        for (const [overrides, code] of cases) {
            const result = checkRolloutEligibility({
                facts: facts(overrides ?? {}),
                declaration: declaration(),
                inspect: inspect(),
                containerCount: 1,
            });
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.code).toBe(code);
        }
    });

    test("refuses an unexpected container count or an unreadable container", () => {
        for (const [count, container] of [
            [0, null],
            [2, inspect()],
            [1, null],
        ] as const) {
            const result = checkRolloutEligibility({
                facts: facts(),
                declaration: declaration(),
                inspect: container,
                containerCount: count,
            });
            expect(result.ok).toBe(false);
        }
    });

    test("refuses a container that is not running or not healthy", () => {
        for (const [overrides, code] of [
            [{ running: false }, "not-running"],
            [{ health: null }, "no-healthcheck"],
            [{ health: "starting" }, "unhealthy"],
            [{ health: "unhealthy" }, "unhealthy"],
        ] as const) {
            const result = checkRolloutEligibility({
                facts: facts(),
                declaration: declaration(),
                inspect: inspect(overrides),
                containerCount: 1,
            });
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.code).toBe(code);
        }
    });

    test("requires the drain contract on the old container", () => {
        const missing = checkRolloutEligibility({
            facts: facts(),
            declaration: declaration({ drainFile: "/tmp/drain" }),
            inspect: inspect(),
            containerCount: 1,
        });
        expect(missing.ok).toBe(false);
        if (!missing.ok) expect(missing.code).toBe("drain-contract");

        const different = checkRolloutEligibility({
            facts: facts(),
            declaration: declaration({ drainFile: "/tmp/other" }),
            inspect: inspect({ labels: { ...inspect().labels, "panel.rollout.drain-file": "/tmp/drain" } }),
            containerCount: 1,
        });
        expect(different.ok).toBe(false);
        if (!different.ok) expect(different.code).toBe("drain-contract");
    });

    test("refuses a drain marker covered by a mount", () => {
        const result = checkRolloutEligibility({
            facts: facts(),
            declaration: declaration({ drainFile: "/data/drain" }),
            inspect: inspect({
                labels: { ...inspect().labels, "panel.rollout.drain-file": "/data/drain" },
                mountDestinations: ["/data"],
            }),
            containerCount: 1,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.code).toBe("drain-mount");
    });
});

describe("verifiesCandidateIdentity", () => {
    const startedAt = Date.parse("2026-11-05T10:00:00Z");

    function verify(overrides: Partial<RolloutInspect> = {}, initialIds: string[] = []): boolean {
        return verifiesCandidateIdentity({
            inspect: inspect(overrides),
            project: "demo",
            service: "web",
            composeFile: "/opt/stacks/demo/compose.yaml",
            cwd: "/opt/stacks/demo",
            operationStartedAt: startedAt,
            initialIds,
        });
    }

    test("accepts a matching new container", () => {
        expect(verify()).toBe(true);
    });

    test("refuses an ID from the initial snapshot", () => {
        expect(verify({}, [ID])).toBe(false);
    });

    test("refuses a different project, service, file or working directory", () => {
        const labelCases: Record<string, string>[] = [
            { "com.docker.compose.project": "other" },
            { "com.docker.compose.service": "other" },
            { "com.docker.compose.project.config_files": "/opt/other/compose.yaml" },
            { "com.docker.compose.project.working_dir": "/opt/other" },
        ];
        for (const labels of labelCases) {
            expect(verify({ labels: { ...inspect().labels, ...labels } })).toBe(false);
        }
    });

    test("refuses several Compose files or a missing working directory", () => {
        expect(
            verify({
                labels: {
                    ...inspect().labels,
                    "com.docker.compose.project.config_files": "/opt/a/compose.yaml,/opt/a/override.yaml",
                },
            }),
        ).toBe(false);
        const labels = { ...inspect().labels };
        delete labels["com.docker.compose.project.working_dir"];
        expect(verify({ labels })).toBe(false);
    });

    test("refuses a container created before the operation", () => {
        expect(verify({ created: "2026-11-05T09:59:00Z" })).toBe(false);
        expect(verify({ created: null })).toBe(false);
        expect(verify({ created: "not a date" })).toBe(false);
    });

    test("tolerates a one-second clock skew", () => {
        expect(verify({ created: "2026-11-05T09:59:59.500Z" })).toBe(true);
    });
});
