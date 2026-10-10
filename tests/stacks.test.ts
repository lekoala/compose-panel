import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listStacks, readStackCompose, resolveRoot, validateStackName } from "../src/stacks.ts";

const dirs: string[] = [];
// Windows without Developer Mode cannot create symlinks unprivileged (EPERM).
// Symlink safety is validated on Linux CI; never treat a Windows skip as proof.
const symlinksSupported = process.platform !== "win32";
async function root(): Promise<string> {
    const p = await mkdtemp(join(tmpdir(), "compose-panel-test-"));
    dirs.push(p);
    return resolveRoot(p);
}
afterEach(async () => {
    await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe("stack name safety", () => {
    for (const value of ["../secret", "..", ".", "UPPER", "with space", "x/y", "x\\y", "", "a".repeat(64),
        // Trapped by single-decode then allow-list: `$` anchors never accept these.
        "a\n", "a\r", "a\r\n", "a\0b", "a%0A", "a%00", "a%2fb", "a.", "-lead", ".env"]) {
        test(`rejects ${JSON.stringify(value)}`, () => expect(() => validateStackName(value)).toThrow());
    }
    test("accepts ordinary folder names", () => expect(() => validateStackName("backend_2-prod")).not.toThrow());
});

test("reads one Compose file, without interpreting YAML", async () => {
    const dir = await root();
    await mkdir(join(dir, "my-stack"));
    const yaml = "services:\n  app:\n    image: nginx:alpine\n# Keep comment\n";
    await writeFile(join(dir, "my-stack", "compose.yaml"), yaml);
    const result = await readStackCompose(dir, "my-stack");
    expect(result.source).toBe(yaml);
    expect(await listStacks(dir)).toEqual([{ name: "my-stack", composeFile: "compose.yaml" }]);
});

test.skipIf(!symlinksSupported)("does not follow a symlinked stack directory", async () => {
    const dir = await root();
    const outside = await root();
    await mkdir(join(outside, "app"));
    await writeFile(join(outside, "app", "compose.yaml"), "services: {}");
    await symlink(join(outside, "app"), join(dir, "linked"), "dir");
    expect(await listStacks(dir)).toEqual([]);
    await expect(readStackCompose(dir, "linked")).rejects.toThrow();
});

test.skipIf(!symlinksSupported)("refuses symlinked and ambiguous Compose files", async () => {
    const dir = await root();
    await mkdir(join(dir, "app"));
    await writeFile(join(dir, "secret.yaml"), "secret");
    await symlink(join(dir, "secret.yaml"), join(dir, "app", "compose.yaml"));
    await expect(readStackCompose(dir, "app")).rejects.toThrow();
    await rm(join(dir, "app", "compose.yaml"));
    await writeFile(join(dir, "app", "compose.yaml"), "services: {}");
    await writeFile(join(dir, "app", "docker-compose.yml"), "services: {}");
    await expect(readStackCompose(dir, "app")).rejects.toThrow();
});

test("refuses an implicit Compose override rather than showing partial config", async () => {
    const dir = await root();
    await mkdir(join(dir, "app"));
    await writeFile(join(dir, "app", "compose.yaml"), "services: {}");
    await writeFile(join(dir, "app", "compose.override.yml"), "services: {}");
    await expect(readStackCompose(dir, "app")).rejects.toThrow();
});
