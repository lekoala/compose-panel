import { describe, expect, test } from "bun:test";
import {
    buildCatalog,
    buildRunnerArgv,
    isActionName,
    isSafeContainerPath,
    parseManifest,
    parseToolboxSources,
    type ToolboxSource,
} from "../src/toolbox.ts";

const LIMITS = { maxActions: 50, maxTimeoutMs: 900_000 };

const BACKEND: ToolboxSource = {
    id: "backend",
    service: "app",
    runner: "composer",
    workdir: "/app",
    user: "www-data",
    manifestFile: "composer.json",
};

function composerManifest(actions: Record<string, unknown>, scripts: Record<string, unknown> = { "cache:clear": "php bin/console cache:clear" }): string {
    return JSON.stringify({ scripts, extra: { "compose-panel": { version: 1, actions } } });
}

function npmManifest(actions: Record<string, unknown>, scripts: Record<string, unknown> = { build: "vite build" }): string {
    return JSON.stringify({ scripts, "compose-panel": { version: 1, actions } });
}

describe("parseToolboxSources", () => {
    test("returns no sources when the extension is absent", () => {
        expect(parseToolboxSources("services:\n  app:\n    image: nginx\n")).toEqual({ ok: true, value: [] });
    });

    test("parses a valid source and derives the manifest file", () => {
        const yaml = `x-compose-panel:
  toolbox:
    sources:
      - id: backend
        service: app
        runner: composer
        workdir: /app
        user: www-data
      - id: frontend
        service: node
        runner: bun
services:
  app:
    image: my-app:latest
`;
        const result = parseToolboxSources(yaml);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value).toHaveLength(2);
        expect(result.value[0]).toEqual({ ...BACKEND, manifestFile: "composer.json" });
        expect(result.value[1]!.manifestFile).toBe("package.json");
        expect(result.value[1]!.workdir).toBeNull();
        expect(result.value[1]!.user).toBeNull();
    });

    test("refuses an unknown runner", () => {
        const result = parseToolboxSources("x-compose-panel:\n  toolbox:\n    sources:\n      - id: a\n        service: app\n        runner: pnpm\n");
        expect(result.ok).toBe(false);
    });

    test("refuses a duplicate source id", () => {
        const result = parseToolboxSources(`x-compose-panel:
  toolbox:
    sources:
      - id: a
        service: app
        runner: npm
      - id: a
        service: web
        runner: npm
`);
        expect(result.ok).toBe(false);
    });

    test("refuses a relative or escaping workdir", () => {
        for (const workdir of ["app", "/app/../../etc", "./app"]) {
            const result = parseToolboxSources(`x-compose-panel:\n  toolbox:\n    sources:\n      - id: a\n        service: app\n        runner: npm\n        workdir: "${workdir}"\n`);
            expect(result.ok).toBe(false);
        }
    });

    test("ignores a cyclic alias elsewhere in the document", () => {
        const result = parseToolboxSources("a: &x\n  self: *x\nservices:\n  app:\n    image: nginx\n");
        expect(result.ok).toBe(true);
    });

    test("refuses a cyclic structure inside a source as a controlled error", () => {
        const result = parseToolboxSources("x-compose-panel:\n  toolbox:\n    sources:\n      - &s\n        id: *s\n        service: app\n        runner: npm\n");
        expect(result.ok).toBe(false);
    });
});

describe("parseManifest", () => {
    test("reads Composer extra and npm root forms", () => {
        const composer = parseManifest(composerManifest({ "cache:clear": {} }), "composer");
        expect(composer.ok).toBe(true);
        const npm = parseManifest(npmManifest({ build: {} }), "npm");
        expect(npm.ok).toBe(true);
    });

    test("refuses an unsupported schema version", () => {
        const raw = JSON.stringify({ scripts: {}, extra: { "compose-panel": { version: 2, actions: {} } } });
        expect(parseManifest(raw, "composer").ok).toBe(false);
    });

    test("refuses invalid JSON", () => {
        expect(parseManifest("{not json", "npm").ok).toBe(false);
    });
});

describe("isActionName / isSafeContainerPath", () => {
    test("accepts namespaced script names, refuses option-like names", () => {
        for (const good of ["cache:clear", "db:migrate", "build", "doctrine:migrations:migrate"]) expect(isActionName(good)).toBe(true);
        for (const bad of ["-rm", "a b", "--version", "", "a/b", "a@b"]) expect(isActionName(bad)).toBe(false);
    });

    test("requires an absolute, non-escaping container path", () => {
        expect(isSafeContainerPath("/app")).toBe(true);
        expect(isSafeContainerPath("app")).toBe(false);
        expect(isSafeContainerPath("/app/../etc")).toBe(false);
        expect(isSafeContainerPath("")).toBe(false);
    });
});

describe("buildRunnerArgv", () => {
    test("runs the runner, never the extracted command", () => {
        expect(buildRunnerArgv("composer", "cache:clear")).toEqual(["composer", "--no-interaction", "run-script", "cache:clear"]);
        expect(buildRunnerArgv("npm", "build")).toEqual(["npm", "run", "build"]);
        expect(buildRunnerArgv("bun", "check")).toEqual(["bun", "run", "check"]);
    });
});

describe("toolbox user format", () => {
    test("accepts a name, a uid, and uid:gid", () => {
        for (const user of ["www-data", "1000", "1000:1000", "www-data:www-data", "node:node"]) {
            const result = parseToolboxSources(`x-compose-panel:\n  toolbox:\n    sources:\n      - id: a\n        service: app\n        runner: npm\n        user: "${user}"\n`);
            expect(result.ok).toBe(true);
        }
        for (const user of ["-u", "a b", "", "1:2:3"]) {
            const result = parseToolboxSources(`x-compose-panel:\n  toolbox:\n    sources:\n      - id: a\n        service: app\n        runner: npm\n        user: "${user}"\n`);
            expect(result.ok).toBe(false);
        }
    });
});

describe("buildCatalog", () => {
    const execution = { containerId: "a".repeat(64), imageId: "sha256:" + "b".repeat(64) };

    test("maps declared actions, defaults the label and clamps the timeout", () => {
        const raw = composerManifest(
            { "cache:clear": { timeout: 5 }, "db:migrate": { label: "Migrate", confirmation: "Sure?", timeout: 100000 } },
            { "cache:clear": "php bin/console cache:clear", "db:migrate": "php bin/console doctrine:migrations:migrate" },
        );
        const result = buildCatalog(BACKEND, raw, execution, LIMITS);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const [cache, migrate] = result.value.actions;
        expect(cache).toMatchObject({ name: "cache:clear", label: "cache:clear", timeoutMs: 5000 });
        expect(migrate).toMatchObject({ name: "db:migrate", label: "Migrate", confirmation: "Sure?", timeoutMs: 900_000 });
        expect(result.value.revision).toMatch(/^[0-9a-f]{64}$/);
    });

    test("refuses an action with no matching script", () => {
        const raw = composerManifest({ "ghost:run": {} }, { "cache:clear": "x" });
        expect(buildCatalog(BACKEND, raw, execution, LIMITS).ok).toBe(false);
    });

    test("refuses an option-like action name", () => {
        const raw = composerManifest({ "-rm": {} }, { "-rm": "rm -rf /" });
        expect(buildCatalog(BACKEND, raw, execution, LIMITS).ok).toBe(false);
    });

    test("refuses an inherited property name as a script", () => {
        // `constructor` / `toString` exist on any object; they must not count as
        // declared scripts (`bun run constructor` would resolve a file/binary).
        expect(buildCatalog(BACKEND, composerManifest({ constructor: {} }, {}), execution, LIMITS).ok).toBe(false);
        expect(buildCatalog(BACKEND, composerManifest({ toString: {} }, {}), execution, LIMITS).ok).toBe(false);
    });

    test("requires a runnable script definition per runner", () => {
        const npmSource = { ...BACKEND, runner: "npm" as const, manifestFile: "package.json" as const };
        // npm/Bun: a missing or non-string value would let `bun run <name>` hit a file.
        for (const bad of [null, "", 123, [], {}] as unknown[]) {
            expect(buildCatalog(npmSource, npmManifest({ build: {} }, { build: bad }), execution, LIMITS).ok).toBe(false);
        }
        // Composer: a command string or an array of strings/callbacks is valid.
        expect(buildCatalog(BACKEND, composerManifest({ "cache:clear": {} }, { "cache:clear": "php x" }), execution, LIMITS).ok).toBe(true);
        expect(buildCatalog(BACKEND, composerManifest({ "cache:clear": {} }, { "cache:clear": ["@php", "-r", "echo 1"] }), execution, LIMITS).ok).toBe(true);
        expect(buildCatalog(BACKEND, composerManifest({ "cache:clear": {} }, { "cache:clear": null }), execution, LIMITS).ok).toBe(false);
    });

    test("accepts a script legitimately named like an Object property", () => {
        const raw = composerManifest({ constructor: {} }, { constructor: "php bin/console self-test" });
        expect(buildCatalog(BACKEND, raw, execution, LIMITS).ok).toBe(true);
    });

    test("changes when a referenced Composer script changes", () => {
        // `maintenance` references `@cleanup`; editing only `cleanup` must still
        // change the revision, or a stale page could launch a changed definition.
        const before = composerManifest({ maintenance: {} }, { maintenance: "@cleanup", cleanup: "rm -rf var/cache" });
        const after = composerManifest({ maintenance: {} }, { maintenance: "@cleanup", cleanup: "rm -rf var/cache /etc" });
        const a = buildCatalog(BACKEND, before, execution, LIMITS);
        const b = buildCatalog(BACKEND, after, execution, LIMITS);
        expect(a.ok && b.ok).toBe(true);
        if (!a.ok || !b.ok) return;
        expect(a.value.actions.map(action => action.name)).toEqual(["maintenance"]);
        expect(a.value.revision).not.toBe(b.value.revision);
    });

    test("is stable for identical inputs and changes when the script changes", () => {
        const base = composerManifest({ "cache:clear": {} }, { "cache:clear": "php bin/console cache:clear" });
        const changed = composerManifest({ "cache:clear": {} }, { "cache:clear": "rm -rf /tmp && php bin/console cache:clear" });
        const a = buildCatalog(BACKEND, base, execution, LIMITS);
        const b = buildCatalog(BACKEND, base, execution, LIMITS);
        const c = buildCatalog(BACKEND, changed, execution, LIMITS);
        expect(a.ok && b.ok && c.ok).toBe(true);
        if (!a.ok || !b.ok || !c.ok) return;
        expect(a.value.revision).toBe(b.value.revision);
        // Same metadata, different script body: the revision must differ.
        expect(a.value.revision).not.toBe(c.value.revision);
    });

    test("changes when the runner, user or workdir changes", () => {
        const raw = composerManifest({ "cache:clear": {} });
        const base = buildCatalog(BACKEND, raw, execution, LIMITS);
        const otherRunner = buildCatalog({ ...BACKEND, runner: "npm", manifestFile: "package.json" }, npmManifest({ "cache:clear": {} }, { "cache:clear": "x" }), execution, LIMITS);
        const otherUser = buildCatalog({ ...BACKEND, user: "root" }, raw, execution, LIMITS);
        const otherDir = buildCatalog({ ...BACKEND, workdir: "/srv" }, raw, execution, LIMITS);
        const otherContainer = buildCatalog(BACKEND, raw, { containerId: "c".repeat(64), imageId: execution.imageId }, LIMITS);
        expect(base.ok && otherRunner.ok && otherUser.ok && otherDir.ok && otherContainer.ok).toBe(true);
        if (!base.ok || !otherUser.ok || !otherDir.ok || !otherContainer.ok || !otherRunner.ok) return;
        expect(base.value.revision).not.toBe(otherRunner.value.revision);
        expect(base.value.revision).not.toBe(otherUser.value.revision);
        expect(base.value.revision).not.toBe(otherDir.value.revision);
        expect(base.value.revision).not.toBe(otherContainer.value.revision);
    });

    test("refuses more actions than the limit", () => {
        const actions: Record<string, unknown> = {};
        const scripts: Record<string, unknown> = {};
        for (let i = 0; i < 5; i += 1) { actions[`a${i}`] = {}; scripts[`a${i}`] = "x"; }
        expect(buildCatalog(BACKEND, composerManifest(actions, scripts), execution, { maxActions: 4, maxTimeoutMs: 1000 }).ok).toBe(false);
    });
});
