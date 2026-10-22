import type { CommandResult, DockerRunner } from "../../src/docker.ts";
import { createComposeProvider } from "../../src/compose-provider.ts";
import { SelfUpdater, UPDATER_LABEL, UPDATER_NAME, type ReleaseLookup, type ReleaseSource } from "../../src/self-update.ts";

/**
 * A scripted Docker for the self-update (ADR 0018): the panel container, its
 * image tag before and after a pull, and the updater container. No process is
 * spawned; every call is recorded.
 */
export const PANEL_ID = "a".repeat(64);
export const OLD_IMAGE = `sha256:${"1".repeat(64)}`;
export const NEW_IMAGE = `sha256:${"2".repeat(64)}`;
export const IMAGE_REF = "ghcr.io/lekoala/compose-panel:latest";
export const WORKING_DIR = "/srv/compose-panel/deploy";
export const COMPOSE_FILE = `${WORKING_DIR}/compose.yaml`;
export const MOUNTINFO = `1234 1200 8:1 /var/lib/docker/containers/${PANEL_ID}/hostname /etc/hostname rw,relatime - ext4 /dev/sda1 rw\n`;

export function panelInspect(
    overrides: {
        labels?: Record<string, string>;
        config?: Record<string, unknown>;
        mounts?: unknown[];
        hostConfig?: Record<string, unknown>;
    } = {},
): string {
    return JSON.stringify([
        {
            Id: PANEL_ID,
            Image: OLD_IMAGE,
            Config: {
                Image: IMAGE_REF,
                User: "",
                Labels: {
                    "com.docker.compose.project": "compose-panel",
                    "com.docker.compose.service": "panel",
                    "com.docker.compose.project.working_dir": WORKING_DIR,
                    "com.docker.compose.project.config_files": COMPOSE_FILE,
                    "com.docker.compose.oneoff": "False",
                    ...overrides.labels,
                },
                ...overrides.config,
            },
            HostConfig: { GroupAdd: null, ...overrides.hostConfig },
            Mounts: overrides.mounts ?? [{ Type: "bind", Source: "/var/run/docker.sock", Destination: "/var/run/docker.sock" }],
        },
    ]);
}

function image(id: string, tags: string[], version: string, digests = [`ghcr.io/lekoala/compose-panel@sha256:${id.slice(7, 71)}`]) {
    return {
        Id: id,
        RepoTags: tags,
        RepoDigests: digests,
        Created: "2026-10-01T10:00:00Z",
        Config: {
            Labels: {
                "org.opencontainers.image.version": version,
                "org.opencontainers.image.source": "https://github.com/lekoala/compose-panel",
            },
        },
    };
}

export interface FakeDocker {
    runner: DockerRunner;
    calls: string[][];
    /** The tag points to the new image (as after a successful pull). */
    pulled: boolean;
    /** Updater container state, or null when none exists. */
    updater: { status: string; exitCode: number; foreign?: boolean; labels?: Record<string, string> } | null;
    pullResult: CommandResult;
    runResult: CommandResult;
    inspectOutput: string;
    localBuild: boolean;
    imageInspectFails: boolean;
    /** The daemon starts the updater even though `container run` fails (client timeout). */
    startsOnFailure: boolean;
    /** `State.Error` of the updater (a failed start leaves it `created`). */
    updaterError: string;
    /** `container wait` fails at once instead of blocking. */
    waitFails: boolean;
    /** `container inspect` of the updater fails once `container run` was called. */
    inspectFailsAfterRun: boolean;
    /** Resolves pending `container wait` calls. */
    finishWait: () => void;
}

const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "", timedOut: false, truncated: false });

export function fakeDocker(): FakeDocker {
    let release: () => void = () => {};
    const waiting = new Promise<void>((resolve) => {
        release = resolve;
    });
    const docker: FakeDocker = {
        calls: [],
        pulled: false,
        updater: null,
        pullResult: ok(),
        runResult: ok("f".repeat(64)),
        inspectOutput: panelInspect(),
        localBuild: false,
        imageInspectFails: false,
        startsOnFailure: false,
        updaterError: "",
        waitFails: false,
        inspectFailsAfterRun: false,
        finishWait: () => release(),
        runner: async (args) => {
            docker.calls.push(args);
            const key = args.slice(0, 2).join(" ");
            if (key === "container inspect" && args[3] === PANEL_ID) return ok(docker.inspectOutput);
            if (key === "container inspect" && args[3] === UPDATER_NAME) {
                if (docker.inspectFailsAfterRun && docker.calls.some((call) => call[1] === "run")) {
                    return { code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon", timedOut: false, truncated: false };
                }
                if (!docker.updater)
                    return {
                        code: 1,
                        stdout: "[]",
                        stderr: `Error: No such container: ${UPDATER_NAME}`,
                        timedOut: false,
                        truncated: false,
                    };
                const labels = docker.updater.foreign ? {} : { [UPDATER_LABEL]: "1", ...docker.updater.labels };
                return ok(
                    JSON.stringify([
                        {
                            Config: { Labels: labels },
                            State: {
                                Status: docker.updater.status,
                                Error: docker.updaterError,
                                ExitCode: docker.updater.exitCode,
                                StartedAt: "2026-10-12T08:00:00Z",
                                FinishedAt: "2026-10-12T08:01:00Z",
                            },
                        },
                    ]),
                );
            }
            if (key === "image inspect") {
                if (docker.imageInspectFails)
                    return { code: 1, stdout: "[]", stderr: "Error: daemon unavailable", timedOut: false, truncated: false };
                const digests = docker.localBuild ? [] : undefined;
                const old = image(OLD_IMAGE, docker.pulled ? [] : [IMAGE_REF], "0.2.0", digests);
                const next = image(NEW_IMAGE, [IMAGE_REF], "0.3.0", digests);
                return ok(JSON.stringify(docker.pulled ? [old, next] : [old]));
            }
            if (key === "image pull") {
                if (docker.pullResult.code === 0) docker.pulled = true;
                return docker.pullResult;
            }
            if (key === "image tag") return ok();
            if (key === "container rm") {
                docker.updater = null;
                return ok();
            }
            if (key === "container run") {
                if (docker.runResult.code === 0 || docker.startsOnFailure) docker.updater = { status: "running", exitCode: 0 };
                return docker.runResult;
            }
            if (key === "container wait") {
                if (docker.waitFails)
                    return { code: 1, stdout: "", stderr: "Error response from daemon", timedOut: false, truncated: false };
                await waiting;
                return ok("0");
            }
            if (key === "container logs") return ok("08:00 Updating Compose project compose-panel\n<b>not markup</b>\n");
            return { code: 1, stdout: "", stderr: `unexpected call: ${args.join(" ")}`, timedOut: false, truncated: false };
        },
    };
    return docker;
}

/** Fixed clock for the 72-hour waiting period. */
export const NOW = Date.parse("2026-10-12T12:00:00Z");
/** What the release of NEW_IMAGE publishes, as found in its RepoDigests. */
export const NEW_DIGEST = `ghcr.io/lekoala/compose-panel@sha256:${"2".repeat(64)}`;

/** A GitHub release of 0.3.0 published four days before NOW, recording NEW_DIGEST. */
export function releaseJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        tag_name: "0.3.0",
        draft: false,
        prerelease: false,
        created_at: "2026-10-01T00:00:00Z",
        published_at: "2026-10-08T12:00:00Z",
        body: `Image: \`ghcr.io/lekoala/compose-panel:0.3.0\`\n\ncompose-panel-image-digest: sha256:${"2".repeat(64)}\n\nCommit: abc\n`,
        ...overrides,
    };
}

export interface FakeReleases {
    source: ReleaseSource;
    /** Versions asked, in order. */
    calls: string[];
    lookup: ReleaseLookup;
}

export function registryJson() {
    return {
        schema: 1,
        releases: [{ version: "0.3.0", digest: `sha256:${"2".repeat(64)}`, revision: "a".repeat(40), recordedAt: "2026-10-08T12:00:00Z" }],
    };
}

export function fakeReleases(
    lookup: ReleaseLookup | { kind: "found"; release: unknown } = { kind: "found", release: releaseJson(), registry: registryJson() },
): FakeReleases {
    const releases: FakeReleases = {
        calls: [],
        lookup: lookup.kind === "found" && !("registry" in lookup) ? { ...lookup, registry: registryJson() } : (lookup as ReleaseLookup),
        source: async (version) => {
            releases.calls.push(version);
            return releases.lookup;
        },
    };
    return releases;
}

export function fakeSelfUpdater(
    docker: FakeDocker,
    mountinfo: string | null = MOUNTINFO,
    releases: FakeReleases = fakeReleases(),
): SelfUpdater {
    return new SelfUpdater({
        runner: docker.runner,
        provider: createComposeProvider({ runner: docker.runner }),
        readMountinfo: async () => mountinfo,
        releases: releases.source,
        now: () => NOW,
        sleep: () => Bun.sleep(1),
        pullTimeoutMs: 1000,
        maxBytes: 1024 * 1024,
    });
}
