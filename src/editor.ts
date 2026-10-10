import { dirname, join } from "node:path";
import { rm, writeFile } from "node:fs/promises";
import { locateComposeFile, StackError } from "./stacks.ts";
import { resolveProjectContext } from "./status.ts";
import { backupFile, hashContent, randomSuffix, readFileSafe, writeFileAtomic, type SafeFile } from "./fs-safe.ts";
import type { ComposeProvider } from "./compose-provider.ts";

export const ENV_FILENAME = ".env";
const ABSENT_HASH = hashContent("");

export class StackConflictError extends Error {
    constructor(message = "The file changed on disk since the form was loaded.") {
        super(message);
        this.name = "StackConflictError";
    }
}

export class StackValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "StackValidationError";
    }
}

/**
 * A save that changed files without completing. Carries the backup paths so
 * the UI can point at manual recovery. Never invents a success.
 */
export class StackPartialError extends StackError {
    readonly backupPaths: string[];
    constructor(message: string, backupPaths: string[] = []) {
        super(message, 500);
        this.name = "StackPartialError";
        this.backupPaths = backupPaths;
    }
}

export interface EditableStack {
    name: string;
    composeFilename: string;
    composeSource: string;
    composeHash: string;
    composeMode: number;
    envExists: boolean;
    envSource: string;
    envHash: string;
    envMode: number | null;
}

export async function readEditableStack(root: string, name: string, maxBytes: number): Promise<EditableStack> {
    const located = await locateComposeFile(root, name);
    const compose = await readFileSafe(located.path, maxBytes);
    if (!compose) throw new StackError("Compose file not found.", 404);
    const env = await readFileSafe(join(dirname(located.path), ENV_FILENAME), maxBytes);
    return {
        name,
        composeFilename: located.filename,
        composeSource: compose.source,
        composeHash: compose.hash,
        composeMode: compose.mode,
        envExists: env !== null,
        envSource: env?.source ?? "",
        envHash: env ? env.hash : ABSENT_HASH,
        envMode: env?.mode ?? null,
    };
}

/** Values from a .env file that must never appear in an error message or a log. */
export function collectSecrets(envSource: string): string[] {
    const secrets: string[] = [];
    for (const line of envSource.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const index = trimmed.indexOf("=");
        if (index === -1) continue;
        let value = trimmed.slice(index + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (value.length >= 4) secrets.push(value);
    }
    return secrets;
}

export function redactSecrets(text: string, secrets: string[]): string {
    let output = text;
    for (const secret of secrets) {
        if (secret.length < 4) continue;
        output = output.split(secret).join("***");
    }
    return output;
}

function firstLines(text: string, maxLines = 6, maxChars = 1000): string {
    return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(0, maxLines).join("\n").slice(0, maxChars).trim();
}

export interface ValidationResult {
    ok: boolean;
    message: string | null;
}

/**
 * Validate a draft in its real project context: same directory, same relative
 * paths, explicit -f and --env-file, `config --quiet` only (never an
 * interpolated config). Temp files are removed whatever happens.
 */
export async function validateDraft(
    provider: ComposeProvider,
    directory: string,
    composeSource: string,
    envSource: string | undefined,
    secrets: string[],
    projectName?: string,
): Promise<ValidationResult> {
    const composeTmp = join(directory, `.cp-draft-${randomSuffix()}.yaml`);
    let envTmp: string | null = null;
    try {
        await writeFile(composeTmp, composeSource, { mode: 0o600 });
        if (envSource !== undefined) {
            envTmp = join(directory, `.cp-draft-env-${randomSuffix()}`);
            await writeFile(envTmp, envSource, { mode: 0o600 });
        }

        const result = await provider.validateConfig({
            directory,
            composeFile: composeTmp,
            envFile: envTmp ?? undefined,
            projectName,
        });
        if (result.timedOut) return { ok: false, message: "Compose validation timed out." };
        if (result.code !== 0) {
            const raw = firstLines(result.stderr) || "Compose validation failed.";
            return { ok: false, message: redactSecrets(raw, secrets) };
        }
        return { ok: true, message: null };
    } finally {
        await rm(composeTmp, { force: true }).catch(() => {});
        if (envTmp) await rm(envTmp, { force: true }).catch(() => {});
    }
}

export interface SaveRequest {
    composeSource: string;
    envSource: string;
    baseComposeHash: string;
    baseEnvHash: string;
    baseEnvExists: boolean;
}

export interface SaveResult {
    changed: boolean;
    composeHash: string;
    envHash: string;
    envExists: boolean;
    backupPaths: string[];
}

/**
 * Save the Compose/.env pair under an optimistic lock: check the base hashes,
 * validate in context, re-check what validation may have raced with, back up
 * both files before touching either, then write atomically. A failure after
 * the first write restores it and reports a partial result with backup
 * references instead of an ordinary error.
 */
export interface SaveOptions {
    /** Override for the atomic file writer. Test seam for commit-phase failures. */
    writer?: (path: string, content: string, mode: number) => Promise<void>;
}

export async function saveEditableStack(
    root: string,
    name: string,
    request: SaveRequest,
    provider: ComposeProvider,
    maxBytes: number,
    options: SaveOptions = {},
): Promise<SaveResult> {
    const located = await locateComposeFile(root, name);
    const directory = dirname(located.path);
    const composePath = located.path;
    const envPath = join(directory, ENV_FILENAME);

    const currentCompose = await readFileSafe(composePath, maxBytes);
    if (!currentCompose) throw new StackError("Compose file not found.", 404);
    const currentEnv = await readFileSafe(envPath, maxBytes);
    const currentEnvExists = currentEnv !== null;
    const currentEnvHash = currentEnv ? currentEnv.hash : ABSENT_HASH;

    if (currentCompose.hash !== request.baseComposeHash) throw new StackConflictError("The Compose file changed on disk.");
    if (currentEnvExists !== request.baseEnvExists || currentEnvHash !== request.baseEnvHash) {
        throw new StackConflictError("The .env file changed on disk.");
    }

    const composeChanged = request.composeSource !== currentCompose.source;
    const envDesiredExists = request.baseEnvExists || request.envSource.length > 0;
    const envChanged = envDesiredExists !== currentEnvExists
        || (envDesiredExists && currentEnv !== null && request.envSource !== currentEnv.source);

    if (!composeChanged && !envChanged) {
        return { changed: false, composeHash: currentCompose.hash, envHash: currentEnvHash, envExists: currentEnvExists, backupPaths: [] };
    }

    const secrets = [...collectSecrets(currentEnv?.source ?? ""), ...collectSecrets(request.envSource)];
    // Validate in the same project identity mutations will use when it is
    // known. Saves stay possible while Docker is unreachable or ambiguous
    // (editing local files, not controlling a project); validation then runs
    // without -p exactly as before.
    const context = await resolveProjectContext(root, name, provider).catch(() => null);
    const validation = await validateDraft(
        provider,
        directory,
        request.composeSource,
        envChanged ? request.envSource : undefined,
        secrets,
        context?.kind === "resolved" ? context.project ?? undefined : undefined,
    );
    if (!validation.ok) throw new StackValidationError(validation.message ?? "Compose validation failed.");

    // Validation awaits a subprocess for seconds; an external writer may have
    // acted meanwhile. Re-locate (presence/identity) and re-read both files:
    // anything divergent is a conflict, never a silent overwrite. The lock
    // only serializes panel requests, not outside editors.
    const relocated = await locateComposeFile(root, name);
    if (relocated.path !== located.path) {
        throw new StackConflictError("The stack directory changed on disk during validation.");
    }
    let freshCompose: SafeFile | null;
    let freshEnv: SafeFile | null;
    try {
        freshCompose = await readFileSafe(composePath, maxBytes);
        freshEnv = await readFileSafe(envPath, maxBytes);
    } catch {
        throw new StackConflictError("The files changed on disk during validation.");
    }
    if (!freshCompose) throw new StackError("Compose file not found.", 404);
    if (freshCompose.hash !== currentCompose.hash) {
        throw new StackConflictError("The Compose file changed on disk during validation.");
    }
    if (freshEnv !== null ? freshEnv.hash !== currentEnvHash : currentEnvExists) {
        throw new StackConflictError("The .env file changed on disk during validation.");
    }

    const backupDir = join(root, ".compose-panel", "backups", name);
    const backupPaths: string[] = [];
    const writer = options.writer ?? writeFileAtomic;
    let composeWritten = false;

    // Phase 1 — back up everything before changing anything. A failure here
    // leaves both live files untouched, so it stays an ordinary error.
    if (composeChanged) backupPaths.push(await backupFile(composePath, backupDir, located.filename));
    if (envChanged && freshEnv) backupPaths.push(await backupFile(envPath, backupDir, ENV_FILENAME));

    // Phase 2 — commit with rollback. Each rename is atomic; the only
    // inconsistent state is "first write done, second failed".
    try {
        if (composeChanged) {
            await writer(composePath, request.composeSource, freshCompose.mode);
            composeWritten = true;
        }
        if (envChanged) await writer(envPath, request.envSource, freshEnv?.mode ?? 0o600);
    } catch (error) {
        if (!composeWritten) throw error;
        try {
            await writer(composePath, freshCompose.source, freshCompose.mode);
        } catch {
            throw new StackPartialError(
                `Save failed and the Compose file could not be restored. Recover it manually from: ${backupPaths.join(", ")}`,
                backupPaths,
            );
        }
        throw new StackPartialError(
            `Save failed after writing the Compose file; it was restored from backup (${backupPaths.join(", ")}).`,
            backupPaths,
        );
    }

    return {
        changed: true,
        composeHash: composeChanged ? hashContent(request.composeSource) : currentCompose.hash,
        envHash: envChanged ? hashContent(request.envSource) : currentEnvHash,
        envExists: envDesiredExists,
        backupPaths,
    };
}
