import { expect, test } from "bun:test";
import { chmod, chown, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStack, StackCreationPartialError } from "../src/create-stack.ts";
import { createComposeProvider, type ComposeProvider } from "../src/compose-provider.ts";
import { listStacks, StackError } from "../src/stacks.ts";
import { StackLocks } from "../src/locks.ts";
import type { CommandResult } from "../src/docker.ts";
import { writeFileSync } from "node:fs";
import { foreignOwner } from "./helpers/ownership.ts";

const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "", timedOut: false, truncated: false });
const composeSource = "# preserve comments\r\nname: chosen-project\r\nservices:\r\n  app:\r\n    image: busybox\r\n";
const draft = { name: "new-app", composeSource, envSource: "TOKEN='private-secret'\r\n" };
function provider(overrides: Partial<ComposeProvider> = {}): ComposeProvider {
    const base = createComposeProvider({
        runner: async (args) => {
            if (args.includes("ls")) return ok("[]");
            if (args.includes("--quiet")) return ok();
            if (args.includes("config")) return ok('{"name":"chosen-project"}');
            throw new Error("unexpected command");
        },
    });
    // Prototype methods remain available while selected calls can be replaced.
    return Object.assign(base, overrides);
}
async function fixture(work: (root: string) => Promise<void>) {
    // Canonical like `resolveRoot()`: macOS tmpdir() lives behind the /var symlink.
    const root = await realpath(await mkdtemp(join(tmpdir(), "cp-create-")));
    try {
        await work(root);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

test("preserves the raw pair, validates exact context, and becomes discoverable only after validation", async () =>
    fixture(async (root) => {
        const cwd = join(root, draft.name);
        let checked = false;
        const fake = provider({
            validateConfig: async (input) => {
                expect(input.directory).toBe(cwd);
                expect(input.projectName).toBeUndefined();
                expect(input.envFile).toBe(join(cwd, ".env"));
                expect(await readFile(input.composeFile, "utf8")).toBe(composeSource);
                expect(await readFile(input.envFile!, "utf8")).toBe(draft.envSource);
                expect(await listStacks(root)).toEqual([]);
                checked = true;
                return ok();
            },
        });
        await createStack(root, draft, fake, 10000);
        expect(checked).toBe(true);
        expect((await readdir(cwd)).sort()).toEqual([".env", "compose.yaml"]);
        expect(await readFile(join(cwd, "compose.yaml"), "utf8")).toBe(composeSource);
        expect(await readFile(join(cwd, ".env"), "utf8")).toBe(draft.envSource);
        expect(await listStacks(root)).toEqual([{ name: draft.name, composeFile: "compose.yaml" }]);
        if (process.platform === "linux") {
            expect((await lstat(cwd)).mode & 0o777).toBe(0o700);
            expect((await lstat(join(cwd, ".env"))).mode & 0o777).toBe(0o600);
            expect((await lstat(join(cwd, "compose.yaml"))).mode & 0o777).toBe(0o600);
        }
    }));

test("empty variables keep Compose's default interpolation sources, like later operations, and leave no .env", async () =>
    fixture(async (root) => {
        const envFiles: (string | undefined)[] = [];
        const fake = provider({
            validateConfig: async (input) => {
                envFiles.push(input.envFile);
                expect(await readdir(input.directory)).toHaveLength(1);
                return ok();
            },
            projectName: async (input) => {
                envFiles.push(input.envFile);
                return "chosen-project";
            },
        });
        await createStack(root, { ...draft, envSource: "" }, fake, 10000);
        // No substitute --env-file: it would hide an inherited COMPOSE_ENV_FILES
        // that resolveProjectContext() then honours after creation.
        expect(envFiles).toEqual([undefined, undefined]);
        expect(await readdir(join(root, draft.name))).toEqual(["compose.yaml"]);
    }));

test("a .env appearing when none was supplied is refused, since Compose would load it after creation", async () =>
    fixture(async (root) => {
        const fake = provider({
            validateConfig: async (input) => {
                await writeFile(join(input.directory, ".env"), "STACK_ID=other\n");
                return ok();
            },
        });
        // Refused before publication; the foreign file is kept, so cleanup is partial.
        await expect(createStack(root, { ...draft, envSource: "" }, fake, 10000)).rejects.toBeInstanceOf(StackCreationPartialError);
        expect(await readdir(join(root, draft.name))).toEqual([".env"]);
    }));

test.skipIf(process.platform !== "linux" || !foreignOwner)(
    "new stack ownership follows the root even when the process creates files with another owner/group",
    async () =>
        fixture(async (root) => {
            const owner = foreignOwner!;
            await chown(root, owner.uid, owner.gid);
            await createStack(root, draft, provider(), 10000);
            for (const path of [join(root, draft.name), join(root, draft.name, "compose.yaml"), join(root, draft.name, ".env")]) {
                const info = await lstat(path);
                expect({ uid: info.uid, gid: info.gid }).toEqual(owner);
                expect(info.mode & 0o777).toBe(info.isDirectory() ? 0o700 : 0o600);
            }
            if (process.getuid?.() === 0) {
                // Drop privilege in an isolated child to prove the inherited owner can
                // read the pair without sudo. No Docker daemon is involved.
                const child = Bun.spawn(
                    [
                        process.execPath,
                        "-e",
                        'const fs = require("node:fs"); process.setgid(Number(process.argv[1])); process.setuid(Number(process.argv[2])); for (const path of process.argv.slice(3)) fs.readFileSync(path);',
                        String(owner.gid),
                        String(owner.uid),
                        join(root, draft.name, "compose.yaml"),
                        join(root, draft.name, ".env"),
                    ],
                    { stdout: "ignore", stderr: "pipe" },
                );
                expect(await child.exited).toBe(0);
            }
        }),
);

test.skipIf(process.platform !== "linux" || process.getuid?.() !== 0)(
    "refuses publication when an unprivileged process cannot inherit the root owner",
    async () =>
        fixture(async (root) => {
            await chown(root, 65534, 65534);
            await chmod(root, 0o777); // Disposable fixture allowing another uid to mkdir.
            const script =
                'const { createStack } = await import(process.argv[1]); process.setgid(65533); process.setuid(65533); try { await createStack(process.argv[2], {name:"denied",composeSource:"services: {}",envSource:""}, {}, 10000); process.exit(1); } catch (error) { process.exit(error.status === 500 ? 0 : 2); }';
            const child = Bun.spawn([process.execPath, "-e", script, join(import.meta.dir, "../src/create-stack.ts"), root], {
                stdout: "ignore",
                stderr: "pipe",
            });
            expect(await child.exited).toBe(0);
            expect(await readdir(root)).toEqual([]);
        }),
);

test("creation shows redacted validation diagnostics and suppresses truncated stderr", async () =>
    fixture(async (root) => {
        const stderr = "fixture-yaml-location: private-secret\nextra detail";
        const fake = provider({ validateConfig: async () => ({ ...ok(), code: 1, stderr }) });
        const error = await createStack(root, draft, fake, 10000).catch((error) => error);
        expect(error).toBeInstanceOf(StackError);
        expect(error.message).toContain("fixture-yaml-location");
        expect(error.message).not.toContain("private-secret");
        expect(error.message).toContain("***");
        for (const code of [0, 1]) {
            const truncated = provider({ validateConfig: async () => ({ ...ok(), code, stderr, truncated: true }) });
            const failure = await createStack(root, draft, truncated, 10000).catch((error) => error);
            expect(failure).toBeInstanceOf(StackError);
            expect(failure.message).not.toContain("fixture-yaml-location");
            expect(failure.message).not.toContain("private-secret");
        }
        expect(await readdir(root)).toEqual([]);
    }));

test("hard-link refusal gives an explicit application error and cleans up the reserved folder", async () =>
    fixture(async (root) => {
        for (const code of ["EPERM", "EOPNOTSUPP", "EXDEV"]) {
            const error = await createStack(root, draft, provider(), 10000, {
                linker: async () => {
                    throw Object.assign(new Error("private-secret"), { code });
                },
            }).catch((error) => error);
            expect(error).toBeInstanceOf(StackError);
            expect(error).not.toBeInstanceOf(StackCreationPartialError);
            expect(error.status).toBe(500);
            expect(error.message).not.toContain("private-secret");
            expect(await readdir(root)).toEqual([]);
        }
    }));

test("incomplete cleanup preserves the redacted validation cause and a safe stage", async () =>
    fixture(async (root) => {
        const fake = provider({
            validateConfig: async (input) => {
                await writeFile(join(input.directory, "foreign"), "untouched");
                return { ...ok(), code: 1, stderr: "fixture-validation-cause: private-secret" };
            },
        });
        const error = await createStack(root, draft, fake, 10000).catch((error) => error);
        expect(error).toBeInstanceOf(StackCreationPartialError);
        expect(error.stage).toBe("validation");
        expect(error.message).toContain("fixture-validation-cause");
        expect(error.message).not.toContain("private-secret");
        expect(await readFile(join(root, draft.name, "foreign"), "utf8")).toBe("untouched");
    }));

test("refuses invalid names, empty source and oversized drafts before any directory or Docker read", async () =>
    fixture(async (root) => {
        let calls = 0;
        const fake = provider({
            validateConfig: async () => {
                calls++;
                return ok();
            },
        });
        for (const name of ["../escape", "a/b", "A", ".hidden", "name\n", "x\0", "", "a".repeat(64)])
            await expect(createStack(root, { ...draft, name }, fake, 10000)).rejects.toBeInstanceOf(StackError);
        await expect(createStack(root, { ...draft, composeSource: "  " }, fake, 10000)).rejects.toBeInstanceOf(StackError);
        await expect(createStack(root, draft, fake, 2)).rejects.toMatchObject({ status: 413 });
        expect(calls).toBe(0);
        expect(await readdir(root)).toEqual([]);
    }));

test("never replaces an existing folder or file, even an empty folder", async () =>
    fixture(async (root) => {
        const path = join(root, draft.name);
        await mkdir(path);
        await expect(createStack(root, draft, provider(), 10000)).rejects.toMatchObject({ status: 409 });
        expect(await readdir(path)).toEqual([]);
        await rm(path, { recursive: true });
        await writeFile(path, "existing");
        await expect(createStack(root, draft, provider(), 10000)).rejects.toMatchObject({ status: 409 });
        expect(await readFile(path, "utf8")).toBe("existing");
    }));

test("validation failure, timeout, truncation and missing project roll back only this request", async () =>
    fixture(async (root) => {
        for (const result of [
            { ...ok(), code: 1, stderr: "private-secret" },
            { ...ok(), timedOut: true },
            { ...ok(), truncated: true },
        ]) {
            await expect(createStack(root, draft, provider({ validateConfig: async () => result }), 10000)).rejects.toBeInstanceOf(
                StackError,
            );
            expect(await readdir(root)).toEqual([]);
        }
        await expect(createStack(root, draft, provider({ projectName: async () => null }), 10000)).rejects.toMatchObject({ status: 503 });
        expect(await readdir(root)).toEqual([]);
    }));

test("unavailable, malformed and colliding project discovery fail closed, including a collision before commit", async () =>
    fixture(async (root) => {
        const collision = ok('[{"Name":"chosen-project","Status":"running(1)","ConfigFiles":"/external/compose.yaml"}]');
        for (const result of [{ ...ok(), code: 1 }, { ...ok("[]"), truncated: true }, ok("invalid"), collision]) {
            await expect(createStack(root, draft, provider({ listProjects: async () => result }), 10000)).rejects.toBeInstanceOf(
                StackError,
            );
            expect(await readdir(root)).toEqual([]);
        }
        let calls = 0;
        await expect(
            createStack(root, draft, provider({ listProjects: async () => (++calls === 1 ? ok("[]") : collision) }), 10000),
        ).rejects.toMatchObject({ status: 409 });
        expect(calls).toBe(2);
        expect(await readdir(root)).toEqual([]);
    }));

test("concurrent requests under the shared lock refuse the second create", async () =>
    fixture(async (root) => {
        const locks = new StackLocks();
        let release!: () => void;
        let entered!: () => void;
        const started = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const blocked = new Promise<void>((resolve) => {
            release = resolve;
        });
        const fake = provider({
            validateConfig: async () => {
                entered();
                await blocked;
                return ok();
            },
        });
        const first = locks.run(draft.name, () => createStack(root, draft, fake, 10000));
        await started;
        try {
            await expect(locks.run(draft.name, () => createStack(root, draft, fake, 10000))).rejects.toThrow();
        } finally {
            release();
            await first;
        }
        expect(locks.hasActive()).toBe(false);
    }));

test("a denied commit cleans up the drafts and preserves the denial", async () =>
    fixture(async (root) => {
        const denial = new Error("session ended");
        await expect(
            createStack(root, draft, provider(), 10000, {
                beforeCommit: () => {
                    throw denial;
                },
            }),
        ).rejects.toBe(denial);
        expect(await readdir(root)).toEqual([]);
    }));

test("foreign files introduced during validation are preserved and rollback is reported incomplete", async () =>
    fixture(async (root) => {
        const fake = provider({
            validateConfig: async (input) => {
                await writeFile(join(input.directory, "foreign"), "keep me");
                return ok();
            },
        });
        await expect(createStack(root, draft, fake, 10000)).rejects.toBeInstanceOf(StackCreationPartialError);
        expect(await readdir(join(root, draft.name))).toEqual(["foreign"]);
        expect(await readFile(join(root, draft.name, "foreign"), "utf8")).toBe("keep me");
    }));

test("exclusive publication never overwrites a file added immediately before commit", async () =>
    fixture(async (root) => {
        const path = join(root, draft.name, "compose.yaml");
        await expect(
            createStack(root, draft, provider(), 10000, {
                beforeCommit: () => {
                    writeFileSync(path, "foreign-compose");
                },
            }),
        ).rejects.toBeInstanceOf(StackCreationPartialError);
        expect(await readFile(path, "utf8")).toBe("foreign-compose");
        expect(await readdir(join(root, draft.name))).toEqual(["compose.yaml"]);
    }));

test.skipIf(process.platform !== "linux")(
    "refuses symlink targets and pins cleanup to the original directory across substitution",
    async () =>
        fixture(async (root) => {
            const foreign = join(root, "foreign");
            await mkdir(foreign);
            await writeFile(join(foreign, "witness"), "untouched");
            await symlink(foreign, join(root, draft.name));
            await expect(createStack(root, draft, provider(), 10000)).rejects.toMatchObject({ status: 409 });
            await rm(join(root, draft.name));
            const moved = join(root, "moved");
            const fake = provider({
                validateConfig: async (input) => {
                    await rename(input.directory, moved);
                    await symlink(foreign, input.directory);
                    return ok();
                },
            });
            await expect(createStack(root, draft, fake, 10000)).rejects.toBeInstanceOf(StackCreationPartialError);
            expect(await readFile(join(foreign, "witness"), "utf8")).toBe("untouched");
            expect(await readdir(foreign)).toEqual(["witness"]);
            expect(await readdir(moved)).toEqual([]);
        }),
);
