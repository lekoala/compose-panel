import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("the registry CLI preserves retries and records replacement digests", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cp-release-registry-"));
    const path = join(dir, "registry.json");
    const script = fileURLToPath(new URL("../scripts/record-release.ts", import.meta.url));
    const revision = "b".repeat(40);
    const first = `sha256:${"a".repeat(64)}`;
    const second = `sha256:${"c".repeat(64)}`;
    const run = async (digest: string) => {
        const child = Bun.spawn([process.execPath, script, path, "0.3.1", digest, revision], { stdout: "ignore", stderr: "pipe" });
        const stderr = await new Response(child.stderr).text();
        expect({ code: await child.exited, stderr }).toEqual({ code: 0, stderr: "" });
    };
    try {
        await writeFile(path, '{"schema":1,"releases":[]}\n');
        await run(first);
        const initial = await readFile(path, "utf8");
        await run(first);
        expect(await readFile(path, "utf8")).toBe(initial);
        await run(second);
        const history = JSON.parse(await readFile(path, "utf8"));
        expect(history.releases.map((entry: { digest: string }) => entry.digest)).toEqual([first, second]);
        expect(history.releases[0]).toEqual(JSON.parse(initial).releases[0]);
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test.skipIf(process.platform !== "linux")("all CI and publication shell steps have valid bash syntax", async () => {
    for (const name of ["ci", "release"]) {
        const workflow = Bun.YAML.parse(await Bun.file(new URL(`../.github/workflows/${name}.yml`, import.meta.url)).text()) as {
            jobs: Record<string, { steps?: { run?: string }[] }>;
        };
        for (const job of Object.values(workflow.jobs)) {
            for (const step of job.steps ?? []) {
                if (!step.run) continue;
                const child = Bun.spawn(["bash", "-n"], { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
                child.stdin.write(step.run);
                child.stdin.end();
                const stderr = await new Response(child.stderr).text();
                expect({ code: await child.exited, stderr }).toEqual({ code: 0, stderr: "" });
            }
        }
    }
});
