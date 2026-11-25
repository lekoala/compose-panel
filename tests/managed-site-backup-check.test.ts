import { describe, expect, test } from "bun:test";
import {
    MANAGED_SITE_BACKUP_CHECK_OUTPUT_MAX_BYTES,
    MANAGED_SITE_BACKUP_CHECK_TIMEOUT_MS,
    managedSiteBackupCheckArgs,
    runManagedSiteBackupCheck,
} from "../src/managed-site-backup-check.ts";
import type { CommandResult, DockerRunner, RunOptions } from "../src/docker.ts";
import { MANAGED_SITE_RESTIC_IMAGE } from "../src/managed-site-restic.ts";
import type { ManagedSiteManifest } from "../src/managed-site.ts";

const SITE = "acme-shop";
const STACK = "/opt/stacks/acme-shop";

const manifest: ManagedSiteManifest = {
    version: 3,
    siteId: SITE,
    owner: "managed",
    project: SITE,
    services: { gateway: "web", runtime: "runtime" },
    gateway: { port: 41001 },
    publicRoot: "public",
    runtime: { profile: "php-front-controller", image: "php:8.3-fpm-alpine" },
    deploy: { kind: "bind-mount", git: { url: "https://github.com/acme/shop.git", ref: "refs/heads/main" } },
    paths: ["shared/uploads"],
    generation: "1",
    backup: { kind: "restic", repository: "rest:https://backup.example.test/acme-shop" },
};

const CLEAN = `load indexes
check all packs
check snapshots, trees and blobs
[0:00] 100.00%  1 / 1 snapshots
read 1291 bytes of data packs
[0:00] 100.00%  2 / 2 packs
no errors were found
`;

const commandOk = (stdout = CLEAN): CommandResult => ({ code: 0, stdout, stderr: "", timedOut: false, truncated: false });

function fakeDocker(calls: { args: string[]; options?: RunOptions }[], result: CommandResult = commandOk()): DockerRunner {
    return async (args, options) => {
        calls.push({ args, options });
        return result;
    };
}

describe("repository check command", () => {
    test("runs one bounded read-only check and never mutates or repairs", () => {
        const args = managedSiteBackupCheckArgs();
        expect(args).toEqual(["check", "--no-lock", "--read-data-subset", "32M"]);
        expect(args).not.toContain("--read-data");
        expect(args).not.toContain("forget");
        expect(args).not.toContain("prune");
        expect(args).not.toContain("unlock");
        expect(args).not.toContain("repair");
        expect(args.some((entry) => /^[0-9a-f]{64}$/.test(entry))).toBe(false);
    });

    test("uses the pinned client, the fixed bounds and the operator credential file", async () => {
        const calls: { args: string[]; options?: RunOptions }[] = [];
        const result = await runManagedSiteBackupCheck({ stackDir: STACK, manifest }, { docker: fakeDocker(calls) });
        expect(result).toEqual({ ok: true });
        expect(calls).toHaveLength(1);
        const { args, options } = calls[0]!;
        expect(args).toContain(MANAGED_SITE_RESTIC_IMAGE);
        expect(args).toContain("check");
        expect(args).toContain("--no-lock");
        expect(args).toContain("--read-data-subset");
        expect(args).toContain("32M");
        expect(args).toContain("--read-only");
        expect(args).toContain("RESTIC_PASSWORD_FILE=/run/secrets/restic-password");
        expect(args).toContain(`RESTIC_REPOSITORY=${manifest.backup!.repository}`);
        expect(args).not.toContain("--read-data");
        expect(args).not.toContain("forget");
        expect(args).not.toContain("prune");
        expect(args).not.toContain("unlock");
        expect(args).not.toContain("repair");
        expect(options?.timeoutMs).toBe(MANAGED_SITE_BACKUP_CHECK_TIMEOUT_MS);
        expect(options?.maxBytes).toBe(MANAGED_SITE_BACKUP_CHECK_OUTPUT_MAX_BYTES);
    });

    test("accepts only Restic's own confirmation, not a bare zero exit", async () => {
        const silent = await runManagedSiteBackupCheck(
            { stackDir: STACK, manifest },
            { docker: fakeDocker([], { code: 0, stdout: "load indexes\n", stderr: "", timedOut: false, truncated: false }) },
        );
        expect(silent.ok).toBe(false);
        if (!silent.ok) expect(silent.reason).toContain("confirmation");

        const wrongText = await runManagedSiteBackupCheck(
            { stackDir: STACK, manifest },
            {
                docker: fakeDocker([], {
                    code: 0,
                    stdout: "no errors were found in docs\n",
                    stderr: "",
                    timedOut: false,
                    truncated: false,
                }),
            },
        );
        expect(wrongText.ok).toBe(false);
    });

    test("maps the documented exit codes to fixed messages without leaking output", async () => {
        const cases: [number, string][] = [
            [1, "errors in the repository"],
            [10, "could not find the repository"],
            [11, "holds the repository lock"],
            [12, "password does not open"],
            [99, "exit code 99"],
        ];
        for (const [code, expected] of cases) {
            const result = await runManagedSiteBackupCheck(
                { stackDir: STACK, manifest },
                {
                    docker: fakeDocker([], {
                        code,
                        stdout: "",
                        stderr: "Fatal: repository contains errors\nrestic repair packs abcdef\npack 0123 damaged",
                        timedOut: false,
                        truncated: false,
                    }),
                },
            );
            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.reason).toContain(expected);
                expect(result.reason).not.toContain("repair");
                expect(result.reason).not.toContain("0123");
            }
        }
    });

    test("refuses a timeout and truncated output without claiming a result", async () => {
        const timedOut = await runManagedSiteBackupCheck(
            { stackDir: STACK, manifest },
            { docker: fakeDocker([], { code: 0, stdout: "", stderr: "", timedOut: true, truncated: false }) },
        );
        expect(timedOut.ok).toBe(false);
        if (!timedOut.ok) expect(timedOut.reason).toContain("did not finish");

        const truncated = await runManagedSiteBackupCheck(
            { stackDir: STACK, manifest },
            { docker: fakeDocker([], { code: 0, stdout: CLEAN, stderr: "", timedOut: false, truncated: true }) },
        );
        expect(truncated.ok).toBe(false);
        if (!truncated.ok) expect(truncated.reason).toContain("more output");
    });

    test("refuses a site without a backup block before running a container", async () => {
        const calls: { args: string[] }[] = [];
        const result = await runManagedSiteBackupCheck(
            { stackDir: STACK, manifest: { ...manifest, backup: undefined } },
            { docker: fakeDocker(calls) },
        );
        expect(result).toEqual({ ok: false, reason: "This site declares no backup block." });
        expect(calls).toEqual([]);
    });
});
