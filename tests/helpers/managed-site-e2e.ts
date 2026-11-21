import { join } from "node:path";
import { checkManagedSiteProfile } from "../../src/managed-site-profile.ts";
import {
    MANAGED_SITE_MANIFEST_FILE,
    MANAGED_SITE_MANIFEST_MAX_BYTES,
    parseManagedSiteManifest,
    type ManagedSiteManifest,
    type ManagedSiteManifestResult,
} from "../../src/managed-site.ts";
import { runManagedSiteDeploy, switchCurrent, type ManagedSiteDeployResult, type ManagedSiteProbe } from "../../src/managed-site-deploy.ts";
import { createContainerInspector } from "../../src/containers.ts";
import { createComposeProvider, type ComposeProvider, type ComposeProjectFiles } from "../../src/compose-provider.ts";
import { createDockerRunner, runCommand } from "../../src/docker.ts";
import { fetchAndPublishGitRelease, type GitRunner } from "../../src/git-release.ts";
import { readFileSafe } from "../../src/fs-safe.ts";

/**
 * Wiring shared by the managed-site end-to-end suite and its crash child.
 *
 * Only the deploy module is under test here. The probe is executed inside the
 * disposable Docker-in-Docker container, through `docker exec`, because that
 * daemon's gateway binds 127.0.0.1 in its own network namespace: the host can
 * reach the binding no other way. The probe contract (HTTP 200 plus exactly 41
 * bytes) is still applied by the deploy, and the real `createManagedSiteProbe`
 * is covered by its own unit test and the shell lab.
 */
export interface ManagedSiteE2EConfig {
    /** Canonical absolute stack directory, identical on the host and in the lab daemon. */
    stackDir: string;
    siteId: string;
    project: string;
    composeFile: string;
    /** Published loopback port of the gateway. */
    port: number;
    /** Manifest URL; mapped by the injected Git runner to the local bare repository. */
    gitUrl: string;
    gitRef: string;
    /** Bare repository served in place of `gitUrl`. */
    bareRepo: string;
    /** Disposable Docker-in-Docker container, for the loopback probe. */
    labContainer: string;
    /** Outer Docker context, when the caller did not use the default one. */
    labOuterContext?: string;
    attemptId: string;
}

export interface ManagedSiteE2EHooks {
    /** Runs after the gateway stop is attempted; used to kill the child. */
    afterStop?: () => Promise<void>;
    /** Runs after the pointer switch succeeded; used to kill the child. */
    afterSwitch?: () => Promise<void>;
}

/** No `COMPOSE_PANEL_*` variables, so the outer Docker CLI is used unchanged. */
export function outerDockerEnv(context: string | undefined): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) env[key] = value;
    }
    delete env.DOCKER_HOST;
    delete env.DOCKER_CONTEXT;
    if (context) env.DOCKER_CONTEXT = context;
    return env;
}

/**
 * The revision probe as seen from the lab daemon's own network namespace. A
 * connection failure, a non-2xx answer or any other output is `null`, which is
 * what the deploy treats as "not verified".
 */
export function createLabProbe(config: Pick<ManagedSiteE2EConfig, "labContainer" | "labOuterContext">): ManagedSiteProbe {
    const env = outerDockerEnv(config.labOuterContext);
    return async (port) => {
        const result = await runCommand(
            "docker",
            ["exec", config.labContainer, "wget", "-q", "-O", "-", `http://127.0.0.1:${port}/.compose-panel/revision`],
            { env, timeoutMs: 4000, maxBytes: 4096 },
        );
        if (result.code !== 0 || result.timedOut || result.truncated) return null;
        return { status: 200, body: result.stdout };
    };
}

/**
 * Map the manifest's public HTTPS URL onto the local bare fixture repository.
 *
 * The adapter's environment allows only the `https` transport, which is the
 * production contract. A local path is served by Git's `file` transport, so the
 * harness re-allows exactly that one protocol for this fixture; the protocol
 * refusal itself is covered by the unit tests. Everything else (fixed `git`
 * executable, neutralised HOME/config/hooks, shallow bounded fetch) is the real
 * adapter.
 */
export function createMappedGitRunner(url: string, bareRepo: string): GitRunner {
    return (args, options) => {
        const env = options.env ? { ...options.env, GIT_ALLOW_PROTOCOL: "https:file" } : undefined;
        return runCommand(
            "git",
            args.map((arg) => (arg === url ? bareRepo : arg)),
            {
                ...options,
                ...(env ? { env } : {}),
            },
        );
    };
}

function filesFor(config: ManagedSiteE2EConfig): ComposeProjectFiles {
    return { project: config.project, cwd: config.stackDir, composeFiles: [config.composeFile], envFiles: [] };
}

export async function deployWithE2E(config: ManagedSiteE2EConfig, hooks: ManagedSiteE2EHooks = {}): Promise<ManagedSiteDeployResult> {
    const docker = createDockerRunner({ timeoutMs: 60_000, maxBytes: 4 * 1024 * 1024 });
    const provider = createComposeProvider({ runner: docker });
    const files = filesFor(config);

    // Delegate every method to the real provider: spreading a class instance
    // would detach its private command builder.
    const deployProvider = {
        runningContainerIds: (input: Parameters<ComposeProvider["runningContainerIds"]>[0]) => provider.runningContainerIds(input),
        inspectImages: (refs: string[]) => provider.inspectImages(refs),
        stopService: async (input: Parameters<ComposeProvider["stopService"]>[0]) => {
            const result = await provider.stopService(input);
            if (hooks.afterStop) await hooks.afterStop();
            return result;
        },
        startService: (input: Parameters<ComposeProvider["startService"]>[0]) => provider.startService(input),
        recreateService: (input: Parameters<ComposeProvider["recreateService"]>[0]) => provider.recreateService(input),
    };

    const loadManifest = async (): Promise<ManagedSiteManifestResult> => {
        try {
            const file = await readFileSafe(join(config.stackDir, MANAGED_SITE_MANIFEST_FILE), MANAGED_SITE_MANIFEST_MAX_BYTES);
            if (!file) return { ok: false, reason: "This stack has no site manifest." };
            return parseManagedSiteManifest(file.source);
        } catch {
            return { ok: false, reason: "The site manifest could not be read." };
        }
    };

    const inspectProfile = async (manifest: ManagedSiteManifest) => {
        const facts = await provider.managedSiteFacts({ composeFile: config.composeFile, cwd: config.stackDir });
        if (!facts) return { ok: false as const, reason: "Docker did not return the effective Compose configuration." };
        if (facts.name !== manifest.project) {
            return { ok: false as const, reason: `The effective Compose project is "${facts.name}", not "${manifest.project}".` };
        }
        const checked = checkManagedSiteProfile({ manifest, stackDir: config.stackDir, facts });
        return checked.ok ? { ok: true as const, facts } : checked;
    };

    const switchPointer = hooks.afterSwitch
        ? async (runtimeDir: string, releaseId: string) => {
              const switched = await switchCurrent(runtimeDir, releaseId);
              if (switched.ok) await hooks.afterSwitch!();
              return switched;
          }
        : undefined;

    const gitRunner = createMappedGitRunner(config.gitUrl, config.bareRepo);
    return runManagedSiteDeploy({
        stackDir: config.stackDir,
        attemptId: config.attemptId,
        loadManifest,
        inspectProfile,
        provider: deployProvider,
        inspector: createContainerInspector({ runner: createDockerRunner({ timeoutMs: 60_000 }) }),
        files: () => files,
        fetchRelease: ({ manifest, attemptId, onOutput }) =>
            fetchAndPublishGitRelease({
                stackDir: config.stackDir,
                attemptId,
                siteId: manifest.siteId,
                url: config.gitUrl,
                ref: config.gitRef,
                runner: gitRunner,
                onOutput,
            }),
        probe: createLabProbe(config),
        now: () => Date.now(),
        sleep: (ms) => Bun.sleep(ms),
        isShuttingDown: () => false,
        onOutput: (chunk) => process.stdout.write(chunk),
        commandTimeoutMs: 60_000,
        probeDeadlineMs: 10_000,
        ...(switchPointer ? { switchPointer } : {}),
    });
}
