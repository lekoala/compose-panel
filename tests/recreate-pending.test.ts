import { describe, expect, test } from "bun:test";
import type { CommandResult, DockerRunner } from "../src/docker.ts";
import { createComposeProvider, hashesResolveEnvironment, parseConfigHashes, type ComposeProvider } from "../src/compose-provider.ts";
import { parseContainerConfigStates, type ComposeService } from "../src/compose-state.ts";
import { loadRecreatePending } from "../src/recreate-pending.ts";
import { operationControls, servicesSection } from "../src/html.ts";

const H1 = "1".repeat(64);
const H2 = "2".repeat(64);
const result = (stdout: string, code = 0): CommandResult => ({ code, stdout, stderr: "", timedOut: false, truncated: false });
const input = { project: "demo", composeFile: "/stacks/demo/compose.yaml", cwd: "/stacks/demo" };

function service(name: string, replica = 1): ComposeService {
    return { name, state: "running", health: null, exitCode: 0, container: `demo-${name}-${replica}`, image: "alpine:3" };
}

function inspectRecord(container: string, serviceName: string, hash: unknown, host: Record<string, unknown> = {}): unknown {
    return { Name: `/${container}`, Config: { Labels: { "com.docker.compose.service": serviceName, "com.docker.compose.config-hash": hash, "org.opencontainers.image.description": "a, b" } }, HostConfig: { NetworkMode: "bridge", IpcMode: "private", PidMode: "", VolumesFrom: null, ...host } };
}

function fakeProvider(options: { hashes: Map<string, string> | null; inspect: unknown[]; inspectCode?: number; configHashes?: boolean; calls?: string[] }): ComposeProvider {
    const base = createComposeProvider({ runner: async () => result("") });
    const caps = { ...base.capabilities(), available: true, configHashes: options.configHashes ?? true };
    return {
        ...base,
        capabilities: () => caps,
        serviceConfigHashes: async () => { options.calls?.push("hash"); return options.hashes; },
        inspectContainers: async () => { options.calls?.push("inspect"); return result(JSON.stringify(options.inspect), options.inspectCode ?? 0); },
    };
}

describe("Compose version gate (ADR 0032)", () => {
    test("accepts 5.5.0 and later, including prefixed and suffixed versions", () => {
        for (const version of ["5.5.0", "5.6.0\n", "v5.5.1", "5.10.0", "6.0.0", "5.6.0-desktop.1"]) expect(hashesResolveEnvironment(version)).toBe(true);
    });

    test("refuses older or unparsable versions", () => {
        for (const version of ["5.4.9", "2.40.3", "v2.39.4", "", "Docker Compose version v5.6.0", "5.6"]) expect(hashesResolveEnvironment(version)).toBe(false);
    });

    test("detect probes the short version and enables hashes only when validated", async () => {
        const calls: string[][] = [];
        const runner = (stdout: string): DockerRunner => async args => { calls.push(args); return result(stdout); };
        expect((await createComposeProvider({ runner: runner("5.6.0\n") }).detect()).configHashes).toBe(true);
        expect(calls[0]).toEqual(["compose", "version", "--short"]);
        expect((await createComposeProvider({ runner: runner("2.39.4\n") }).detect()).configHashes).toBe(false);
        expect((await createComposeProvider({ runner: async () => result("5.6.0", 1) }).detect()).configHashes).toBe(false);
    });
});

describe("serviceConfigHashes", () => {
    test("runs config --hash in the stack's explicit project context", async () => {
        const calls: { args: string[]; options?: Parameters<DockerRunner>[1] }[] = [];
        const provider = createComposeProvider({ runner: async (args, options) => {
            calls.push({ args, options });
            return result(args.includes("version") ? "5.6.0" : `app ${H1}\n`);
        } });
        await provider.detect();
        const hashes = await provider.serviceConfigHashes({ ...input, envFile: "/stacks/demo/.env" });
        expect(hashes).toEqual(new Map([["app", H1]]));
        expect(calls[1]!.args).toEqual(["compose", "-p", "demo", "--env-file", "/stacks/demo/.env", "--project-directory", "/stacks/demo", "-f", "/stacks/demo/compose.yaml", "config", "--hash", "*"]);
        await provider.serviceConfigHashes(input);
        expect(calls[2]!.options?.env?.COMPOSE_DISABLE_ENV_FILE).toBe("true");
    });

    test("never calls Compose when the version is not validated", async () => {
        const calls: string[][] = [];
        const provider = createComposeProvider({ runner: async args => { calls.push(args); return result(args.includes("version") ? "5.4.0" : `app ${H1}`); } });
        await provider.detect();
        expect(await provider.serviceConfigHashes(input)).toBeNull();
        expect(calls).toHaveLength(1);
    });

    test("returns nothing on failure, truncation or any unexpected line", async () => {
        for (const answer of [result(`app ${H1}`, 1), { ...result(`app ${H1}`), truncated: true }, { ...result(`app ${H1}`), timedOut: true }]) {
            const provider = createComposeProvider({ runner: async args => args.includes("version") ? result("5.6.0") : answer });
            await provider.detect();
            expect(await provider.serviceConfigHashes(input)).toBeNull();
        }
        expect(parseConfigHashes(`app ${H1}\nWARN TOKEN=secret\n`)).toBeNull();
        expect(parseConfigHashes(`app ${H1}\napp ${H2}\n`)).toBeNull();
        expect(parseConfigHashes(`-x ${H1}\n`)).toBeNull();
        expect(parseConfigHashes(`app ${H1.slice(1)}\n`)).toBeNull();
        expect(parseConfigHashes(`\napp ${H1}\nweb ${H2}\n`)).toEqual(new Map([["app", H1], ["web", H2]]));
    });
});

describe("parseContainerConfigStates", () => {
    test("reads the service and hash labels from structured labels, even when other values contain commas", () => {
        const states = parseContainerConfigStates(JSON.stringify([inspectRecord("demo-app-1", "app", H1)]));
        expect(states.get("demo-app-1")).toEqual({ service: "app", configHash: H1, sharesContainer: false });
    });

    test("drops a malformed hash", () => {
        for (const hash of ["A".repeat(64), `${H1},x`, 42, undefined]) {
            expect(parseContainerConfigStates(JSON.stringify([inspectRecord("demo-app-1", "app", hash)])).get("demo-app-1")?.configHash).toBeNull();
        }
    });

    test("flags containers that share another container's namespaces or volumes", () => {
        for (const host of [{ NetworkMode: "container:abc" }, { IpcMode: "container:abc" }, { PidMode: "container:abc" }, { VolumesFrom: ["abc"] }]) {
            expect(parseContainerConfigStates(JSON.stringify([inspectRecord("demo-app-1", "app", H1, host)])).get("demo-app-1")?.sharesContainer).toBe(true);
        }
        expect(parseContainerConfigStates(JSON.stringify([inspectRecord("demo-app-1", "app", H1, { IpcMode: "private", PidMode: "", VolumesFrom: null })])).get("demo-app-1")?.sharesContainer).toBe(false);
    });

    test("cannot rule out sharing when HostConfig is missing or malformed", () => {
        const missing = { Name: "/demo-app-1", Config: { Labels: { "com.docker.compose.service": "app", "com.docker.compose.config-hash": H1 } } };
        expect(parseContainerConfigStates(JSON.stringify([missing])).get("demo-app-1")?.sharesContainer).toBeNull();
        for (const host of [{ NetworkMode: 42 }, { IpcMode: undefined }, { PidMode: null }, { VolumesFrom: "parent" }, { VolumesFrom: [7] }]) {
            expect(parseContainerConfigStates(JSON.stringify([inspectRecord("demo-app-1", "app", H1, host)])).get("demo-app-1")?.sharesContainer).toBeNull();
        }
    });
});

describe("loadRecreatePending", () => {
    test("reports only the services whose container hash differs", async () => {
        const provider = fakeProvider({
            hashes: new Map([["app", H2], ["db", H1]]),
            inspect: [inspectRecord("demo-app-1", "app", H1), inspectRecord("demo-db-1", "db", H1)],
        });
        expect(await loadRecreatePending(provider, input, [service("app"), service("db")])).toEqual(["app"]);
    });

    test("one outdated replica makes the service pending", async () => {
        const provider = fakeProvider({
            hashes: new Map([["web", H1]]),
            inspect: [inspectRecord("demo-web-1", "web", H1), inspectRecord("demo-web-2", "web", H2)],
        });
        expect(await loadRecreatePending(provider, input, [service("web", 1), service("web", 2)])).toEqual(["web"]);
    });

    test("a service that cannot be compared on every container gets no marker", async () => {
        const provider = fakeProvider({
            hashes: new Map([["web", H1], ["sidecar", H1], ["other", H1]]),
            inspect: [
                inspectRecord("demo-web-1", "web", H2),
                inspectRecord("demo-web-2", "web", "bogus"),
                inspectRecord("demo-sidecar-1", "sidecar", H2, { NetworkMode: "container:0123" }),
                inspectRecord("demo-other-1", "not-other", H2),
            ],
        });
        expect(await loadRecreatePending(provider, input, [service("web", 1), service("web", 2), service("sidecar"), service("other"), service("gone")])).toEqual([]);
    });

    test("incomplete container data leaves the service undetermined", async () => {
        const hashes = new Map([["app", H2]]);
        const noHost = { Name: "/demo-app-1", Config: { Labels: { "com.docker.compose.service": "app", "com.docker.compose.config-hash": H1 } } };
        expect(await loadRecreatePending(fakeProvider({ hashes, inspect: [noHost] }), input, [service("app")])).toEqual([]);
        const badModes = inspectRecord("demo-app-1", "app", H1, { NetworkMode: null, PidMode: 1 });
        expect(await loadRecreatePending(fakeProvider({ hashes, inspect: [badModes] }), input, [service("app")])).toEqual([]);
        // One replica without a container name: the others alone prove nothing.
        const anonymous: ComposeService = { ...service("app", 2), container: null };
        expect(await loadRecreatePending(fakeProvider({ hashes, inspect: [inspectRecord("demo-app-1", "app", H1)] }), input, [service("app"), anonymous])).toEqual([]);
    });

    test("never invents a state when Docker fails or the version is not validated", async () => {
        const inspect = [inspectRecord("demo-app-1", "app", H1)];
        expect(await loadRecreatePending(fakeProvider({ hashes: null, inspect }), input, [service("app")])).toEqual([]);
        expect(await loadRecreatePending(fakeProvider({ hashes: new Map([["app", H2]]), inspect, inspectCode: 1 }), input, [service("app")])).toEqual([]);
        const throwing: ComposeProvider = { ...fakeProvider({ hashes: null, inspect }), serviceConfigHashes: async () => { throw new Error("boom"); } };
        expect(await loadRecreatePending(throwing, input, [service("app")])).toEqual([]);
        const calls: string[] = [];
        expect(await loadRecreatePending(fakeProvider({ hashes: new Map([["app", H2]]), inspect, configHashes: false, calls }), input, [service("app")])).toEqual([]);
        expect(calls).toEqual([]);
    });
});

describe("rendering", () => {
    const actions = { name: "demo", csrf: "token", busy: false };

    test("marks only pending services, next to their scoped actions", () => {
        const html = servicesSection([service("app"), service("db")], "running", {}, actions, ["app"]);
        expect(html.match(/data-recreate-pending/g)).toHaveLength(1);
        const appRow = html.split("<tr>").find(row => row.startsWith("<td>app</td>"))!;
        expect(appRow).toContain("data-recreate-pending");
    });

    test("shows nothing when no scoped action is offered", () => {
        expect(servicesSection([service("app")], "unknown", {}, actions, ["app"])).not.toContain("data-recreate-pending");
    });

    test("the Actions card mentions pending services next to image updates", () => {
        const withPending = operationControls("demo", "token", { busy: false, state: "running", recreatePending: ["app"] });
        const without = operationControls("demo", "token", { busy: false, state: "running" });
        expect(withPending.split("note-info").length).toBe(without.split("note-info").length + 1);
        const both = operationControls("demo", "token", { busy: false, state: "running", updatesReady: ["db"], recreatePending: ["app"] });
        expect(both.split("note-info").length).toBe(without.split("note-info").length + 2);
    });
});
