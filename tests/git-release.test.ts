import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult, RunOptions } from "../src/docker.ts";
import {
    fetchAndPublishGitRelease,
    gitEnvironment,
    parseGitCommit,
    parseGitTreeListing,
    parseReleaseMetadata,
    revisionScript,
    type GitReleaseRequest,
    type GitReleaseResult,
    type GitRunner,
} from "../src/git-release.ts";

const SHA = "a".repeat(40);
const URL = "https://github.com/acme/shop.git";
const REF = "refs/heads/main";

function result(overrides: Partial<CommandResult> = {}): CommandResult {
    return { code: 0, stdout: "", stderr: "", timedOut: false, truncated: false, ...overrides };
}

function entry(path: string, size = 10, mode = "100644", type = "blob"): string {
    return `${mode} ${type} ${"0".repeat(40)} ${size}\t${path}\0`;
}

function listing(...entries: string[]): string {
    return entries.join("");
}

const BASE = listing(entry("public/index.php", 20), entry("public/static.txt", 5));

interface FakeOptions {
    sha?: string;
    tree?: string;
    populate?: (tree: string) => Promise<void>;
    fetch?: CommandResult;
    checkout?: CommandResult;
}

/** A fake fetch adapter: it answers every fixed command without a network. */
function fakeRunner(options: FakeOptions = {}): GitRunner {
    const sha = options.sha ?? SHA;
    return async (args: string[]) => {
        if (args.includes("init")) {
            const repo = args[args.length - 1]!;
            await mkdir(join(repo, ".git"), { recursive: true });
            return result();
        }
        if (args.includes("fetch")) return options.fetch ?? result();
        if (args.includes("rev-parse")) return result({ stdout: `${sha}\n` });
        if (args.includes("ls-tree")) return result({ stdout: options.tree ?? BASE });
        if (args.includes("checkout")) {
            if (options.checkout) return options.checkout;
            const index = args.indexOf("--work-tree");
            const tree = args[index + 1]!;
            if (options.populate) await options.populate(tree);
            else await populateDefault(tree);
            return result();
        }
        return result();
    };
}

async function populateDefault(tree: string): Promise<void> {
    await mkdir(join(tree, "public"), { recursive: true });
    await writeFile(join(tree, "public", "index.php"), "<?php echo 'index';\n");
    await writeFile(join(tree, "public", "static.txt"), "static\n");
}

async function makeStack(): Promise<string> {
    const stack = await mkdtemp(join(tmpdir(), "cp-git-release-"));
    await mkdir(join(stack, "site", "staging"), { recursive: true, mode: 0o700 });
    await mkdir(join(stack, "site", "runtime", "releases"), { recursive: true });
    await mkdir(join(stack, "site", "private"), { recursive: true, mode: 0o700 });
    return stack;
}

function deploy(stack: string, runner: GitRunner, overrides: Partial<GitReleaseRequest> = {}): Promise<GitReleaseResult> {
    return fetchAndPublishGitRelease({
        stackDir: stack,
        attemptId: "attempt0001",
        siteId: "acme-shop",
        url: URL,
        ref: REF,
        runner,
        ...overrides,
    });
}

async function exists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}

describe("parseGitCommit", () => {
    test("accepts exactly one full lowercase SHA", () => {
        expect(parseGitCommit(`${SHA}\n`)).toBe(SHA);
        expect(parseGitCommit(SHA)).toBe(SHA);
    });

    test("refuses a short, decorated, uppercase or multi-line answer", () => {
        expect(parseGitCommit("aaaaaaa\n")).toBeNull();
        expect(parseGitCommit(`${SHA.toUpperCase()}\n`)).toBeNull();
        expect(parseGitCommit(`${SHA}\nextra\n`)).toBeNull();
        expect(parseGitCommit(`${SHA} (HEAD)\n`)).toBeNull();
        expect(parseGitCommit("")).toBeNull();
    });
});

describe("parseGitTreeListing", () => {
    const limits = { maxFiles: 100, maxTreeBytes: 1024 * 1024 };

    test("counts blobs and bytes", () => {
        const parsed = parseGitTreeListing(listing(entry("a", 7), entry("b/c", 3)), limits);
        expect(parsed).toEqual({ ok: true, files: 2, bytes: 10 });
    });

    test("refuses symlinks and submodules from the tree object", () => {
        expect(parseGitTreeListing(listing(entry("link", 0, "120000")), limits).ok).toBe(false);
        expect(parseGitTreeListing(listing(entry("sub", 0, "160000", "commit")), limits).ok).toBe(false);
    });

    test("refuses traversing, absolute, .git and control-character paths", () => {
        for (const path of ["../escape", "/absolute", "a/../b", ".git/config", "a/.git/b", "a//b", "a/\u0001b", ""]) {
            expect(parseGitTreeListing(listing(entry(path)), limits).ok).toBe(false);
        }
    });

    test("refuses an unsupported file mode and a malformed record", () => {
        expect(parseGitTreeListing(listing(entry("a", 1, "100600")), limits).ok).toBe(false);
        expect(parseGitTreeListing("not a tree listing", limits).ok).toBe(false);
    });

    test("enforces the file and byte bounds", () => {
        const two = listing(entry("a", 1), entry("b", 1));
        expect(parseGitTreeListing(two, { maxFiles: 1, maxTreeBytes: 1024 }).ok).toBe(false);
        expect(parseGitTreeListing(two, { maxFiles: 10, maxTreeBytes: 1 }).ok).toBe(false);
    });
});

describe("parseReleaseMetadata", () => {
    test("accepts the exact completed-release record", () => {
        expect(parseReleaseMetadata(JSON.stringify({ version: 1, siteId: "acme-shop", release: SHA, status: "complete" }))).toEqual({
            siteId: "acme-shop",
            release: SHA,
        });
    });

    test("refuses a wrong version, status, field set or release id", () => {
        const base = { version: 1, siteId: "acme-shop", release: SHA, status: "complete" };
        expect(parseReleaseMetadata(JSON.stringify({ ...base, version: 2 }))).toBeNull();
        expect(parseReleaseMetadata(JSON.stringify({ ...base, status: "staged" }))).toBeNull();
        expect(parseReleaseMetadata(JSON.stringify({ ...base, extra: true }))).toBeNull();
        expect(parseReleaseMetadata(JSON.stringify({ ...base, release: SHA.toUpperCase() }))).toBeNull();
        expect(parseReleaseMetadata("not json")).toBeNull();
    });
});

describe("gitEnvironment", () => {
    test("builds a neutralised environment from an allow-list", () => {
        const env = gitEnvironment("/opt/stacks/acme/site/private/git", "/opt/stacks/acme/site/staging/a");
        expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
        expect(env.GIT_TERMINAL_PROMPT).toBe("0");
        expect(env.GIT_ALLOW_PROTOCOL).toBe("https");
        expect(env.GIT_HTTP_FOLLOW_REDIRECTS).toBe("0");
        expect(env.GIT_CEILING_DIRECTORIES).toBe("/opt/stacks/acme/site/staging/a");
        expect(env.HOME).toBe(join("/opt/stacks/acme/site/private/git", "home"));
        expect(env.XDG_CONFIG_HOME).toBe(join("/opt/stacks/acme/site/private/git", "xdg"));
        expect(env.GIT_DIR).toBeUndefined();
        expect(env.GIT_WORK_TREE).toBeUndefined();
    });
});

describe("fetchAndPublishGitRelease", () => {
    test("fetches, verifies and publishes one immutable release", async () => {
        const stack = await makeStack();
        const outcome = await deploy(stack, fakeRunner());
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;

        expect(outcome.releaseId).toBe(SHA);
        expect(outcome.reused).toBe(false);
        const release = join(stack, "site", "runtime", "releases", SHA);
        expect(await readFile(join(release, "public", "index.php"), "utf8")).toContain("index");
        expect(await readFile(join(release, ".compose-panel", "revision.php"), "utf8")).toBe(revisionScript(SHA));
        const metadata = JSON.parse(await readFile(join(stack, "site", "private", "releases", `${SHA}.json`), "utf8")) as Record<
            string,
            unknown
        >;
        expect(metadata).toEqual({ version: 1, siteId: "acme-shop", release: SHA, status: "complete" });
        // The attempt staging directory is removed after a successful publish.
        expect(await exists(join(stack, "site", "staging", "attempt0001"))).toBe(false);
        if (process.platform === "linux") {
            expect((await stat(release)).mode & 0o777).toBe(0o755);
            expect((await stat(join(release, "public", "index.php"))).mode & 0o777).toBe(0o644);
        }
    });

    test("revalidates an existing complete release instead of rewriting it", async () => {
        const stack = await makeStack();
        const first = await deploy(stack, fakeRunner());
        expect(first.ok).toBe(true);
        const release = join(stack, "site", "runtime", "releases", SHA);
        const before = await readFile(join(release, ".compose-panel", "revision.php"), "utf8");

        const second = await deploy(stack, fakeRunner(), { attemptId: "attempt0002" });
        expect(second.ok).toBe(true);
        if (!second.ok) return;
        expect(second.reused).toBe(true);
        expect(await readdir(join(stack, "site", "runtime", "releases"))).toEqual([SHA]);
        expect(await readFile(join(release, ".compose-panel", "revision.php"), "utf8")).toBe(before);
        expect(await exists(join(stack, "site", "staging", "attempt0002"))).toBe(false);
    });

    test("refuses an existing release without complete metadata", async () => {
        const stack = await makeStack();
        const release = join(stack, "site", "runtime", "releases", SHA);
        await mkdir(release, { recursive: true });

        const outcome = await deploy(stack, fakeRunner());
        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect(outcome.phase).toBe("inspect");
        expect(outcome.cleanup).toBe("removed");
        expect(await exists(release)).toBe(true);
    });

    test("refuses metadata without its release directory", async () => {
        const stack = await makeStack();
        await mkdir(join(stack, "site", "private", "releases"), { recursive: true });
        await writeFile(
            join(stack, "site", "private", "releases", `${SHA}.json`),
            JSON.stringify({ version: 1, siteId: "acme-shop", release: SHA, status: "complete" }),
        );
        const outcome = await deploy(stack, fakeRunner());
        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect(outcome.phase).toBe("inspect");
    });

    test("refuses a repository symlink or submodule before any checkout", async () => {
        const stack = await makeStack();
        const symlink = await deploy(stack, fakeRunner({ tree: listing(entry("public/index.php", 1), entry("link", 0, "120000")) }));
        expect(symlink.ok).toBe(false);
        if (!symlink.ok) expect(symlink.cleanup).toBe("removed");

        const submodule = await deploy(
            stack,
            fakeRunner({ tree: listing(entry("public/index.php", 1), entry("sub", 0, "160000", "commit")) }),
            {
                attemptId: "attempt0002",
            },
        );
        expect(submodule.ok).toBe(false);
        expect(await readdir(join(stack, "site", "runtime", "releases"))).toEqual([]);
        expect(await readdir(join(stack, "site", "staging"))).toEqual([]);
    });

    test("refuses a .git entry, a missing public/ and a missing front controller", async () => {
        const stack = await makeStack();
        const dotGit = await deploy(stack, fakeRunner({ tree: listing(entry("public/index.php", 1), entry(".git/config", 1)) }));
        expect(dotGit.ok).toBe(false);

        const noPublic = await deploy(
            stack,
            fakeRunner({
                tree: listing(entry("index.php", 1)),
                populate: async (tree) => writeFile(join(tree, "index.php"), "<?php\n"),
            }),
            { attemptId: "attempt0002" },
        );
        expect(noPublic.ok).toBe(false);

        const noIndex = await deploy(
            stack,
            fakeRunner({
                tree: listing(entry("public/readme.txt", 1)),
                populate: async (tree) => {
                    await mkdir(join(tree, "public"), { recursive: true });
                    await writeFile(join(tree, "public", "readme.txt"), "hi\n");
                },
            }),
            { attemptId: "attempt0003" },
        );
        expect(noIndex.ok).toBe(false);
        if (!noIndex.ok) expect(noIndex.phase).toBe("prepare");
        expect(await readdir(join(stack, "site", "runtime", "releases"))).toEqual([]);
    });

    test("refuses a tree that only the checkout reveals (reserved .compose-panel)", async () => {
        const stack = await makeStack();
        const outcome = await deploy(
            stack,
            fakeRunner({
                populate: async (tree) => {
                    await populateDefault(tree);
                    await mkdir(join(tree, ".compose-panel"), { recursive: true });
                    await writeFile(join(tree, ".compose-panel", "revision.php"), "<?php echo 'forged';\n");
                },
            }),
        );
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) expect(outcome.phase).toBe("prepare");
        expect(await readdir(join(stack, "site", "runtime", "releases"))).toEqual([]);
    });

    test("refuses an oversized tree before checkout", async () => {
        const stack = await makeStack();
        const outcome = await deploy(stack, fakeRunner(), { limits: { maxFiles: 1 } });
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) expect(outcome.phase).toBe("inspect");
    });

    test("cleans up only its own staging directory after a failed fetch", async () => {
        const stack = await makeStack();
        const outcome = await deploy(
            stack,
            fakeRunner({ fetch: result({ code: 128, stderr: "fatal: could not read from remote repository\n" }) }),
        );
        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect(outcome.phase).toBe("fetch");
        expect(outcome.detail).toContain("could not read");
        expect(outcome.cleanup).toBe("removed");
        expect(await readdir(join(stack, "site", "staging"))).toEqual([]);
        expect(await readdir(join(stack, "site", "runtime", "releases"))).toEqual([]);
    });

    test("stops a transfer that exceeds the download cap and cleans up", async () => {
        const stack = await makeStack();
        let aborted = false;
        const base = fakeRunner();
        const runner: GitRunner = async (args, options) => {
            if (args.includes("fetch")) {
                const index = args.indexOf("-C");
                const repo = args[index + 1]!;
                await mkdir(join(repo, ".git", "objects", "pack"), { recursive: true });
                await writeFile(join(repo, ".git", "objects", "pack", "tmp.pack"), Buffer.alloc(4096));
                await new Promise<void>((resolve) => {
                    const signal = options?.signal;
                    if (signal?.aborted) {
                        aborted = true;
                        resolve();
                        return;
                    }
                    signal?.addEventListener(
                        "abort",
                        () => {
                            aborted = true;
                            resolve();
                        },
                        { once: true },
                    );
                });
                return result({ code: -1, timedOut: true });
            }
            return base(args, options);
        };
        const outcome = await deploy(stack, runner, { limits: { maxDownloadBytes: 1024, monitorIntervalMs: 10 } });
        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect(outcome.phase).toBe("fetch");
        expect(outcome.reason).toContain("byte limit");
        expect(aborted).toBe(true);
        expect(outcome.cleanup).toBe("removed");
        expect(await readdir(join(stack, "site", "staging"))).toEqual([]);
        expect(await readdir(join(stack, "site", "runtime", "releases"))).toEqual([]);
    });

    test("reports an unconfirmed fetch instead of a plain failure", async () => {
        const stack = await makeStack();
        const outcome = await deploy(stack, fakeRunner({ fetch: result({ code: -1, timedOut: true, terminationUnconfirmed: true }) }));
        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect(outcome.unconfirmed).toBe(true);
        expect(outcome.phase).toBe("fetch");
    });

    test("refuses to reuse a staging directory that already exists", async () => {
        const stack = await makeStack();
        const stale = join(stack, "site", "staging", "attempt0001");
        await mkdir(stale);
        await writeFile(join(stale, "marker"), "keep\n");

        const outcome = await deploy(stack, fakeRunner());
        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect(outcome.cleanup).toBe("none");
        expect(await readFile(join(stale, "marker"), "utf8")).toBe("keep\n");
    });

    test("refuses before fetching when the layout is incomplete or unsafe", async () => {
        const stack = await makeStack();
        await rm(join(stack, "site", "staging"), { recursive: true });

        let called = false;
        const runner: GitRunner = async () => {
            called = true;
            return result();
        };
        const outcome = await deploy(stack, runner);
        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect(outcome.phase).toBe("layout");
        expect(called).toBe(false);
    });

    test("refuses an invalid stack path, attempt id, URL or ref without touching the disk", async () => {
        const stack = await makeStack();
        const runner: GitRunner = async () => {
            throw new Error("must not run");
        };
        for (const request of [
            { stackDir: `${stack}/` },
            { attemptId: "short" },
            { attemptId: "UPPERCASE1" },
            { url: "http://github.com/acme/shop.git" },
            { url: "https://user:secret@github.com/acme/shop.git" },
            { ref: "main" },
            { ref: "refs/heads/release.lock/v1" },
        ]) {
            const outcome = await deploy(stack, runner, request);
            expect(outcome.ok).toBe(false);
            if (!outcome.ok) expect(outcome.phase).toBe("layout");
        }
    });

    test("passes fixed, explicit arguments and the neutralised environment", async () => {
        const stack = await makeStack();
        const calls: Array<{ args: string[]; options: RunOptions }> = [];
        const inner = fakeRunner();
        const runner: GitRunner = (args, options) => {
            calls.push({ args, options });
            return inner(args, options);
        };
        const outcome = await deploy(stack, runner);
        expect(outcome.ok).toBe(true);

        const fetch = calls.find((call) => call.args.includes("fetch"))!;
        expect(fetch.args).toContain("--depth");
        expect(fetch.args).toContain("1");
        expect(fetch.args).toContain("--no-recurse-submodules");
        expect(fetch.args).toContain("fetch.unpackLimit=1");
        expect(fetch.args).toContain("transfer.unpackLimit=1");
        expect(fetch.args.slice(-2)).toEqual([URL, REF]);
        expect(fetch.args).toContain("protocol.allow=never");
        expect(fetch.args).toContain("protocol.https.allow=always");
        expect(fetch.options.env?.GIT_CONFIG_NOSYSTEM).toBe("1");
        expect(fetch.options.env?.GIT_TERMINAL_PROMPT).toBe("0");
        expect(fetch.options.env?.HOME?.startsWith(stack)).toBe(true);

        const checkout = calls.find((call) => call.args.includes("checkout"))!;
        expect(checkout.args).toContain("--force");
        expect(checkout.args).toContain("--detach");
        expect(checkout.args).not.toContain("--recurse-submodules");
    });
});
