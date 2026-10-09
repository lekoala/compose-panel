import { dirname, join } from "node:path";
import { rm, writeFile } from "node:fs/promises";
import { locateComposeFile, StackError } from "./stacks.ts";
import { backupFile, hashContent, randomSuffix, readFileSafe, writeFileAtomic } from "./fs-safe.ts";
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
 * Save the Compose/.env pair under an optimistic lock: re-check the base hashes,
 * validate in context, back up, then write atomically. If the second write fails
 * the first is restored.
 */
export async function saveEditableStack(
    root: string,
    name: string,
    request: SaveRequest,
    provider: ComposeProvider,
    maxBytes: number,
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
    const validation = await validateDraft(provider, directory, request.composeSource, envChanged ? request.envSource : undefined, secrets);
    if (!validation.ok) throw new StackValidationError(validation.message ?? "Compose validation failed.");

    const backupDir = join(root, ".compose-panel", "backups", name);
    const backupPaths: string[] = [];
    let composeWritten = false;

    if (composeChanged) {
        backupPaths.push(await backupFile(composePath, backupDir, located.filename));
        await writeFileAtomic(composePath, request.composeSource, currentCompose.mode);
        composeWritten = true;
    }

    if (envChanged) {
        if (currentEnv) backupPaths.push(await backupFile(envPath, backupDir, ENV_FILENAME));
        try {
            await writeFileAtomic(envPath, request.envSource, currentEnv?.mode ?? 0o600);
        } catch (error) {
            if (composeWritten) {
                await writeFileAtomic(composePath, currentCompose.source, currentCompose.mode).catch(() => {});
            }
            throw error;
        }
    }

    return {
        changed: true,
        composeHash: composeChanged ? hashContent(request.composeSource) : currentCompose.hash,
        envHash: envChanged ? hashContent(request.envSource) : currentEnvHash,
        envExists: envDesiredExists,
        backupPaths,
    };
}
