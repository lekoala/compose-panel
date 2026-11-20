import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDockerRunner } from "../src/docker.ts";
import { HostMaintenance } from "../src/host-maintenance.ts";
import { StackLocks } from "../src/locks.ts";

// Opt-in check of the real prune semantics (ADR 0040) on a DISPOSABLE Docker
// daemon. It deletes images, so it refuses to run unless the daemon proves it
// is the lab one started by scripts/docker-lab/run.sh:
//   COMPOSE_PANEL_TEST_DOCKER_LAB=1
//   DOCKER_HOST=unix:///<lab dir>/socket/docker.sock
// The age floor matters: fixtures are backdated by rewriting the image config
// `created` field, because a freshly built image is never eligible.
const LAB_LABEL = "compose-panel-lab=1";
const enabled = process.env.COMPOSE_PANEL_TEST_DOCKER_LAB === "1";
const PREFIX = `cp-maint-${process.pid}`;
const OLD = "2024-01-01T00:00:00Z";

interface Run {
    code: number;
    stdout: string;
    stderr: string;
}

async function run(file: string, args: string[], timeoutMs = 120_000): Promise<Run> {
    const proc = Bun.spawn([file, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: timeoutMs });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, stdout, stderr };
}

async function docker(args: string[], timeoutMs?: number): Promise<Run> {
    return run("docker", args, timeoutMs);
}

async function dockerOk(args: string[], timeoutMs?: number): Promise<string> {
    const result = await docker(args, timeoutMs);
    if (result.code !== 0) throw new Error(`docker ${args.join(" ")} failed (${result.code}): ${result.stderr.trim()}`);
    return result.stdout;
}

async function assertLabDaemon(): Promise<void> {
    if (process.platform !== "linux") throw new Error("The Docker lab test runs on Linux only.");
    const host = process.env.DOCKER_HOST ?? "";
    if (!host.startsWith("unix://")) throw new Error("DOCKER_HOST must point to the lab Unix socket (unix://...).");
    const socket = host.slice("unix://".length);
    let real: string;
    try {
        real = realpathSync(socket);
    } catch {
        throw new Error(`Lab socket ${socket} does not exist.`);
    }
    if (["/var/run/docker.sock", "/run/docker.sock"].includes(real) || real.startsWith("/run/user/")) {
        throw new Error(`DOCKER_HOST resolves to a default daemon socket (${real}); refusing.`);
    }
    for (const name of ["DOCKER_CONTEXT", "COMPOSE_PROJECT_NAME", "COMPOSE_FILE", "COMPOSE_ENV_FILES", "COMPOSE_PROFILES"]) {
        if (process.env[name]) throw new Error(`Unset ${name} before running the lab test.`);
    }
    const labels = JSON.parse(await dockerOk(["info", "--format", "{{json .Labels}}"])) as string[] | null;
    if (!labels?.includes(LAB_LABEL)) throw new Error(`The daemon behind DOCKER_HOST lacks the engine label ${LAB_LABEL}; refusing.`);
}

/** Build a minimal image, then rewrite its creation date so the filter applies. */
async function buildBackdatedImage(tag: string, from: string, dir: string, label: string): Promise<void> {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "Dockerfile"), `FROM ${from}\nLABEL ${label}\n`);
    await dockerOk(["build", "-t", tag, dir]);

    const saved = join(dir, "saved.tar");
    await dockerOk(["save", "-o", saved, tag]);
    // Remove the fresh copy first: loading the patched config then recreates the
    // same tag with the old creation date, instead of leaving a recent image.
    await dockerOk(["rmi", "-f", tag]);

    const unpacked = join(dir, "unpacked");
    await mkdir(unpacked, { recursive: true });
    const untar = await run("tar", ["-xf", saved, "-C", unpacked]);
    if (untar.code !== 0) throw new Error(`tar extraction failed: ${untar.stderr}`);

    const manifest = JSON.parse(await Bun.file(join(unpacked, "manifest.json")).text()) as { Config: string }[];
    const configPath = join(unpacked, manifest[0]!.Config);
    const config = JSON.parse(await Bun.file(configPath).text()) as { created: string };
    config.created = OLD;
    // `docker save` writes blobs read-only; the patched config must be writable.
    await chmod(configPath, 0o644);
    await writeFile(configPath, JSON.stringify(config));

    const repacked = join(dir, "old.tar");
    // The archive also carries an OCI index whose descriptors are content
    // hashes; changing the config invalidates them. Drop the OCI metadata so
    // the daemon loads through the legacy manifest, which has no digest check.
    await rm(join(unpacked, "index.json"), { force: true });
    await rm(join(unpacked, "oci-layout"), { force: true });
    const retar = await run("tar", ["-cf", repacked, "-C", unpacked, "."]);
    if (retar.code !== 0) throw new Error(`tar creation failed: ${retar.stderr}`);
    await dockerOk(["load", "-i", repacked]);

    const raw = await dockerOk(["image", "inspect", tag]);
    const created = (JSON.parse(raw)[0] as { Created?: string }).Created ?? "";
    if (!created.startsWith("2024-01-01")) throw new Error(`Fixture ${tag} was not backdated (created ${created}): ${raw.slice(0, 400)}`);
}

async function imageExists(tag: string): Promise<boolean> {
    return (await docker(["image", "inspect", tag])).code === 0;
}

async function prune(scope: "build-cache" | "dangling-images" | "unused-images"): Promise<string> {
    const maintenance = new HostMaintenance(new StackLocks(), createDockerRunner({ timeoutMs: 120_000 }), {
        timeoutMs: 300_000,
        maxBytes: 1024 * 1024,
    });
    maintenance.start(scope);
    const deadline = Date.now() + 240_000;
    while (maintenance.last()?.status === "running") {
        if (Date.now() > deadline) throw new Error(`prune ${scope} did not finish`);
        await Bun.sleep(100);
    }
    const view = maintenance.last()!;
    if (view.status !== "succeeded") throw new Error(`prune ${scope} ended ${view.status}: ${view.output}`);
    // Reclaimed bytes are best effort: Docker may omit the summary line, and an
    // unparsed value must not fail a removal that already succeeded.
    return view.output;
}

const suite = enabled ? describe : describe.skip;

suite("Docker storage maintenance on a disposable daemon (ADR 0040)", () => {
    let work = "";
    /**
     * Docker 29 removed the classic image store; its containerd store keeps its
     * own image timestamp, so an image whose config date is backdated but whose
     * import is recent is kept by the age floor. Both outcomes are asserted
     * instead of skipping: the point is that the floor never overreaches.
     */
    let containerdStore = false;
    /** Set only once the daemon is proven to be the disposable lab one. */
    let verified = false;
    const images: string[] = [];
    const containers: string[] = [];
    const volumes: string[] = [];
    const danglingImages: string[] = [];

    beforeAll(async () => {
        await assertLabDaemon();
        verified = true;
        containerdStore = (await dockerOk(["info", "--format", "{{.Driver}}"])).trim() === "overlayfs";
        work = await mkdtemp(join(tmpdir(), "cp-maint-"));

        // Old unreferenced tagged image: the one `unused-images` must remove.
        await buildBackdatedImage(`${PREFIX}-old:1`, "alpine:3.20", join(work, "old"), "fixture=old");
        images.push(`${PREFIX}-old:1`);

        // Recent unreferenced image: never eligible, whatever the scope.
        // A commit gets its own creation timestamp; a `FROM <base>` build can
        // inherit the base's date with BuildKit, which would make it "old".
        const seed = (await dockerOk(["create", "alpine:3.20", "true"])).trim();
        containers.push(seed);
        await dockerOk(["commit", "--change", "LABEL fixture=new", seed, `${PREFIX}-new:1`]);
        await dockerOk(["rm", "-f", seed]);
        images.push(`${PREFIX}-new:1`);

        // Old image still referenced by a STOPPED container: must survive `-a`.
        await buildBackdatedImage(`${PREFIX}-ref:1`, "alpine:3.20", join(work, "ref"), "fixture=ref");
        images.push(`${PREFIX}-ref:1`);
        await dockerOk(["run", "--name", `${PREFIX}-stopped`, `${PREFIX}-ref:1`, "true"]);
        containers.push(`${PREFIX}-stopped`);

        // A running container and a volume: never touched by any scope.
        await dockerOk(["run", "-d", "--name", `${PREFIX}-running`, "alpine:3.20", "sleep", "120"]);
        containers.push(`${PREFIX}-running`);
        await dockerOk(["volume", "create", `${PREFIX}-vol`]);
        volumes.push(`${PREFIX}-vol`);
        await dockerOk(["run", "--rm", "-v", `${PREFIX}-vol:/v`, "alpine:3.20", "sh", "-c", "echo keep > /v/file"]);

        // An old dangling image: built, backdated, then replaced by a recent
        // commit, which moves the tag and leaves the old image untagged.
        await buildBackdatedImage(`${PREFIX}-dangl:1`, "alpine:3.20", join(work, "dangl"), "fixture=dangling-1");
        const replaceSeed = (await dockerOk(["create", "alpine:3.20", "true"])).trim();
        containers.push(replaceSeed);
        await dockerOk(["commit", "--change", "LABEL fixture=dangling-2", replaceSeed, `${PREFIX}-dangl:1`]);
        await dockerOk(["rm", "-f", replaceSeed]);
        images.push(`${PREFIX}-dangl:1`);
        const dangling = await dockerOk(["image", "ls", "-q", "--filter", "dangling=true", "--filter", "label=fixture=dangling-1"]);
        danglingImages.push(
            ...dangling
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean),
        );
    }, 300_000);

    afterAll(async () => {
        // Bun runs afterAll even when beforeAll threw. Until the daemon is
        // proven to be the disposable lab one, issue no Docker call at all:
        // DOCKER_HOST may be missing while a default daemon is reachable.
        if (!verified) {
            if (work) await rm(work, { recursive: true, force: true });
            return;
        }
        for (const name of containers) {
            await docker(["rm", "-f", name]);
        }
        for (const tag of images) {
            await docker(["rmi", "-f", tag]);
        }
        for (const id of danglingImages) {
            await docker(["rmi", "-f", id]);
        }
        for (const volume of volumes) {
            await docker(["volume", "rm", "-f", volume]);
        }
        if (work) await rm(work, { recursive: true, force: true });
    }, 120_000);

    test("build cache pruning leaves images and containers alone", async () => {
        await prune("build-cache");
        expect(await imageExists(`${PREFIX}-old:1`)).toBe(true);
        expect(await imageExists(`${PREFIX}-ref:1`)).toBe(true);
        expect((await docker(["ps", "-a", "--filter", `name=${PREFIX}-stopped`, "--format", "{{.Names}}"])).stdout).toContain(
            `${PREFIX}-stopped`,
        );
    });

    test("dangling pruning removes only the untagged old image", async () => {
        const dangling = async (): Promise<string[]> => {
            const out = await dockerOk(["image", "ls", "-q", "--filter", "dangling=true", "--filter", "label=fixture=dangling-1"]);
            return out
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean);
        };
        const before = await dangling();
        await prune("dangling-images");
        if (containerdStore) {
            // The daemon's own import timestamp is recent here, so the age floor
            // keeps an image whose config date was backdated: nothing overreaches.
            expect(await dangling()).toEqual(before);
        } else {
            expect(before.length).toBeGreaterThan(0);
            expect(await dangling()).toEqual([]);
        }
        // A tagged image is never a dangling image, whatever the store.
        expect(await imageExists(`${PREFIX}-old:1`)).toBe(true);
        expect(await imageExists(`${PREFIX}-dangl:1`)).toBe(true);
    });

    test("unused pruning removes old unreferenced images, keeps referenced, fresh and volumes", async () => {
        await prune("unused-images");
        // Classic store: the backdated image is eligible. Containerd store: its
        // import is recent, so the same image is kept by the age floor.
        expect(await imageExists(`${PREFIX}-old:1`)).toBe(containerdStore);
        // A stopped container keeps its image: `-a` never removes referenced ones.
        expect(await imageExists(`${PREFIX}-ref:1`)).toBe(true);
        // The age filter protects recent images.
        expect(await imageExists(`${PREFIX}-new:1`)).toBe(true);
        // Rebuilt above, so recent: the age floor keeps it too.
        expect(await imageExists(`${PREFIX}-dangl:1`)).toBe(true);

        const stopped = (await dockerOk(["inspect", "-f", "{{.State.Status}}", `${PREFIX}-stopped`])).trim();
        expect(stopped).toBe("exited");
        const running = (await dockerOk(["inspect", "-f", "{{.State.Status}}", `${PREFIX}-running`])).trim();
        expect(running).toBe("running");
        const volume = (await dockerOk(["volume", "inspect", "-f", "{{.Name}}", `${PREFIX}-vol`])).trim();
        expect(volume).toBe(`${PREFIX}-vol`);
        const kept = (await dockerOk(["run", "--rm", "-v", `${PREFIX}-vol:/v`, "alpine:3.20", "cat", "/v/file"])).trim();
        expect(kept).toBe("keep");
    });
});
