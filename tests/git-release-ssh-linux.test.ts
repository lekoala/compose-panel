import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCommand } from "../src/docker.ts";
import { fetchAndPublishGitRelease } from "../src/git-release.ts";

const enabled = process.platform === "linux" && process.env.COMPOSE_PANEL_TEST_SSH_FIXTURE === "1";
const port = 2222;

async function command(file: string, args: string[]): Promise<string> {
    const result = await runCommand(file, args, { timeoutMs: 10_000, maxBytes: 32 * 1024 });
    if (result.code !== 0 || result.timedOut || result.truncated) throw new Error(`Fixture command failed: ${file}: ${result.stderr}`);
    return result.stdout.trimEnd();
}

test.skipIf(!enabled)(
    "real SSH fetch publishes with both keys pinned and refuses incorrect keys before publication",
    async () => {
        const fixture = await mkdtemp("/tmp/cp-git-ssh-");
        let daemon: Bun.Subprocess | undefined;
        try {
            const repository = join(fixture, "repository");
            const stack = join(fixture, "stack with spaces %h");
            const releases = join(stack, "site", "runtime", "releases");
            const current = join(stack, "site", "runtime", "current");
            const staging = join(stack, "site", "staging");
            const credentials = join(stack, "site", "private", "ssh");
            const prior = "b".repeat(40);
            await mkdir(join(releases, prior), { recursive: true });
            await mkdir(staging, { mode: 0o700 });
            await mkdir(join(stack, "site", "private"), { mode: 0o700 });
            await mkdir(credentials, { mode: 0o700 });
            await symlink(`releases/${prior}`, current, "dir");

            await command("git", ["init", "--quiet", "--initial-branch=main", repository]);
            await mkdir(join(repository, "public"));
            await writeFile(join(repository, "public", "index.php"), "<?php echo 'fixture';\n");
            await command("git", ["-C", repository, "add", "public/index.php"]);
            await command("git", [
                "-C",
                repository,
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.test",
                "commit",
                "-qm",
                "fixture",
            ]);
            const sha = await command("git", ["-C", repository, "rev-parse", "HEAD"]);

            for (const name of ["host", "client", "wrong"]) {
                await command("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(fixture, name)]);
            }
            const publicKey = await readFile(join(fixture, "client.pub"), "utf8");
            await writeFile(join(fixture, "authorized_keys"), `restrict,command="/usr/bin/git-upload-pack ${repository}" ${publicKey}`);
            const config = join(fixture, "sshd_config");
            const log = join(fixture, "sshd.log");
            await writeFile(
                config,
                `ListenAddress 127.0.0.1:${port}
HostKey ${fixture}/host
AuthorizedKeysFile ${fixture}/authorized_keys
PidFile ${fixture}/sshd.pid
PermitRootLogin forced-commands-only
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM no
StrictModes no
`,
            );
            daemon = Bun.spawn(["/usr/sbin/sshd", "-D", "-e", "-E", log, "-f", config], { stdout: "ignore", stderr: "inherit" });
            for (let i = 0; i < 100 && daemon.exitCode === null; i++) {
                if ((await readFile(log, "utf8").catch(() => "")).includes("Server listening")) break;
                await Bun.sleep(25);
            }
            expect(await readFile(log, "utf8")).toContain("Server listening");
            expect(daemon.exitCode).toBeNull();

            const knownHosts = join(credentials, "known_hosts");
            const identity = join(credentials, "identity");
            const pin = async (name: string) => {
                const key = await readFile(join(fixture, `${name}.pub`), "utf8");
                await writeFile(knownHosts, `[127.0.0.1]:${port} ${key}`, { mode: 0o600 });
            };
            const fetch = () =>
                fetchAndPublishGitRelease({
                    stackDir: stack,
                    attemptId: "sshfixture",
                    siteId: "fixture-site",
                    url: `ssh://root@127.0.0.1:${port}${repository}`,
                    ref: "refs/heads/main",
                    limits: { fetchTimeoutMs: 8_000 },
                });

            await copyFile(join(fixture, "wrong"), identity);
            await pin("host");
            for (const mismatch of ["client", "host"]) {
                if (mismatch === "host") {
                    await copyFile(join(fixture, "client"), identity);
                    await pin("wrong");
                }
                expect(await fetch()).toMatchObject({ ok: false, phase: "fetch", cleanup: "removed", unconfirmed: false });
                expect(await readlink(current)).toBe(`releases/${prior}`);
                expect(await readdir(releases)).toEqual([prior]);
                expect(await readdir(staging)).toEqual([]);
            }

            await pin("host");
            const success = await fetch();
            if (!success.ok) throw new Error(`SSH fixture fetch failed: ${success.reason}\n${await readFile(log, "utf8")}`);
            expect(success.releaseId).toBe(sha);
            expect(await readFile(join(success.releasePath, "public", "index.php"), "utf8")).toBe("<?php echo 'fixture';\n");
            expect(await readlink(current)).toBe(`releases/${prior}`);
            expect(await readdir(staging)).toEqual([]);
        } finally {
            daemon?.kill();
            await daemon?.exited;
            await rm(fixture, { recursive: true });
        }
    },
    35_000,
);
