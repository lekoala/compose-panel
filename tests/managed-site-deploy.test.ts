import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult } from "../src/docker.ts";
import type { ComposeProjectFiles } from "../src/compose-provider.ts";
import type { GitReleaseResult } from "../src/git-release.ts";
import { revisionScript } from "../src/git-release.ts";
import {
    MANAGED_SITE_PROBE_PATH,
    managedSiteAttemptPath,
    parseDeployAttempt,
    parseProbeAnswer,
    pendingDeployAttempt,
    readBaseline,
    readPendingDeployAttempt,
    runManagedSiteDeploy,
    switchCurrent,
    type ManagedSiteDeployAttempt,
    type ManagedSiteDeployDependencies,
    type ManagedSiteDeployResult,
    type ManagedSiteProbe,
    type ProbeAnswer,
} from "../src/managed-site-deploy.ts";
import type { ManagedSiteComposeFacts, ManagedSiteServiceFact } from "../src/managed-site-profile.ts";
import type { ManagedSiteManifest } from "../src/managed-site.ts";

const PRIOR = "a".repeat(40);
const NEW = "b".repeat(40);
const OTHER = "c".repeat(40);
const WEB = "1".repeat(64);
const PHP = "2".repeat(64);
const PHP2 = "3".repeat(64);
const PHP3 = "4".repeat(64);
const IMAGE_ID = `sha256:${"a".repeat(64)}`;
const IMAGE_REF = "php:8.3-fpm-alpine";

const MANIFEST: ManagedSiteManifest = {
    version: 1,
    siteId: "acme-shop",
    owner: "opt-in",
    project: "acme-shop",
    services: { gateway: "web", runtime: "php" },
    publicRoot: "public",
    runtime: { profile: "php-front-controller" },
    deploy: { kind: "bind-mount", git: { url: "https://github.com/acme/shop.git", ref: "refs/heads/main" } },
};

function ok(overrides: Partial<CommandResult> = {}): CommandResult {
    return { code: 0, stdout: "", stderr: "", timedOut: false, truncated: false, ...overrides };
}

function service(overrides: Partial<ManagedSiteServiceFact> = {}): ManagedSiteServiceFact {
    return {
        image: null,
        build: false,
        networkMode: null,
        ports: [],
        mounts: [],
        tmpfs: [],
        volumesFrom: [],
        networks: ["default"],
        ...overrides,
    };
}

function facts(): ManagedSiteComposeFacts {
    return {
        name: "acme-shop",
        services: new Map([
            [
                "web",
                service({
                    image: "nginx:alpine",
                    ports: [{ hostIp: "127.0.0.1", published: 18080, target: 80, protocol: "tcp" }],
                }),
            ],
            ["php", service({ image: IMAGE_REF })],
        ]),
        externalNetworks: [],
    };
}

function containerJson(id: string, image: string, imageId: string, withPort = false): string {
    return JSON.stringify([
        {
            Id: id,
            Image: imageId,
            Config: { Image: image },
            State: { Running: true, Status: "running" },
            NetworkSettings: withPort ? { Ports: { "80/tcp": [{ HostIp: "127.0.0.1", HostPort: "18080" }] } } : { Ports: {} },
        },
    ]);
}

interface HarnessOptions {
    stop?: CommandResult;
    start?: CommandResult;
    recreate?: CommandResult;
    localImageId?: string | null;
    recreateChangesId?: boolean;
    recreatedImageId?: string;
    probeFor?: (target: string) => string | null;
    probeDown?: boolean;
    profileRefused?: string;
    manifestRefused?: string;
    fetch?: (input: { manifest: ManagedSiteManifest; attemptId: string; onOutput: (chunk: string) => void }) => Promise<GitReleaseResult>;
    shutdown?: () => boolean;
    withPort?: boolean;
    switchPointer?: (runtimeDir: string, releaseId: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
}

interface Harness {
    stack: string;
    deps: ManagedSiteDeployDependencies;
    calls: string[];
    fetchCount: () => number;
    switchedWhileRunning: () => boolean;
}

async function makeStack(): Promise<string> {
    const stack = await mkdtemp(join(tmpdir(), "cp-deploy-"));
    const runtime = join(stack, "site", "runtime");
    await mkdir(join(runtime, "releases", PRIOR, "public"), { recursive: true });
    await mkdir(join(runtime, "releases", PRIOR, ".compose-panel"), { recursive: true });
    await mkdir(join(stack, "site", "private", "releases"), { recursive: true, mode: 0o700 });
    await mkdir(join(stack, "site", "staging"), { recursive: true, mode: 0o700 });
    await writeFile(join(runtime, "releases", PRIOR, "public", "index.php"), "<?php\n");
    await writeFile(join(runtime, "releases", PRIOR, ".compose-panel", "revision.php"), revisionScript(PRIOR));
    await writeFile(
        join(stack, "site", "private", "releases", `${PRIOR}.json`),
        `${JSON.stringify({ version: 1, siteId: "acme-shop", release: PRIOR, status: "complete" })}\n`,
    );
    await writeFile(join(stack, "site", "runtime", "pointer"), PRIOR);
    return stack;
}

/** Test-only pointer: a file holding the current SHA, not a symlink. */
async function readPointer(stack: string): Promise<string> {
    return (await Bun.file(join(stack, "site", "runtime", "pointer")).text()).trim();
}

async function writePointer(stack: string, sha: string): Promise<void> {
    await writeFile(join(stack, "site", "runtime", "pointer"), sha);
}

async function publish(stack: string, sha: string): Promise<void> {
    const release = join(stack, "site", "runtime", "releases", sha);
    await mkdir(join(release, "public"), { recursive: true });
    await mkdir(join(release, ".compose-panel"), { recursive: true });
    await writeFile(join(release, "public", "index.php"), "<?php\n");
    await writeFile(join(release, ".compose-panel", "revision.php"), revisionScript(sha));
    await writeFile(
        join(stack, "site", "private", "releases", `${sha}.json`),
        `${JSON.stringify({ version: 1, siteId: "acme-shop", release: sha, status: "complete" })}\n`,
    );
}

function files(stack: string): ComposeProjectFiles {
    return { project: "acme-shop", cwd: stack, composeFiles: [join(stack, "compose.yaml")], envFiles: [] };
}

function makeHarness(stack: string, options: HarnessOptions = {}): Harness {
    const calls: string[] = [];
    const running = new Map<string, string[]>([
        ["web", [WEB]],
        ["php", [PHP]],
    ]);
    const details = new Map<string, string>([
        [WEB, containerJson(WEB, "nginx:alpine", "sha256:" + "1".repeat(64), options.withPort !== false)],
        [PHP, containerJson(PHP, IMAGE_REF, IMAGE_ID)],
        [PHP2, containerJson(PHP2, IMAGE_REF, options.recreatedImageId ?? IMAGE_ID)],
        [PHP3, containerJson(PHP3, IMAGE_REF, options.recreatedImageId ?? IMAGE_ID)],
    ]);
    let fetchCount = 0;
    let recreateCount = 0;
    let switchedWhileRunning = false;

    const provider = {
        async runningContainerIds(input: { service: string }) {
            calls.push(`ps:${input.service}`);
            return [...(running.get(input.service) ?? [])];
        },
        async inspectImages(refs: string[]) {
            calls.push(`image:${refs[0]}`);
            const id = options.localImageId === undefined ? IMAGE_ID : options.localImageId;
            return ok({ stdout: id === null ? "[]" : JSON.stringify([{ Id: id }]) });
        },
        async stopService(input: { service: string }) {
            calls.push(`stop:${input.service}`);
            const result = options.stop ?? ok();
            if (result.code === 0 && !result.timedOut) running.set(input.service, []);
            return result;
        },
        async startService(input: { service: string }) {
            calls.push(`start:${input.service}`);
            const result = options.start ?? ok();
            if (result.code === 0 && !result.timedOut) running.set(input.service, [WEB]);
            return result;
        },
        async recreateService(input: { service: string; force?: boolean }) {
            calls.push(`recreate:${input.service}:${input.force === true ? "force" : "plain"}`);
            const result = options.recreate ?? ok();
            if (result.code === 0 && !result.timedOut) {
                if (options.recreateChangesId === false) {
                    running.set(input.service, [PHP]);
                } else {
                    recreateCount++;
                    running.set(input.service, [recreateCount === 1 ? PHP2 : PHP3]);
                }
            }
            return result;
        },
    };

    const inspector = {
        async inspect(id: string) {
            calls.push(`inspect:${id}`);
            const body = details.get(id);
            return body ? ok({ stdout: body }) : ok({ code: 1 });
        },
    };

    const probe: ManagedSiteProbe = async (port): Promise<ProbeAnswer | null> => {
        calls.push(`probe:${port}`);
        if (options.probeDown) return null;
        const sha = await readPointer(stack).catch(() => null);
        if (!sha) return { status: 500, body: "" };
        const served = options.probeFor ? options.probeFor(sha) : sha;
        if (served === null) return null;
        return { status: 200, body: `${served}\n` };
    };

    const fetchRelease = async (input: { manifest: ManagedSiteManifest; attemptId: string; onOutput: (chunk: string) => void }) => {
        fetchCount++;
        if (options.fetch) return options.fetch(input);
        if (!(await readdir(join(stack, "site", "runtime", "releases"))).includes(NEW)) await publish(stack, NEW);
        return {
            ok: true as const,
            releaseId: NEW,
            releasePath: join(stack, "site", "runtime", "releases", NEW),
            metadataPath: join(stack, "site", "private", "releases", `${NEW}.json`),
            reused: false,
        };
    };

    let clock = 0;
    const deps: ManagedSiteDeployDependencies = {
        stackDir: stack,
        attemptId: "attemptdeploy01",
        loadManifest: async () =>
            options.manifestRefused ? { ok: false, reason: options.manifestRefused } : { ok: true, manifest: MANIFEST },
        inspectProfile: async () => (options.profileRefused ? { ok: false, reason: options.profileRefused } : { ok: true, facts: facts() }),
        provider,
        inspector,
        files: () => files(stack),
        fetchRelease,
        probe,
        now: () => clock,
        sleep: async (ms) => {
            clock += ms;
        },
        isShuttingDown: options.shutdown ?? (() => false),
        onOutput: () => {},
        commandTimeoutMs: 60_000,
        readBaseline: async () => {
            const releaseId = await readPointer(stack);
            const releasePath = join(stack, "site", "runtime", "releases", releaseId);
            return (await readdir(releasePath).then(
                () => true,
                () => false,
            ))
                ? { ok: true, releaseId, releasePath }
                : { ok: false, reason: "The release is missing." };
        },
        switchPointer: async (_runtimeDir, releaseId) => {
            calls.push(`switch:${releaseId}`);
            if ((running.get("web") ?? []).length > 0) switchedWhileRunning = true;
            if (options.switchPointer) return options.switchPointer(_runtimeDir, releaseId);
            await writePointer(stack, releaseId);
            return { ok: true };
        },
        readPointerTarget: async () => `releases/${await readPointer(stack)}`,
    };
    return { stack, deps, calls, fetchCount: () => fetchCount, switchedWhileRunning: () => switchedWhileRunning };
}

async function currentTarget(stack: string): Promise<string> {
    return `releases/${await readPointer(stack)}`;
}

async function deploy(harness: Harness): Promise<ManagedSiteDeployResult> {
    return runManagedSiteDeploy(harness.deps);
}

describe("parseProbeAnswer", () => {
    test("accepts exactly 40 lowercase hex and one newline", () => {
        expect(parseProbeAnswer(200, `${PRIOR}\n`)).toBe(PRIOR);
        expect(parseProbeAnswer(200, PRIOR)).toBeNull();
        expect(parseProbeAnswer(200, `${PRIOR}\r\n`)).toBeNull();
        expect(parseProbeAnswer(200, `${PRIOR}\nextra`)).toBeNull();
        expect(parseProbeAnswer(200, `${PRIOR.toUpperCase()}\n`)).toBeNull();
        expect(parseProbeAnswer(200, `${"a".repeat(41)}\n`)).toBeNull();
        expect(parseProbeAnswer(500, `${PRIOR}\n`)).toBeNull();
    });

    test("names the fixed probe path", () => {
        expect(MANAGED_SITE_PROBE_PATH).toBe("/.compose-panel/revision");
    });
});

/** Real-symlink fixture; the managed layout only exists on Linux in production. */
async function makeSymlinkStack(): Promise<string> {
    const stack = await makeStack();
    await symlink(`releases/${PRIOR}`, join(stack, "site", "runtime", "current"));
    return stack;
}

describe.skipIf(process.platform !== "linux")("readBaseline", () => {
    test("accepts a relative pointer with complete metadata and revision script", async () => {
        const stack = await makeSymlinkStack();
        expect(await readBaseline(stack, "acme-shop")).toEqual({
            ok: true,
            releaseId: PRIOR,
            releasePath: join(stack, "site", "runtime", "releases", PRIOR),
        });
    });

    test("refuses a missing, absolute or unexpected pointer", async () => {
        const stack = await makeSymlinkStack();
        const current = join(stack, "site", "runtime", "current");
        await rm(current);

        expect((await readBaseline(stack, "acme-shop")).ok).toBe(false);
        await symlink(`releases/${PRIOR}`, current);
        await rm(current);
        await symlink(join(stack, "site", "runtime", "releases", PRIOR), current);
        expect((await readBaseline(stack, "acme-shop")).ok).toBe(false);
        await rm(current);
        await symlink("releases/not-a-sha", current);
        expect((await readBaseline(stack, "acme-shop")).ok).toBe(false);
    });

    test("refuses metadata bound to another site or SHA, and a missing release", async () => {
        const stack = await makeSymlinkStack();
        const metadata = join(stack, "site", "private", "releases", `${PRIOR}.json`);
        await writeFile(metadata, JSON.stringify({ version: 1, siteId: "other", release: PRIOR, status: "complete" }));
        expect((await readBaseline(stack, "acme-shop")).ok).toBe(false);

        await writeFile(metadata, JSON.stringify({ version: 1, siteId: "acme-shop", release: OTHER, status: "complete" }));
        expect((await readBaseline(stack, "acme-shop")).ok).toBe(false);

        await writeFile(metadata, JSON.stringify({ version: 1, siteId: "acme-shop", release: PRIOR, status: "complete" }));
        await rm(join(stack, "site", "runtime", "releases", PRIOR, ".compose-panel", "revision.php"));
        expect((await readBaseline(stack, "acme-shop")).ok).toBe(false);
    });
});

describe.skipIf(process.platform !== "linux")("switchCurrent", () => {
    test("replaces the pointer atomically with a relative target and leaves no temp link", async () => {
        const stack = await makeSymlinkStack();
        const runtime = join(stack, "site", "runtime");
        expect((await switchCurrent(runtime, NEW)).ok).toBe(true);
        expect(await readlink(join(runtime, "current"))).toBe(`releases/${NEW}`);
        expect((await readdir(runtime)).filter((name) => name.startsWith(".current-"))).toEqual([]);
        expect((await switchCurrent(runtime, PRIOR)).ok).toBe(true);
        expect(await readlink(join(runtime, "current"))).toBe(`releases/${PRIOR}`);
    });
});

describe("pendingDeployAttempt", () => {
    test("reports any existing marker, including an unexpected entry", async () => {
        const stack = await makeStack();
        expect(await pendingDeployAttempt(stack)).toBe(false);
        const marker = managedSiteAttemptPath(stack);
        await writeFile(marker, "{}\n");
        expect(await pendingDeployAttempt(stack)).toBe(true);
        await rm(marker);
        await mkdir(marker);
        expect(await pendingDeployAttempt(stack)).toBe(true);
    });
});

describe("parseDeployAttempt", () => {
    const valid: ManagedSiteDeployAttempt = {
        version: 1,
        siteId: "acme-shop",
        attemptId: "attempt0001",
        release: PRIOR,
        prior: NEW,
        phase: "switch",
        outcome: "pending",
    };

    test("accepts the bounded attempt record", () => {
        expect(parseDeployAttempt(JSON.stringify(valid))).toEqual(valid);
    });

    test("refuses a wrong version, phase, outcome, id or extra field", () => {
        for (const value of [
            { ...valid, version: 2 },
            { ...valid, phase: "unknown" },
            { ...valid, outcome: "done" },
            { ...valid, attemptId: "short" },
            { ...valid, release: "abc" },
            { ...valid, prior: NEW.toUpperCase() },
            { ...valid, siteId: "" },
            { ...valid, extra: true },
        ]) {
            expect(parseDeployAttempt(JSON.stringify(value))).toBeNull();
        }
        expect(parseDeployAttempt("not json")).toBeNull();
    });

    test("distinguishes none, pending and unreadable markers", async () => {
        const stack = await makeStack();
        expect(await readPendingDeployAttempt(stack)).toEqual({ kind: "none" });
        const marker = managedSiteAttemptPath(stack);
        await writeFile(marker, JSON.stringify(valid));
        expect(await readPendingDeployAttempt(stack)).toEqual({ kind: "pending", attempt: valid });
        await writeFile(marker, "not json");
        expect((await readPendingDeployAttempt(stack)).kind).toBe("unreadable");
    });
});

describe("runManagedSiteDeploy", () => {
    test("deploys a new SHA in the documented order and removes the attempt marker", async () => {
        const harness = makeHarness(await makeStack());
        const result = await deploy(harness);

        expect(result).toEqual({ kind: "deployed", releaseId: NEW, priorReleaseId: PRIOR });
        const actions = harness.calls.filter(
            (call) => !call.startsWith("ps:") && !call.startsWith("inspect:") && !call.startsWith("image:") && !call.startsWith("probe:"),
        );
        expect(actions).toEqual(["stop:web", `switch:${NEW}`, "recreate:php:force", "start:web"]);
        expect(await currentTarget(harness.stack)).toBe(`releases/${NEW}`);
        expect(await pendingDeployAttempt(harness.stack)).toBe(false);
    });

    test("is a no-op only when the pointer and probe already prove the fetched SHA", async () => {
        const harness = makeHarness(await makeStack(), {
            fetch: async () => ({
                ok: true,
                releaseId: PRIOR,
                releasePath: "",
                metadataPath: "",
                reused: true,
            }),
        });
        const result = await deploy(harness);
        expect(result).toEqual({ kind: "noop", releaseId: PRIOR });
        expect(harness.calls.some((call) => call.startsWith("stop:"))).toBe(false);
        expect(await currentTarget(harness.stack)).toBe(`releases/${PRIOR}`);
    });

    test("refuses a CI request whose ref tip moved, before any serving change", async () => {
        const harness = makeHarness(await makeStack());
        harness.deps.expectedReleaseId = PRIOR;
        const result = await deploy(harness);
        expect(result.kind).toBe("refused");
        if (result.kind !== "refused") return;
        expect(result.reason).toContain(PRIOR);
        expect(result.reason).toContain(NEW);
        expect(harness.calls.some((call) => call.startsWith("stop:"))).toBe(false);
        expect(await currentTarget(harness.stack)).toBe(`releases/${PRIOR}`);
        expect(await pendingDeployAttempt(harness.stack)).toBe(false);
    });

    test("deploys the requested SHA when the ref tip matches", async () => {
        const harness = makeHarness(await makeStack());
        harness.deps.expectedReleaseId = NEW;
        const result = await deploy(harness);
        expect(result).toEqual({ kind: "deployed", releaseId: NEW, priorReleaseId: PRIOR });
    });

    test("passes the shutdown signal to the fetch and stops before any serving change", async () => {
        const harness = makeHarness(await makeStack());
        const controller = new AbortController();
        let observed: AbortSignal | undefined;
        harness.deps.signal = controller.signal;
        harness.deps.fetchRelease = async (input) => {
            observed = input.signal;
            controller.abort();
            return { ok: false, phase: "fetch", reason: "The build was cancelled.", unconfirmed: false, cleanup: "removed" };
        };
        const result = await deploy(harness);
        expect(observed).toBe(controller.signal);
        expect(result.kind).toBe("failed");
        expect(harness.calls.some((call) => call.startsWith("stop:"))).toBe(false);
        expect(await currentTarget(harness.stack)).toBe(`releases/${PRIOR}`);
    });

    test("refuses before fetching when the baseline probe disagrees", async () => {
        const harness = makeHarness(await makeStack(), { probeFor: () => OTHER });
        const result = await deploy(harness);
        expect(result.kind).toBe("refused");
        expect(harness.fetchCount()).toBe(0);
        expect(harness.calls.some((call) => call.startsWith("stop:"))).toBe(false);
    });

    test("refuses when the runtime image reference no longer resolves to the running image", async () => {
        const harness = makeHarness(await makeStack(), { localImageId: `sha256:${"b".repeat(64)}` });
        const result = await deploy(harness);
        expect(result.kind).toBe("refused");
        if (result.kind !== "refused") return;
        expect(result.reason).toContain("image");
        expect(harness.fetchCount()).toBe(0);
    });

    test("refuses when the profile, manifest or gateway binding no longer matches", async () => {
        const profile = await deploy(makeHarness(await makeStack(), { profileRefused: "mount drift" }));
        expect(profile.kind).toBe("refused");

        const manifest = await deploy(makeHarness(await makeStack(), { manifestRefused: "invalid manifest" }));
        expect(manifest.kind).toBe("refused");

        const port = await deploy(makeHarness(await makeStack(), { withPort: false }));
        expect(port.kind).toBe("refused");
    });

    test("reports a failed fetch without stopping the site or writing a marker", async () => {
        const harness = makeHarness(await makeStack(), {
            fetch: async () => ({
                ok: false,
                phase: "fetch",
                reason: "The branch does not exist.",
                unconfirmed: false,
                cleanup: "removed",
            }),
        });
        const result = await deploy(harness);
        expect(result.kind).toBe("failed");
        expect(harness.calls.some((call) => call.startsWith("stop:"))).toBe(false);
        expect(await pendingDeployAttempt(harness.stack)).toBe(false);
        expect(await currentTarget(harness.stack)).toBe(`releases/${PRIOR}`);
    });

    test("reports an unconfirmed fetch as unknown", async () => {
        const harness = makeHarness(await makeStack(), {
            fetch: async () => ({ ok: false, phase: "fetch", reason: "fetch", unconfirmed: true, cleanup: "kept" }),
        });
        const result = await deploy(harness);
        expect(result.kind).toBe("unknown");
    });

    test("clears the marker when a failed stop left the gateway serving the baseline", async () => {
        const harness = makeHarness(await makeStack(), { stop: ok({ code: 1 }) });
        const result = await deploy(harness);
        expect(result.kind).toBe("failed");
        expect(await currentTarget(harness.stack)).toBe(`releases/${PRIOR}`);
        expect(await pendingDeployAttempt(harness.stack)).toBe(false);
    });

    test("restores the gateway and clears the marker when the switch fails with the baseline still current", async () => {
        const harness = makeHarness(await makeStack(), {
            switchPointer: async () => ({ ok: false, reason: "The pointer switch failed." }),
        });
        const result = await deploy(harness);
        expect(result.kind).toBe("failed");
        expect(await currentTarget(harness.stack)).toBe(`releases/${PRIOR}`);
        expect(harness.calls).toContain("start:web");
        expect(await pendingDeployAttempt(harness.stack)).toBe(false);
    });

    test("keeps the marker when an exception after the stop leaves the gateway down", async () => {
        const harness = makeHarness(await makeStack(), {
            switchPointer: async () => {
                throw new Error("unexpected pointer failure");
            },
            start: ok({ code: 1 }),
        });
        const result = await deploy(harness);
        expect(result.kind).toBe("intervention");
        expect(await currentTarget(harness.stack)).toBe(`releases/${PRIOR}`);
        expect(await pendingDeployAttempt(harness.stack)).toBe(true);
    });

    test("reports an unconfirmed stop as unknown and keeps the marker", async () => {
        const harness = makeHarness(await makeStack(), { stop: ok({ code: -1, timedOut: true, terminationUnconfirmed: true }) });
        const result = await deploy(harness);
        expect(result.kind).toBe("unknown");
        expect(await currentTarget(harness.stack)).toBe(`releases/${PRIOR}`);
        expect(await pendingDeployAttempt(harness.stack)).toBe(true);
    });

    test("refuses to switch when Docker still reports the gateway running", async () => {
        const stack = await makeStack();
        const harness = makeHarness(stack, { stop: ok() });
        // Report the gateway as running even after a successful stop command.
        const original = harness.deps.provider.runningContainerIds.bind(harness.deps.provider);
        harness.deps.provider.runningContainerIds = async (input) => {
            if (input.service === "web" && harness.calls.some((call) => call === "stop:web")) return [WEB];
            return original(input);
        };
        const result = await deploy(harness);
        expect(result.kind).toBe("failed");
        expect(await currentTarget(stack)).toBe(`releases/${PRIOR}`);
        expect(await pendingDeployAttempt(stack)).toBe(false);
    });

    test("keeps the new pointer and requires inspection when the runtime is not recreated", async () => {
        const harness = makeHarness(await makeStack(), { recreate: ok({ code: 1 }) });
        const result = await deploy(harness);
        expect(result.kind).toBe("intervention");
        expect(await currentTarget(harness.stack)).toBe(`releases/${NEW}`);
        expect(await pendingDeployAttempt(harness.stack)).toBe(true);
    });

    test("requires inspection instead of recreating when the image tag moved during the deploy", async () => {
        const harness = makeHarness(await makeStack());
        let calls = 0;
        harness.deps.provider.inspectImages = async () =>
            ok({ stdout: JSON.stringify([{ Id: calls++ === 0 ? IMAGE_ID : `sha256:${"b".repeat(64)}` }]) });
        const result = await deploy(harness);
        expect(result.kind).toBe("intervention");
        expect(harness.calls.some((call) => call.startsWith("recreate:"))).toBe(false);
        expect(await currentTarget(harness.stack)).toBe(`releases/${NEW}`);
        expect(await pendingDeployAttempt(harness.stack)).toBe(true);
    });

    test("does not treat a repeated SHA as a no-op when the pointer changed during the fetch", async () => {
        const harness = makeHarness(await makeStack(), {
            fetch: async () => ({ ok: true, releaseId: PRIOR, releasePath: "", metadataPath: "", reused: true }),
        });
        let reads = 0;
        harness.deps.readBaseline = async () => {
            reads++;
            const releaseId = reads === 1 ? PRIOR : OTHER;
            return { ok: true, releaseId, releasePath: join(harness.stack, "site", "runtime", "releases", releaseId) };
        };
        const result = await deploy(harness);
        expect(result.kind).toBe("refused");
        expect(harness.calls.some((call) => call.startsWith("stop:"))).toBe(false);
    });

    test("requires inspection when the recreated runtime image ID changed", async () => {
        const harness = makeHarness(await makeStack(), { recreatedImageId: `sha256:${"b".repeat(64)}` });
        const result = await deploy(harness);
        expect(result.kind).toBe("intervention");
        expect(await pendingDeployAttempt(harness.stack)).toBe(true);
    });

    test("requires inspection when the runtime container ID does not change", async () => {
        const harness = makeHarness(await makeStack(), { recreateChangesId: false });
        const result = await deploy(harness);
        expect(result.kind).toBe("intervention");
        expect(await currentTarget(harness.stack)).toBe(`releases/${NEW}`);
        expect(await pendingDeployAttempt(harness.stack)).toBe(true);
    });

    test("requires inspection when the gateway does not start", async () => {
        const harness = makeHarness(await makeStack(), { start: ok({ code: 1 }) });
        const result = await deploy(harness);
        expect(result.kind).toBe("intervention");
        expect(await currentTarget(harness.stack)).toBe(`releases/${NEW}`);
        expect(await pendingDeployAttempt(harness.stack)).toBe(true);
    });

    test("rolls back to the verified baseline when the probe serves the wrong SHA", async () => {
        const harness = makeHarness(await makeStack(), {
            probeFor: (target) => (target === NEW ? OTHER : target),
        });
        const result = await deploy(harness);
        expect(result).toEqual({ kind: "rolled-back", releaseId: NEW, priorReleaseId: PRIOR, servedReleaseId: PRIOR });
        expect(await currentTarget(harness.stack)).toBe(`releases/${PRIOR}`);
        expect(harness.calls.filter((call) => call === "recreate:php:force")).toHaveLength(2);
        expect(harness.calls.filter((call) => call === "stop:web")).toHaveLength(2);
        expect(harness.switchedWhileRunning()).toBe(false);
        expect(await pendingDeployAttempt(harness.stack)).toBe(false);
    });

    test("keeps the marker when the rollback probe does not confirm the baseline", async () => {
        const harness = makeHarness(await makeStack());
        // The first two probes of the baseline (verification and post-fetch
        // recheck) succeed; the rollback probe answers a different SHA.
        let priorProbes = 0;
        harness.deps.probe = async () => {
            const sha = await readPointer(harness.stack);
            if (sha === PRIOR) {
                priorProbes++;
                return { status: 200, body: `${priorProbes <= 2 ? PRIOR : OTHER}\n` };
            }
            return { status: 200, body: `${OTHER}\n` };
        };
        const result = await deploy(harness);
        expect(result.kind).toBe("intervention");
        expect(await currentTarget(harness.stack)).toBe(`releases/${PRIOR}`);
        expect(await pendingDeployAttempt(harness.stack)).toBe(true);
    });

    test("stops before any serving change when the attempt record cannot be written", async () => {
        const stack = await makeStack();
        // A non-empty directory at the marker path makes the rename fail.
        const marker = managedSiteAttemptPath(stack);
        await mkdir(marker);
        await writeFile(join(marker, "occupied"), "x");
        const harness = makeHarness(stack);
        const result = await deploy(harness);
        expect(result.kind).toBe("failed");
        expect(harness.calls.some((call) => call.startsWith("stop:"))).toBe(false);
        expect(await currentTarget(stack)).toBe(`releases/${PRIOR}`);
    });

    test("refuses to stop when the panel starts shutting down after the fetch", async () => {
        const stack = await makeStack();
        let fetched = false;
        const harness = makeHarness(stack, {
            fetch: async () => {
                fetched = true;
                await publish(stack, NEW);
                return { ok: true, releaseId: NEW, releasePath: "", metadataPath: "", reused: false };
            },
            shutdown: () => fetched,
        });
        const result = await deploy(harness);
        expect(result.kind).toBe("failed");
        expect(harness.calls.some((call) => call.startsWith("stop:"))).toBe(false);
    });
});
