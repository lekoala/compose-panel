import { describe, expect, test } from "bun:test";
import type { CommandResult } from "../src/docker.ts";
import type { RolloutDeclaration } from "../src/rollout.ts";
import { runRollout, type RolloutDependencies, type RolloutInput } from "../src/rollout-run.ts";

const START = Date.parse("2026-11-05T10:00:00Z");
const OLD_ID = "a".repeat(64);
const CANDIDATE_ID = "b".repeat(64);
const OTHER_ID = "c".repeat(64);
const IMAGE_ID = "sha256:" + "d".repeat(64);
const OTHER_IMAGE_ID = "sha256:" + "e".repeat(64);

interface FakeContainer {
    id: string;
    labels: Record<string, string>;
    created: string;
    running: boolean;
    health: string | null;
    imageId: string;
}

function labels(service = "web", project = "demo"): Record<string, string> {
    return {
        "com.docker.compose.project": project,
        "com.docker.compose.service": service,
        "com.docker.compose.project.config_files": "/opt/stacks/demo/compose.yaml",
        "com.docker.compose.project.working_dir": "/opt/stacks/demo",
    };
}

function declaration(overrides: Partial<RolloutDeclaration> = {}): RolloutDeclaration {
    return {
        enabled: true,
        timeoutSeconds: 5,
        settleSeconds: 0,
        drainFile: null,
        drainDetectSeconds: 5,
        drainTimeSeconds: 5,
        stopTimeoutSeconds: 30,
        ...overrides,
    };
}

interface WorldOptions {
    declaration?: Partial<RolloutDeclaration>;
    pull?: boolean;
    pullCode?: number;
    pullUnconfirmed?: boolean;
    scaleCode?: number;
    scaleUnconfirmed?: boolean;
    createsOnScale?: boolean;
    createExtra?: boolean;
    candidateLabels?: Record<string, string>;
    candidateCreated?: string;
    candidateHealth?: "healthy" | "starting" | "unhealthy" | "none" | "dies-after-remove" | "dies-during-drain";
    candidateImageId?: string;
    markCode?: number;
    markUnconfirmed?: boolean;
    unhealthyAfterMark?: boolean;
    stopCode?: number;
    stopUnconfirmed?: boolean;
    removeCode?: number;
    removeUnconfirmed?: boolean;
    oldGoneOnScale?: boolean;
    oldFailsDuringSettle?: "stopped" | "unhealthy" | "no-healthcheck";
    shutdown?: () => boolean;
}

function world(options: WorldOptions = {}) {
    let clock = START;
    const calls: string[] = [];
    const containers = new Map<string, FakeContainer>();
    const old: FakeContainer = {
        id: OLD_ID,
        labels: labels("web"),
        created: new Date(START - 60_000).toISOString(),
        running: true,
        health: "healthy",
        imageId: "sha256:" + "f".repeat(64),
    };
    containers.set(old.id, old);
    let candidate: FakeContainer | null = null;
    let candidatePolls = 0;

    const deps: RolloutDependencies = {
        pull: async () => {
            calls.push("pull");
            return result(options.pullCode ?? 0, options.pullUnconfirmed);
        },
        scale: async () => {
            calls.push("scale");
            if (options.oldGoneOnScale) containers.delete(OLD_ID);
            if (options.createsOnScale !== false) {
                candidate = {
                    id: CANDIDATE_ID,
                    labels: options.candidateLabels ?? labels("web"),
                    created: options.candidateCreated ?? new Date(clock).toISOString(),
                    running: true,
                    health: "starting",
                    imageId: options.candidateImageId ?? IMAGE_ID,
                };
                containers.set(candidate.id, candidate);
            }
            if (options.createExtra) {
                containers.set(OTHER_ID, {
                    id: OTHER_ID,
                    labels: labels("web"),
                    created: new Date(clock).toISOString(),
                    running: true,
                    health: "starting",
                    imageId: IMAGE_ID,
                });
            }
            return result(options.scaleCode ?? 0, options.scaleUnconfirmed);
        },
        listServiceContainers: async () => [...containers.keys()],
        inspect: async (id) => {
            const container = containers.get(id);
            if (!container) return null;
            if (id === CANDIDATE_ID) {
                const mode = options.candidateHealth ?? "healthy";
                if (container.health === "starting") {
                    candidatePolls += 1;
                    if ((mode === "healthy" || mode === "dies-after-remove" || mode === "dies-during-drain") && candidatePolls >= 1) {
                        container.health = "healthy";
                    }
                    if (mode === "unhealthy") container.health = "unhealthy";
                    if (mode === "none") container.health = null;
                    if (mode === "starting") container.health = "starting";
                }
                if (mode === "dies-after-remove" && !containers.has(OLD_ID)) container.running = false;
                if (mode === "dies-during-drain" && old.health === "unhealthy") container.running = false;
            }
            if (id === OLD_ID && options.oldFailsDuringSettle && containers.get(CANDIDATE_ID)?.health === "healthy") {
                if (options.oldFailsDuringSettle === "stopped") container.running = false;
                if (options.oldFailsDuringSettle === "unhealthy") container.health = "unhealthy";
                if (options.oldFailsDuringSettle === "no-healthcheck") container.health = null;
            }
            return {
                id: container.id,
                status: container.running ? "running" : "exited",
                running: container.running,
                health: container.health,
                imageRef: "ghcr.io/example/app:1.2.3",
                imageId: container.imageId,
                created: container.created,
                labels: { ...container.labels },
                mountDestinations: [],
            };
        },
        imageId: async () => IMAGE_ID,
        stop: async (id) => {
            calls.push(`stop:${id.slice(0, 1)}`);
            if ((options.stopUnconfirmed ?? false) && id === OLD_ID) return result(options.stopCode ?? 1, true);
            if ((options.stopCode ?? 0) !== 0 && id === OLD_ID) return result(options.stopCode ?? 1);
            const container = containers.get(id);
            if (container) container.running = false;
            return result(0);
        },
        remove: async (id) => {
            calls.push(`remove:${id.slice(0, 1)}`);
            if ((options.removeUnconfirmed ?? false) && id === OLD_ID) return result(options.removeCode ?? 1, true);
            if ((options.removeCode ?? 0) !== 0 && id === OLD_ID) return result(options.removeCode ?? 1);
            containers.delete(id);
            return result(0);
        },
        markDrain: async (id) => {
            calls.push(`mark:${id.slice(0, 1)}`);
            if ((options.markCode ?? 0) !== 0) return result(options.markCode ?? 1, options.markUnconfirmed);
            if (options.markUnconfirmed) return result(1, true);
            if (options.unhealthyAfterMark !== false) {
                const container = containers.get(id);
                if (container) container.health = "unhealthy";
            }
            return result(0);
        },
        sleep: async (ms) => {
            clock += ms;
        },
        now: () => clock,
        isShuttingDown: () => options.shutdown?.() ?? false,
    };

    const messages: string[] = [];
    const input: RolloutInput = {
        target: { project: "demo", composeFile: "/opt/stacks/demo/compose.yaml", cwd: "/opt/stacks/demo" },
        service: "web",
        pull: options.pull ?? false,
        operationTimeoutMs: 10_000,
        rolloutTimeoutMs: 60_000,
        onOutput: (chunk) => messages.push(chunk),
        prepare: async () => ({
            ok: true,
            preparation: {
                oldContainerId: OLD_ID,
                declaration: declaration(options.declaration),
                image: "ghcr.io/example/app:1.2.3",
            },
        }),
    };

    return { deps, input, calls, containers, messages };
}

function result(code: number, terminationUnconfirmed?: boolean): CommandResult {
    return {
        code,
        stdout: "",
        stderr: "",
        timedOut: false,
        truncated: false,
        ...(terminationUnconfirmed ? { terminationUnconfirmed: true } : {}),
    };
}

function isIntervention(value: unknown): boolean {
    return typeof value === "object" && value !== null && "intervention" in value;
}

describe("runRollout nominal paths", () => {
    test("pulls, starts a second instance, drains the old one, then stops and removes it", async () => {
        const w = world({
            pull: true,
            declaration: { drainFile: "/tmp/drain", settleSeconds: 1, drainTimeSeconds: 2 },
        });
        const outcome = await runRollout(w.deps, w.input);
        expect(outcome).toEqual(result(0));
        expect(w.calls).toEqual(["pull", "scale", "mark:a", "stop:a", "remove:a"]);
        expect(w.containers.has(OLD_ID)).toBe(false);
        expect(w.containers.get(CANDIDATE_ID)?.health).toBe("healthy");
        expect(w.messages.join("")).toContain("Rollout completed");
    });

    test("supports a marker-less rollout", async () => {
        const w = world();
        const outcome = await runRollout(w.deps, w.input);
        expect(outcome).toEqual(result(0));
        expect(w.calls).toEqual(["scale", "stop:a", "remove:a"]);
        expect(w.containers.has(OLD_ID)).toBe(false);
    });

    test("honors a custom stop timeout and passes it through", async () => {
        const w = world({ declaration: { stopTimeoutSeconds: 12 } });
        const seen: number[] = [];
        const original = w.deps.stop;
        w.deps.stop = (id, seconds, onOutput, timeoutMs) => {
            seen.push(seconds);
            return original(id, seconds, onOutput, timeoutMs);
        };
        await runRollout(w.deps, w.input);
        expect(seen).toEqual([12]);
    });

    test("a refused locked preflight runs nothing", async () => {
        const w = world();
        w.input.prepare = async () => ({ ok: false, reason: "not eligible" });
        expect(await runRollout(w.deps, w.input)).toEqual({ refused: "not eligible" });
        expect(w.calls).toEqual([]);
    });
});

describe("runRollout failures before the boundary", () => {
    test("a failed pull starts nothing", async () => {
        const w = world({ pull: true, pullCode: 1 });
        const outcome = await runRollout(w.deps, w.input);
        expect(outcome).toEqual(result(1));
        expect(w.calls).toEqual(["pull"]);
        expect(w.containers.has(OLD_ID)).toBe(true);
    });

    test("an unconfirmed pull is unknown and nothing is removed", async () => {
        const w = world({ pull: true, pullUnconfirmed: true });
        const outcome = await runRollout(w.deps, w.input);
        expect("terminationUnconfirmed" in outcome && outcome.terminationUnconfirmed).toBe(true);
        expect(w.calls).toEqual(["pull"]);
    });

    test("a failed scale that created a verified candidate cleans it up", async () => {
        const w = world({ scaleCode: 1 });
        const outcome = await runRollout(w.deps, w.input);
        expect(outcome).toEqual(result(1));
        expect(w.calls).toEqual(["scale", "stop:b", "remove:b"]);
        expect(w.containers.has(OLD_ID)).toBe(true);
        expect(w.containers.has(CANDIDATE_ID)).toBe(false);
    });

    test("a candidate with an unproven identity is never removed", async () => {
        const w = world({ scaleCode: 1, candidateLabels: labels("web", "other-project") });
        const outcome = await runRollout(w.deps, w.input);
        expect(isIntervention(outcome)).toBe(true);
        expect(w.calls).toEqual(["scale"]);
        expect(w.containers.has(CANDIDATE_ID)).toBe(true);
        expect(w.containers.has(OLD_ID)).toBe(true);
    });

    test("a candidate created before the operation is never removed", async () => {
        const w = world({
            scaleCode: 1,
            candidateCreated: new Date(START - 60_000).toISOString(),
        });
        const outcome = await runRollout(w.deps, w.input);
        expect(isIntervention(outcome)).toBe(true);
        expect(w.calls).toEqual(["scale"]);
        expect(w.containers.has(CANDIDATE_ID)).toBe(true);
    });

    test("an unconfirmed scale is unknown and nothing is removed", async () => {
        const w = world({ scaleUnconfirmed: true });
        const outcome = await runRollout(w.deps, w.input);
        expect("terminationUnconfirmed" in outcome && outcome.terminationUnconfirmed).toBe(true);
        expect(w.calls).toEqual(["scale"]);
    });

    test("a candidate that never becomes healthy is cleaned up", async () => {
        const w = world({
            candidateHealth: "starting",
            declaration: { timeoutSeconds: 1 },
        });
        const outcome = await runRollout(w.deps, w.input);
        expect(outcome).toEqual(result(1));
        expect(w.calls).toEqual(["scale", "stop:b", "remove:b"]);
        expect(w.containers.has(OLD_ID)).toBe(true);
    });

    test("an unhealthy candidate is cleaned up", async () => {
        const w = world({ candidateHealth: "unhealthy" });
        const outcome = await runRollout(w.deps, w.input);
        expect(outcome).toEqual(result(1));
        expect(w.calls).toEqual(["scale", "stop:b", "remove:b"]);
        expect(w.containers.has(OLD_ID)).toBe(true);
    });

    test("a candidate without a healthcheck is cleaned up", async () => {
        const w = world({ candidateHealth: "none" });
        const outcome = await runRollout(w.deps, w.input);
        expect(outcome).toEqual(result(1));
        expect(w.calls).toEqual(["scale", "stop:b", "remove:b"]);
    });

    test("a candidate running another image is cleaned up", async () => {
        const w = world({ candidateImageId: OTHER_IMAGE_ID });
        const outcome = await runRollout(w.deps, w.input);
        expect(outcome).toEqual(result(1));
        expect(w.calls).toEqual(["scale", "stop:b", "remove:b"]);
    });

    for (const mode of ["stopped", "unhealthy", "no-healthcheck"] as const) {
        test(`keeps a healthy candidate when the old instance becomes unavailable during settle (${mode})`, async () => {
            const w = world({ declaration: { settleSeconds: 1 }, oldFailsDuringSettle: mode });
            const outcome = await runRollout(w.deps, w.input);
            expect(isIntervention(outcome)).toBe(true);
            expect(w.calls).toEqual(["scale"]);
            expect(w.containers.has(OLD_ID)).toBe(true);
            expect(w.containers.get(CANDIDATE_ID)?.running).toBe(true);
            expect(w.containers.get(CANDIDATE_ID)?.health).toBe("healthy");
        });
    }

    test("an unexpected number of containers is ambiguous and removes nothing", async () => {
        const w = world({ createExtra: true, scaleCode: 1 });
        const outcome = await runRollout(w.deps, w.input);
        expect(isIntervention(outcome)).toBe(true);
        expect(w.calls).toEqual(["scale"]);
        expect(w.containers.has(OLD_ID)).toBe(true);
        expect(w.containers.has(CANDIDATE_ID)).toBe(true);
        expect(w.containers.has(OTHER_ID)).toBe(true);
    });

    test("a disappeared old container is never cleaned up automatically", async () => {
        const w = world({ oldGoneOnScale: true });
        const outcome = await runRollout(w.deps, w.input);
        expect(isIntervention(outcome)).toBe(true);
        expect(w.calls).toEqual(["scale"]);
        expect(w.containers.has(CANDIDATE_ID)).toBe(true);
    });

    test("shutdown before the boundary aborts and cleans up", async () => {
        let polls = 0;
        const w = world({
            shutdown: () => {
                polls += 1;
                return polls > 2;
            },
        });
        const outcome = await runRollout(w.deps, w.input);
        expect(outcome).toEqual(result(1));
        expect(w.calls).toEqual(["scale", "stop:b", "remove:b"]);
        expect(w.containers.has(OLD_ID)).toBe(true);
    });
});

describe("runRollout failures at or after the boundary", () => {
    test("a failed mark keeps both instances", async () => {
        const w = world({ declaration: { drainFile: "/tmp/drain" }, markCode: 1 });
        const outcome = await runRollout(w.deps, w.input);
        expect(isIntervention(outcome)).toBe(true);
        expect(w.calls).toEqual(["scale", "mark:a"]);
        expect(w.containers.has(OLD_ID)).toBe(true);
        expect(w.containers.has(CANDIDATE_ID)).toBe(true);
    });

    test("an unconfirmed mark keeps both instances and the lock", async () => {
        const w = world({ declaration: { drainFile: "/tmp/drain" }, markUnconfirmed: true });
        const outcome = await runRollout(w.deps, w.input);
        expect("terminationUnconfirmed" in outcome && outcome.terminationUnconfirmed).toBe(true);
        expect(w.calls).toEqual(["scale", "mark:a"]);
        expect(w.containers.has(CANDIDATE_ID)).toBe(true);
    });

    test("an old container that never reports unhealthy keeps both instances", async () => {
        const w = world({
            declaration: { drainFile: "/tmp/drain", drainDetectSeconds: 2 },
            unhealthyAfterMark: false,
        });
        const outcome = await runRollout(w.deps, w.input);
        expect(isIntervention(outcome)).toBe(true);
        expect(w.calls).toEqual(["scale", "mark:a"]);
        expect(w.containers.has(OLD_ID)).toBe(true);
        expect(w.containers.has(CANDIDATE_ID)).toBe(true);
    });

    test("an exhausted budget during drainage keeps both instances", async () => {
        const w = world({ declaration: { drainFile: "/tmp/drain", drainTimeSeconds: 20 } });
        w.input.rolloutTimeoutMs = 2_000;
        const outcome = await runRollout(w.deps, w.input);
        expect(isIntervention(outcome)).toBe(true);
        expect(w.calls).toEqual(["scale", "mark:a"]);
        expect(w.containers.has(OLD_ID)).toBe(true);
        expect(w.containers.has(CANDIDATE_ID)).toBe(true);
    });

    test("a candidate that dies during drainage keeps both instances", async () => {
        const w = world({
            declaration: { drainFile: "/tmp/drain", drainTimeSeconds: 5 },
            candidateHealth: "dies-during-drain",
        });
        const outcome = await runRollout(w.deps, w.input);
        expect(isIntervention(outcome)).toBe(true);
        expect(w.calls).toEqual(["scale", "mark:a"]);
        expect(w.containers.has(OLD_ID)).toBe(true);
        expect(w.containers.has(CANDIDATE_ID)).toBe(true);
    });

    test("a failed stop keeps the candidate", async () => {
        const w = world({ stopCode: 1 });
        const outcome = await runRollout(w.deps, w.input);
        expect(isIntervention(outcome)).toBe(true);
        expect(w.calls).toEqual(["scale", "stop:a"]);
        expect(w.containers.has(CANDIDATE_ID)).toBe(true);
    });

    test("an unconfirmed stop is unknown and keeps the candidate", async () => {
        const w = world({ stopUnconfirmed: true });
        const outcome = await runRollout(w.deps, w.input);
        expect("terminationUnconfirmed" in outcome && outcome.terminationUnconfirmed).toBe(true);
        expect(w.containers.has(CANDIDATE_ID)).toBe(true);
    });

    test("a failed remove keeps the candidate", async () => {
        const w = world({ removeCode: 1 });
        const outcome = await runRollout(w.deps, w.input);
        expect(isIntervention(outcome)).toBe(true);
        expect(w.calls).toEqual(["scale", "stop:a", "remove:a"]);
        expect(w.containers.has(CANDIDATE_ID)).toBe(true);
    });

    test("a candidate that dies after the old one is removed is an intervention", async () => {
        const w = world({ candidateHealth: "dies-after-remove" });
        const outcome = await runRollout(w.deps, w.input);
        expect(isIntervention(outcome)).toBe(true);
        expect(w.calls).toEqual(["scale", "stop:a", "remove:a"]);
        expect(w.containers.has(OLD_ID)).toBe(false);
        expect(w.containers.has(CANDIDATE_ID)).toBe(true);
    });
});
