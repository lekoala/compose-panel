import { describe, expect, test } from "bun:test";
import type { CommandResult, DockerRunner } from "../src/docker.ts";
import { createComposeProvider, type ComposeProvider } from "../src/compose-provider.ts";
import {
    SelfUpdateError,
    UPDATER_EXIT,
    UPDATER_LABEL,
    UPDATER_NAME,
    containerIdFromMountinfo,
    parseSelfInspect,
    parseUpdaterInspect,
    ROLLBACK_TAG,
    evaluateRelease,
    githubReleaseSource,
    recoveryCommands,
    rollbackCommands,
    shellQuote,
    updaterCommand,
    updaterRunArgs,
    type SelfIdentity,
} from "../src/self-update.ts";
import { parseUpdaterArgs, runSelfUpdate, type UpdaterDeps } from "../src/self-update-run.ts";
import { COMPOSE_FILE, IMAGE_REF, MOUNTINFO, NEW_DIGEST, NEW_IMAGE, NOW, OLD_IMAGE, PANEL_ID, WORKING_DIR, fakeDocker, fakeReleases, fakeSelfUpdater, panelInspect, releaseJson } from "./helpers/self-update.ts";

const PLAN = { targetImageId: NEW_IMAGE, expectedDigest: NEW_DIGEST, targetVersion: "0.3.0", previousVersion: "0.2.0" };

function identityOf(stdout = panelInspect()): SelfIdentity {
    const support = parseSelfInspect(stdout, PANEL_ID);
    if (support.kind !== "ready") throw new Error(support.reason);
    return support.identity;
}

describe("own container detection", () => {
    test("reads the container ID from the hostname bind mount", () => {
        expect(containerIdFromMountinfo(MOUNTINFO)).toBe(PANEL_ID);
        const custom = `55 40 0:50 /data/docker/containers/${PANEL_ID}/resolv.conf /etc/resolv.conf rw - ext4 /dev/vda rw\n`;
        expect(containerIdFromMountinfo(custom)).toBe(PANEL_ID);
    });

    test("finds nothing outside a container", () => {
        expect(containerIdFromMountinfo("22 1 8:1 / / rw,relatime - ext4 /dev/sda1 rw\n")).toBeNull();
        expect(containerIdFromMountinfo(`1 1 8:1 /containers/${"a".repeat(12)}/hostname /etc/hostname rw - ext4 x rw`)).toBeNull();
    });
});

describe("parseSelfInspect", () => {
    test("accepts the documented deployment", () => {
        const identity = identityOf();
        expect(identity).toMatchObject({
            containerId: PANEL_ID,
            imageId: OLD_IMAGE,
            imageRef: IMAGE_REF,
            project: "compose-panel",
            service: "panel",
            workingDir: WORKING_DIR,
            composeFiles: [COMPOSE_FILE],
            envFiles: [],
            socketSource: "/var/run/docker.sock",
            user: null,
            groupAdd: [],
        });
    });

    test("keeps several Compose and env files in order, plus user and groups", () => {
        const identity = identityOf(panelInspect({
            labels: {
                "com.docker.compose.project.config_files": `${COMPOSE_FILE},${WORKING_DIR}/override.yaml`,
                "com.docker.compose.project.environment_file": `${WORKING_DIR}/.env`,
            },
            config: { User: "1000:1000" },
            hostConfig: { GroupAdd: ["998"] },
        }));
        expect(identity.composeFiles).toEqual([COMPOSE_FILE, `${WORKING_DIR}/override.yaml`]);
        expect(identity.envFiles).toEqual([`${WORKING_DIR}/.env`]);
        expect(identity.user).toBe("1000:1000");
        expect(identity.groupAdd).toEqual(["998"]);
    });

    const refused: [string, Parameters<typeof panelInspect>[0]][] = [
        ["not started by Compose", { labels: { "com.docker.compose.project": "" } }],
        ["a one-off container", { labels: { "com.docker.compose.oneoff": "True" } }],
        ["an image pinned by digest", { config: { Image: `${IMAGE_REF}@sha256:${"3".repeat(64)}` } }],
        ["an image ID as reference", { config: { Image: OLD_IMAGE } }],
        ["a relative working directory", { labels: { "com.docker.compose.project.working_dir": "deploy" } }],
        ["a dot-dot working directory", { labels: { "com.docker.compose.project.working_dir": "/srv/../etc" } }],
        ["a Compose file outside the deployment", { labels: { "com.docker.compose.project.config_files": "/etc/compose.yaml" } }],
        ["an env file outside the deployment", { labels: { "com.docker.compose.project.environment_file": "/root/.env" } }],
        ["a path that breaks --mount", { labels: { "com.docker.compose.project.working_dir": "/srv/a,b" } }],
        ["no socket mount", { mounts: [] }],
        ["a socket volume instead of a bind", { mounts: [{ Type: "volume", Source: "/x", Destination: "/var/run/docker.sock" }] }],
        ["an odd user", { config: { User: "root --privileged" } }],
        ["an odd group", { hostConfig: { GroupAdd: ["docker;rm"] } }],
        ["an odd service name", { labels: { "com.docker.compose.service": "-panel" } }],
    ];
    for (const [name, overrides] of refused) {
        test(`refuses ${name}`, () => {
            expect(parseSelfInspect(panelInspect(overrides), PANEL_ID).kind).toBe("unsupported");
        });
    }

    test("refuses another container's description and unreadable output", () => {
        expect(parseSelfInspect(panelInspect(), "b".repeat(64)).kind).toBe("unsupported");
        expect(parseSelfInspect("not json", PANEL_ID).kind).toBe("unsupported");
    });
});

describe("updater container arguments", () => {
    test("runs the current image with no network, the socket and a read-only deployment", () => {
        const identity = identityOf(panelInspect({ config: { User: "1000" }, hostConfig: { GroupAdd: ["998"] } }));
        const args = updaterRunArgs(identity, PLAN);
        expect(args.slice(0, 3)).toEqual(["container", "run", "--detach"]);
        const pairs = new Map<string, string[]>();
        for (let index = 3; index < args.indexOf(OLD_IMAGE); index += 2) {
            pairs.set(args[index]!, [...pairs.get(args[index]!) ?? [], args[index + 1]!]);
        }
        expect(pairs.get("--name")).toEqual([UPDATER_NAME]);
        // The previous and target identities travel as labels, read back after the restart.
        expect(pairs.get("--label")).toEqual([
            `${UPDATER_LABEL}=1`,
            `${UPDATER_LABEL}.previous-image=${OLD_IMAGE}`,
            `${UPDATER_LABEL}.previous-version=0.2.0`,
            `${UPDATER_LABEL}.target-image=${NEW_IMAGE}`,
            `${UPDATER_LABEL}.target-version=0.3.0`,
        ]);
        expect(pairs.get("--network")).toEqual(["none"]);
        expect(pairs.get("--mount")).toEqual([
            "type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock",
            `type=bind,source=${WORKING_DIR},target=${WORKING_DIR},readonly`,
        ]);
        expect(pairs.get("--entrypoint")).toEqual(["bun"]);
        expect(pairs.get("--user")).toEqual(["1000"]);
        expect(pairs.get("--group-add")).toEqual(["998"]);
        // The image the panel runs now starts the updater, never the target.
        const imageAt = args.indexOf(OLD_IMAGE);
        expect(args.slice(imageAt + 1)).toEqual(["src/scripts/self-update.ts", ...updaterCommand(identity, PLAN)]);
        expect(args.some(arg => /^(sh|bash)$/.test(arg) || arg === "-c")).toBe(false);
    });

    test("refuses a target that is not an image ID", () => {
        expect(() => updaterRunArgs(identityOf(), { ...PLAN, targetImageId: "latest" })).toThrow(SelfUpdateError);
        expect(() => updaterRunArgs(identityOf(), { ...PLAN, expectedDigest: "ghcr.io/x:latest" })).toThrow(SelfUpdateError);
    });

    test("the updater parses exactly what the panel builds", () => {
        const identity = identityOf(panelInspect({ labels: { "com.docker.compose.project.environment_file": `${WORKING_DIR}/.env` } }));
        expect(parseUpdaterArgs(updaterCommand(identity, PLAN))).toEqual({
            panelContainer: PANEL_ID,
            imageRef: IMAGE_REF,
            targetImage: NEW_IMAGE,
            expectedDigest: NEW_DIGEST,
            previousImage: OLD_IMAGE,
            project: "compose-panel",
            service: "panel",
            workingDir: WORKING_DIR,
            composeFiles: [COMPOSE_FILE],
            envFiles: [`${WORKING_DIR}/.env`],
        });
    });

    test("the updater refuses unknown, repeated or invalid arguments", () => {
        const good = updaterCommand(identityOf(), PLAN);
        expect(() => parseUpdaterArgs([...good, "--privileged", "1"])).toThrow();
        expect(() => parseUpdaterArgs([...good, "--project", "other"])).toThrow();
        expect(() => parseUpdaterArgs(good.slice(0, -1))).toThrow();
        const swap = (flag: string, value: string) => {
            const copy = [...good];
            copy[copy.indexOf(flag) + 1] = value;
            return copy;
        };
        expect(() => parseUpdaterArgs(swap("--compose-file", "/etc/compose.yaml"))).toThrow();
        expect(() => parseUpdaterArgs(swap("--target-image", "latest"))).toThrow();
        expect(() => parseUpdaterArgs(swap("--image-ref", `${IMAGE_REF}@sha256:${"3".repeat(64)}`))).toThrow();
        expect(() => parseUpdaterArgs(swap("--working-dir", "/srv/../etc"))).toThrow();
    });
});

describe("recovery commands", () => {
    const target = {
        imageRef: IMAGE_REF,
        workingDir: "/srv/my panel/deploy",
        project: "compose-panel",
        service: "panel",
        composeFiles: ["/srv/my panel/deploy/compose.yaml"],
        envFiles: [],
    };

    test("quote paths with spaces so they can be pasted", () => {
        expect(recoveryCommands(target)).toEqual([
            "cd '/srv/my panel/deploy'",
            "docker compose -p compose-panel -f '/srv/my panel/deploy/compose.yaml' pull panel",
            "docker compose -p compose-panel -f '/srv/my panel/deploy/compose.yaml' up -d --no-deps panel",
        ]);
        expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    });

    test("the updater logs the same commands as the About page", async () => {
        const args = parseUpdaterArgs(updaterCommand(identityOf(panelInspect({
            labels: {
                "com.docker.compose.project.working_dir": target.workingDir,
                "com.docker.compose.project.config_files": target.composeFiles[0]!,
            },
        })), PLAN));
        const lines: string[] = [];
        const provider = { serviceImage: async () => IMAGE_REF, recreateService: async () => ({ code: 1, stdout: "", stderr: "", timedOut: false, truncated: false }) } as unknown as ComposeProvider;
        const code = await runSelfUpdate(args, {
            runner: async command => ({ code: 0, stdout: command[1] === "inspect" ? JSON.stringify([{ Id: NEW_IMAGE, RepoDigests: [NEW_DIGEST] }]) : "", stderr: "", timedOut: false, truncated: false }),
            provider,
            log: line => lines.push(line.trim()),
            write: () => {},
            fileExists: async () => false,
            sleep: async () => {},
            now: () => 0,
        });
        expect(code).toBe(UPDATER_EXIT.failed);
        const at = (commands: string[]) => lines.indexOf(commands[0]!);
        expect(lines.slice(at(recoveryCommands(target)), at(recoveryCommands(target)) + 3)).toEqual(recoveryCommands(target));
        expect(lines.slice(at(rollbackCommands(target)), at(rollbackCommands(target)) + 3)).toEqual(rollbackCommands(target));
    });
});

describe("parseUpdaterInspect", () => {
    const inspect = (state: Record<string, unknown>, labels: Record<string, string> = { [UPDATER_LABEL]: "1" }) =>
        JSON.stringify([{ Config: { Labels: labels }, State: { StartedAt: "2026-10-12T08:00:00Z", FinishedAt: "2026-10-12T08:01:00Z", ...state } }]);

    test("maps exit codes to outcomes", () => {
        const outcome = (state: Record<string, unknown>) => {
            const lookup = parseUpdaterInspect(inspect(state));
            return lookup.kind === "run" ? lookup.run.outcome : lookup.kind;
        };
        expect(outcome({ Status: "running", ExitCode: 0 })).toBe("running");
        expect(outcome({ Status: "exited", ExitCode: UPDATER_EXIT.updated })).toBe("updated");
        expect(outcome({ Status: "exited", ExitCode: UPDATER_EXIT.refused })).toBe("refused");
        expect(outcome({ Status: "exited", ExitCode: UPDATER_EXIT.failed })).toBe("failed");
        expect(outcome({ Status: "exited", ExitCode: 137 })).toBe("failed");
        expect(outcome({ Status: "dead", ExitCode: 0 })).toBe("failed");
    });

    test("a same-named container without the label is foreign", () => {
        expect(parseUpdaterInspect(inspect({ Status: "exited", ExitCode: 0 }, {})).kind).toBe("foreign");
        expect(parseUpdaterInspect("[]").kind).toBe("none");
    });

    test("a running updater has no end time", () => {
        const lookup = parseUpdaterInspect(inspect({ Status: "running", ExitCode: 0 }));
        expect(lookup.kind === "run" && lookup.run.finishedAt).toBeNull();
    });
});

describe("SelfUpdater", () => {
    test("is unavailable outside a container, without calling Docker", async () => {
        const docker = fakeDocker();
        const support = await fakeSelfUpdater(docker, null).identify();
        expect(support.kind).toBe("unsupported");
        expect(docker.calls).toEqual([]);
    });

    test("fails closed when Docker cannot describe the panel image", async () => {
        const docker = fakeDocker();
        docker.imageInspectFails = true;
        expect((await fakeSelfUpdater(docker).identify()).kind).toBe("unsupported");
    });

    test("is unavailable for a locally built image", async () => {
        const docker = fakeDocker();
        docker.localBuild = true;
        expect((await fakeSelfUpdater(docker).identify()).kind).toBe("unsupported");
    });

    test("an update is ready only once the tag points to another image", async () => {
        const docker = fakeDocker();
        const updater = fakeSelfUpdater(docker);
        const before = await updater.status();
        expect(before.support.kind).toBe("ready");
        expect(before.current?.version).toBe("0.2.0");
        expect(before.available).toBeNull();

        if (before.support.kind !== "ready") throw new Error("not ready");
        expect((await updater.pull(before.support.identity)).code).toBe(0);
        expect(docker.calls).toContainEqual(["image", "pull", "--quiet", "--", IMAGE_REF]);
        const after = await updater.status();
        expect(after.available?.imageId).toBe(NEW_IMAGE);
        expect(after.available?.version.version).toBe("0.3.0");
        expect(after.available?.link?.href).toBe("https://github.com/lekoala/compose-panel/releases");
    });

    test("launch removes a finished updater first", async () => {
        const docker = fakeDocker();
        docker.updater = { status: "exited", exitCode: 0 };
        await fakeSelfUpdater(docker).launch(identityOf(), PLAN);
        const verbs = docker.calls.map(args => args.slice(0, 2).join(" "));
        expect(verbs).toEqual(["container inspect", "container rm", "container run"]);
        expect(docker.calls[1]).toEqual(["container", "rm", "--", UPDATER_NAME]);
    });

    test("launch refuses a running updater and never touches a foreign container", async () => {
        const docker = fakeDocker();
        docker.updater = { status: "running", exitCode: 0 };
        await expect(fakeSelfUpdater(docker).launch(identityOf(), PLAN)).rejects.toThrow(SelfUpdateError);
        docker.updater = { status: "exited", exitCode: 0, foreign: true };
        await expect(fakeSelfUpdater(docker).launch(identityOf(), PLAN)).rejects.toThrow(SelfUpdateError);
        expect(docker.calls.some(args => args[1] === "rm" || args[1] === "run")).toBe(false);
    });

    test("launch reports a Docker refusal", async () => {
        const docker = fakeDocker();
        docker.runResult = { code: 125, stdout: "", stderr: "docker: Error response from daemon: Conflict.\n", timedOut: false, truncated: false };
        await expect(fakeSelfUpdater(docker).launch(identityOf(), PLAN)).rejects.toThrow(/could not start the updater/);
    });
});

describe("compose calls for the self-update", () => {
    function recording(stdout = ""): { runner: DockerRunner; calls: string[][] } {
        const calls: string[][] = [];
        return { calls, runner: async args => { calls.push(args); return { code: 0, stdout, stderr: "", timedOut: false, truncated: false }; } };
    }
    const files = { project: "compose-panel", cwd: WORKING_DIR, composeFiles: [COMPOSE_FILE, `${WORKING_DIR}/b.yaml`], envFiles: [`${WORKING_DIR}/.env`] };

    test("serviceImage returns only the service's image", async () => {
        const { runner, calls } = recording(JSON.stringify({ name: "compose-panel", services: { panel: { image: IMAGE_REF, environment: { SECRET: "x" } } } }));
        const provider = createComposeProvider({ runner });
        expect(await provider.serviceImage({ ...files, service: "panel" })).toBe(IMAGE_REF);
        expect(await provider.serviceImage({ ...files, service: "other" })).toBeNull();
        expect(calls[0]).toEqual([
            "compose", "-p", "compose-panel", "--env-file", `${WORKING_DIR}/.env`, "--project-directory", WORKING_DIR,
            "-f", COMPOSE_FILE, "-f", `${WORKING_DIR}/b.yaml`, "config", "--format", "json",
        ]);
    });

    test("recreateService never pulls, builds or touches dependencies", async () => {
        const { runner, calls } = recording();
        await createComposeProvider({ runner }).recreateService({ ...files, service: "panel" });
        expect(calls[0]).toEqual([
            "compose", "-p", "compose-panel", "--env-file", `${WORKING_DIR}/.env`, "--project-directory", WORKING_DIR,
            "-f", COMPOSE_FILE, "-f", `${WORKING_DIR}/b.yaml`, "up", "-d", "--no-deps", "--no-build", "--pull", "never", "--", "panel",
        ]);
    });
});

describe("runSelfUpdate", () => {
    const args = parseUpdaterArgs(updaterCommand(identityOf(), PLAN));
    const NEW_ID = "c".repeat(64);
    const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "", timedOut: false, truncated: false });

    interface Scenario {
        tag?: string;
        composeImage?: string | null;
        envOnDisk?: boolean;
        upCode?: number;
        containers?: string[];
        state?: { Status: string; Health?: { Status: string }; StartedAt?: string };
        image?: string;
        digests?: string[];
        tagCode?: number;
    }

    function setup(scenario: Scenario = {}) {
        const lines: string[] = [];
        let clock = 0;
        const tagged: string[][] = [];
        let ups = 0;
        const runner: DockerRunner = async command => {
            const key = command.slice(0, 2).join(" ");
            if (key === "image inspect") return ok(JSON.stringify([{ Id: scenario.tag ?? NEW_IMAGE, RepoDigests: scenario.digests ?? [NEW_DIGEST] }]));
            if (key === "image tag") { tagged.push(command); return { ...ok(), code: scenario.tagCode ?? 0 }; }
            if (key === "container ls") return ok(`${(scenario.containers ?? [NEW_ID]).join("\n")}\n`);
            if (key === "container inspect") {
                return ok(JSON.stringify([{
                    Id: NEW_ID,
                    Image: scenario.image ?? NEW_IMAGE,
                    State: { Status: "running", Health: { Status: "healthy" }, StartedAt: "2026-10-12T08:00:30Z", ...scenario.state },
                    Config: { Labels: { "org.opencontainers.image.version": "0.3.0" } },
                }]));
            }
            throw new Error(`unexpected ${command.join(" ")}`);
        };
        const provider = {
            serviceImage: async () => (scenario.composeImage === undefined ? IMAGE_REF : scenario.composeImage),
            recreateService: async () => { ups += 1; return { ...ok(), code: scenario.upCode ?? 0 }; },
        } as unknown as ComposeProvider;
        const deps: UpdaterDeps = {
            runner,
            provider,
            log: line => lines.push(line),
            write: () => {},
            fileExists: async () => scenario.envOnDisk ?? false,
            sleep: async ms => { clock += ms; },
            now: () => clock,
            stableMs: 10_000,
            readyTimeoutMs: 60_000,
        };
        return { deps, lines, tagged, ups: () => ups };
    }

    test("succeeds once the new container is healthy on the target image", async () => {
        const run = setup();
        expect(await runSelfUpdate(args, run.deps)).toBe(UPDATER_EXIT.updated);
        expect(run.ups()).toBe(1);
        // The exact previous image is kept for a rollback before the recreate.
        expect(run.tagged).toEqual([["image", "tag", "--", OLD_IMAGE, ROLLBACK_TAG]]);
        expect(run.lines.some(line => line.includes("0.3.0"))).toBe(true);
        expect(run.lines.some(line => line.includes(`docker image tag ${ROLLBACK_TAG} ${IMAGE_REF}`))).toBe(true);
    });

    test("without a health check, the new container must keep running", async () => {
        const run = setup({ state: { Status: "running", Health: undefined } });
        expect(await runSelfUpdate(args, run.deps)).toBe(UPDATER_EXIT.updated);
    });

    const refusals: [string, Scenario][] = [
        ["the tag moved since the check", { tag: `sha256:${"9".repeat(64)}` }],
        ["an implicit .env would be read", { envOnDisk: true }],
        ["the Compose file now uses another image", { composeImage: "ghcr.io/lekoala/compose-panel:0.1.0" }],
        ["compose config failed", { composeImage: null }],
        ["the approved image lacks the release digest", { digests: [`ghcr.io/lekoala/compose-panel@sha256:${"8".repeat(64)}`] }],
        ["the previous image cannot be kept for a rollback", { tagCode: 1 }],
    ];
    for (const [name, scenario] of refusals) {
        test(`refuses without recreating when ${name}`, async () => {
            const run = setup(scenario);
            expect(await runSelfUpdate(args, run.deps)).toBe(UPDATER_EXIT.refused);
            expect(run.ups()).toBe(0);
        });
    }

    const failures: [string, Scenario][] = [
        ["compose up fails", { upCode: 1 }],
        ["the new container is unhealthy", { state: { Status: "running", Health: { Status: "unhealthy" } } }],
        ["the new container stopped", { state: { Status: "exited" } }],
        ["the container runs another image", { image: OLD_IMAGE }],
        ["Compose kept the old container", { containers: [PANEL_ID] }],
        ["the container never becomes ready", { state: { Status: "running", Health: { Status: "starting" } } }],
    ];
    for (const [name, scenario] of failures) {
        test(`fails with recovery steps when ${name}`, async () => {
            const run = setup(scenario);
            expect(await runSelfUpdate(args, run.deps)).toBe(UPDATER_EXIT.failed);
            expect(run.lines.some(line => line.includes(`cd ${WORKING_DIR}`))).toBe(true);
        });
    }
});

describe("release policy (ADR 0018)", () => {
    const found = (overrides: Record<string, unknown> = {}) => ({ kind: "found" as const, release: releaseJson(overrides) });
    const verdict = (input: Partial<Parameters<typeof evaluateRelease>[0]> = {}) =>
        evaluateRelease({ version: "0.3.0", repoDigests: [NEW_DIGEST], lookup: found(), now: NOW, ...input });

    test("a stable release older than 72 hours whose digest matches is installable", () => {
        expect(verdict()).toEqual({ kind: "installable", version: "0.3.0", expectedDigest: NEW_DIGEST, publishedAt: "2026-10-08T12:00:00Z" });
    });

    test("a younger release waits, counted from published_at", () => {
        const published = "2026-10-11T12:00:00Z";
        const result = verdict({ lookup: found({ published_at: published, created_at: "2026-09-01T00:00:00Z" }) });
        expect(result.kind).toBe("waiting");
        expect(result.kind === "waiting" && result.installableAt).toBe(Date.parse(published) + 72 * 3600 * 1000);
        expect(verdict({ lookup: found({ published_at: published }), now: Date.parse(published) + 72 * 3600 * 1000 }).kind).toBe("installable");
    });

    const refusals: [string, Partial<Parameters<typeof evaluateRelease>[0]>][] = [
        ["no version label", { version: null }],
        ["a non-semver version", { version: "latest" }],
        ["GitHub unreachable", { lookup: { kind: "unavailable" } }],
        ["no such release", { lookup: { kind: "missing" } }],
        ["a prerelease", { lookup: found({ prerelease: true }) }],
        ["a draft", { lookup: found({ draft: true }) }],
        ["another tag", { lookup: found({ tag_name: "0.3.1" }) }],
        ["no publication date", { lookup: found({ published_at: null }) }],
        ["no digest line", { lookup: found({ body: "Release notes only." }) }],
        ["a digest of another image", { repoDigests: [`ghcr.io/lekoala/compose-panel@sha256:${"8".repeat(64)}`] }],
        ["the digest under another repository", { repoDigests: [`ghcr.io/evil/compose-panel@sha256:${"2".repeat(64)}`] }],
    ];
    for (const [name, input] of refusals) {
        test(`refuses ${name}`, () => {
            expect(verdict(input).kind).toBe("refused");
        });
    }

    test("the GitHub source asks the fixed repository, without following redirects", async () => {
        const requests: { url: string; init?: RequestInit }[] = [];
        const reply = (status: number, body = "{}") => async (url: string | URL | Request, init?: RequestInit) => {
            requests.push({ url: String(url), init });
            return new Response(body, { status });
        };
        expect(await githubReleaseSource(reply(200, JSON.stringify(releaseJson())) as typeof fetch)("0.3.0")).toMatchObject({ kind: "found" });
        expect(requests[0]!.url).toBe("https://api.github.com/repos/lekoala/compose-panel/releases/tags/0.3.0");
        expect(requests[0]!.init?.redirect).toBe("error");
        expect(await githubReleaseSource(reply(404) as typeof fetch)("0.3.0")).toEqual({ kind: "missing" });
        expect(await githubReleaseSource(reply(403) as typeof fetch)("0.3.0")).toEqual({ kind: "unavailable" });
        expect(await githubReleaseSource(reply(200, "not json") as typeof fetch)("0.3.0")).toEqual({ kind: "unavailable" });
        const failing = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
        expect(await githubReleaseSource(failing)("0.3.0")).toEqual({ kind: "unavailable" });
        // A version that is not plain semver never reaches the network.
        const before = requests.length;
        expect(await githubReleaseSource(reply(200) as typeof fetch)("../../evil")).toEqual({ kind: "missing" });
        expect(requests.length).toBe(before);
    });

    test("status never asks GitHub; the verdict comes from the last check of that image", async () => {
        const docker = fakeDocker();
        docker.pulled = true;
        const releases = fakeReleases();
        const updater = fakeSelfUpdater(docker, MOUNTINFO, releases);
        const before = await updater.status();
        expect(before.available?.imageId).toBe(NEW_IMAGE);
        expect(before.verdict).toBeNull();
        expect(releases.calls).toEqual([]);

        expect((await updater.verifyRelease(before.available!)).kind).toBe("installable");
        expect(releases.calls).toEqual(["0.3.0"]);
        expect((await updater.status()).verdict?.kind).toBe("installable");
        expect(releases.calls).toEqual(["0.3.0"]);
    });

    test("only the official image is offered", async () => {
        const docker = fakeDocker();
        docker.inspectOutput = panelInspect({ config: { Image: "ghcr.io/someone/compose-panel:latest" } });
        expect((await fakeSelfUpdater(docker).identify()).kind).toBe("unsupported");
    });

    test("the updater labels are read back, and invalid values dropped", () => {
        const lookup = parseUpdaterInspect(JSON.stringify([{
            Config: { Labels: {
                [UPDATER_LABEL]: "1",
                [`${UPDATER_LABEL}.previous-image`]: OLD_IMAGE,
                [`${UPDATER_LABEL}.previous-version`]: "0.2.0",
                [`${UPDATER_LABEL}.target-image`]: "not-an-id",
                [`${UPDATER_LABEL}.target-version`]: "<b>",
            } },
            State: { Status: "exited", ExitCode: 0 },
        }]));
        expect(lookup.kind === "run" && lookup.run).toMatchObject({ previousImage: OLD_IMAGE, previousVersion: "0.2.0", targetImage: null, targetVersion: null });
    });

    test("rollback commands re-tag the kept image and never download or build", () => {
        const commands = rollbackCommands(identityOf());
        expect(commands[0]).toBe(`docker image tag ${ROLLBACK_TAG} ${IMAGE_REF}`);
        expect(commands.at(-1)).toContain("up -d --no-deps --no-build --pull never panel");
        expect(commands.some(line => line.includes(" pull "))).toBe(false);
    });
});
