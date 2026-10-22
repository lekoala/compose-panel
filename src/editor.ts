import { dirname, join } from "node:path";
import { open, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { locateComposeFile, StackError, ENV_FILENAME } from "./stacks.ts";
import { resolveProjectContext } from "./status.ts";
import {
    backupFile,
    dirIdentity,
    ensureBackupDir,
    hashContent,
    randomSuffix,
    readFileSafe,
    sameDirIdentity,
    writeFileAtomic,
    type FileAttributes,
    type SafeFile,
} from "./fs-safe.ts";
import type { ComposeProvider } from "./compose-provider.ts";
import type { CommandResult } from "./docker.ts";

export { ENV_FILENAME } from "./stacks.ts";
const ABSENT_HASH = hashContent("");

export class StackConflictError extends Error {
    constructor(message = "The files changed on disk after you opened the editor.") {
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
    const secrets = new Set<string>();
    const add = (value: string) => {
        if (value.length >= 4) secrets.add(value);
        if (!/[\r\n]/.test(value)) return;
        // A multiline value may be echoed whole, with escaped newlines, or one
        // line at a time: redact every form.
        secrets.add(value.replace(/\r?\n/g, "\\n"));
        for (const part of value.split(/\r?\n/)) {
            if (part.trim().length >= 4) secrets.add(part.trim());
        }
    };
    const lines = envSource.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
        const trimmed = lines[i]!.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const entry = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
        const index = entry.indexOf("=");
        if (index === -1) continue;
        let raw = entry.slice(index + 1).trim();
        const quote = raw[0];
        if ((quote === '"' || quote === "'") && !closesQuote(raw, quote)) {
            // A quoted value may span lines. An unterminated quote is left as a
            // single-line value so the following entries are still collected.
            let end = i + 1;
            let joined = raw;
            for (; end < lines.length; end += 1) {
                joined += `\n${lines[end]}`;
                if (closesQuote(joined, quote)) break;
            }
            if (end < lines.length) {
                raw = joined;
                i = end;
            }
        }
        add(parseEnvValue(raw));
    }
    return [...secrets];
}

/** Whether a value opened by `quote` is closed, with the escapes `parseEnvValue` honors. */
function closesQuote(raw: string, quote: string): boolean {
    for (let i = 1; i < raw.length; i += 1) {
        const ch = raw[i]!;
        if (ch === "\\" && i + 1 < raw.length && (quote === '"' || raw[i + 1] === "'" || raw[i + 1] === "\\")) {
            i += 1;
            continue;
        }
        if (ch === quote) return true;
    }
    return false;
}

/**
 * Extract a .env value using the supported syntax: double quotes (with escapes),
 * single quotes (literal) and unquoted values where a whitespace-preceded `#`
 * starts an inline comment. Best effort — a value that cannot be classified is
 * returned as-is so it is still redacted rather than leaked.
 */
function parseEnvValue(raw: string): string {
    const value = raw.trim();
    if (value.startsWith('"')) {
        let out = "";
        for (let i = 1; i < value.length; i += 1) {
            const ch = value[i]!;
            if (ch === "\\" && i + 1 < value.length) {
                const next = value[i + 1]!;
                out += next === "n" ? "\n" : next === "t" ? "\t" : next === "r" ? "\r" : next;
                i += 1;
                continue;
            }
            if (ch === '"') break;
            out += ch;
        }
        return out;
    }
    if (value.startsWith("'")) {
        let out = "";
        for (let i = 1; i < value.length; i += 1) {
            const ch = value[i]!;
            if (ch === "\\" && i + 1 < value.length) {
                const next = value[i + 1]!;
                // Only `\'` and `\\` are escapes; any other backslash is literal.
                if (next === "'" || next === "\\") {
                    out += next;
                    i += 1;
                    continue;
                }
            }
            if (ch === "'") break;
            out += ch;
        }
        return out;
    }
    const comment = value.search(/(^|\s)#/);
    return (comment === -1 ? value : value.slice(0, comment)).trim();
}

export function redactSecrets(text: string, secrets: string[]): string {
    let output = text;
    // Longest first: a short value contained in a longer one would otherwise be
    // replaced first and leave the rest of the longer value readable.
    for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
        if (secret.length < 4) continue;
        output = output.split(secret).join("***");
    }
    return output;
}

function firstLines(text: string, maxLines = 6, maxChars = 1000): string {
    return text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, maxLines)
        .join("\n")
        .slice(0, maxChars)
        .trim();
}

export interface ValidationResult {
    ok: boolean;
    message: string | null;
}

/** Shared creation/edit diagnostics: redact before shortening, never show cut output. */
export function configValidationResult(result: CommandResult, secrets: string[]): ValidationResult {
    if (result.timedOut)
        return { ok: false, message: "docker compose config did not answer in time. Check that Docker is responsive, then try again." };
    // A secret crossing the runner's output cap may survive as a fragment.
    if (result.truncated)
        return {
            ok: false,
            message:
                "docker compose config output was too long to show safely. Check the draft with docker compose config --quiet using the CLI.",
        };
    if (result.code !== 0) {
        return {
            ok: false,
            message:
                firstLines(redactSecrets(result.stderr, secrets)) || "docker compose config rejected the file without giving a reason.",
        };
    }
    return { ok: true, message: null };
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
    liveEnvFile?: string | null,
): Promise<ValidationResult> {
    const composeTmp = join(directory, `.cp-draft-${randomSuffix()}.yaml`);
    let envTmp: string | null = null;
    try {
        await writeFile(composeTmp, composeSource, { mode: 0o600 });
        // Use the same environment context as a mutation: a draft env when the
        // .env is edited, otherwise the verified live .env explicitly, otherwise
        // nothing. This keeps validation and execution from diverging (e.g. via
        // COMPOSE_ENV_FILES when .env is left unchanged).
        let envFile: string | undefined;
        if (envSource !== undefined) {
            envTmp = join(directory, `.cp-draft-env-${randomSuffix()}`);
            await writeFile(envTmp, envSource, { mode: 0o600 });
            envFile = envTmp;
        } else if (liveEnvFile) {
            envFile = liveEnvFile;
        }

        const result = await provider.validateConfig({
            directory,
            composeFile: composeTmp,
            envFile,
            projectName,
        });
        return configValidationResult(result, secrets);
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
    writer?: (path: string, content: string, attributes: FileAttributes) => Promise<void>;
    /** Called after validation, before any backup or write; throwing aborts the save untouched. */
    beforeCommit?: () => void;
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
    // Keep the original Linux directory inode alive across validation. A
    // deleted inode may otherwise be recycled immediately for a replacement,
    // defeating a later dev/ino comparison even with identical file content.
    const pinned =
        process.platform === "linux" ? await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW) : null;
    try {
        const stackIdentity = pinned ? await pinned.stat() : await dirIdentity(directory);

        const currentCompose = await readFileSafe(composePath, maxBytes);
        if (!currentCompose) throw new StackError("Compose file not found.", 404);
        const currentEnv = await readFileSafe(envPath, maxBytes);
        const currentEnvExists = currentEnv !== null;
        const currentEnvHash = currentEnv ? currentEnv.hash : ABSENT_HASH;

        if (currentCompose.hash !== request.baseComposeHash)
            throw new StackConflictError("The Compose file changed on disk after you opened the editor.");
        if (currentEnvExists !== request.baseEnvExists || currentEnvHash !== request.baseEnvHash) {
            throw new StackConflictError("The .env file changed on disk after you opened the editor.");
        }

        const composeChanged = request.composeSource !== currentCompose.source;
        const envDesiredExists = request.baseEnvExists || request.envSource.length > 0;
        const envChanged =
            envDesiredExists !== currentEnvExists || (envDesiredExists && currentEnv !== null && request.envSource !== currentEnv.source);

        if (!composeChanged && !envChanged) {
            return {
                changed: false,
                composeHash: currentCompose.hash,
                envHash: currentEnvHash,
                envExists: currentEnvExists,
                backupPaths: [],
            };
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
            context?.kind === "resolved" ? (context.project ?? undefined) : undefined,
            currentEnvExists ? envPath : null,
        );
        if (!validation.ok)
            throw new StackValidationError(validation.message ?? "docker compose config rejected the file without giving a reason.");

        // Validation awaits a subprocess for seconds; an external writer may have
        // acted meanwhile. Re-locate (presence/identity) and re-read both files:
        // anything divergent is a conflict, never a silent overwrite. The lock
        // only serializes panel requests, not outside editors.
        const relocated = await locateComposeFile(root, name);
        if (relocated.path !== located.path) {
            throw new StackConflictError("The stack folder changed on disk while the files were being checked.");
        }
        // The path can stay identical while the directory object is swapped.
        // dev/ino names the object on Linux; a mismatch is a conflict.
        if (!sameDirIdentity(await dirIdentity(directory), stackIdentity)) {
            throw new StackConflictError("The stack folder was replaced on disk while the files were being checked.");
        }
        let freshCompose: SafeFile | null;
        let freshEnv: SafeFile | null;
        try {
            freshCompose = await readFileSafe(composePath, maxBytes);
            freshEnv = await readFileSafe(envPath, maxBytes);
        } catch {
            throw new StackConflictError("The files changed on disk while they were being checked.");
        }
        if (!freshCompose) throw new StackError("Compose file not found.", 404);
        if (freshCompose.hash !== currentCompose.hash) {
            throw new StackConflictError("The Compose file changed on disk while it was being checked.");
        }
        if (freshEnv !== null ? freshEnv.hash !== currentEnvHash : currentEnvExists) {
            throw new StackConflictError("The .env file changed on disk while it was being checked.");
        }

        options.beforeCommit?.();
        const backupDir = await ensureBackupDir(root, name);
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
                await writer(composePath, request.composeSource, freshCompose);
                composeWritten = true;
            }
            // A new .env is private and belongs to whoever owns the Compose file.
            if (envChanged)
                await writer(envPath, request.envSource, freshEnv ?? { mode: 0o600, uid: freshCompose.uid, gid: freshCompose.gid });
        } catch (error) {
            if (!composeWritten) throw error;
            try {
                await writer(composePath, freshCompose.source, freshCompose);
            } catch {
                throw new StackPartialError(
                    `Writing the files failed and the Compose file could not be put back. Restore it by hand from the backup: ${backupPaths.join(", ")}`,
                    backupPaths,
                );
            }
            throw new StackPartialError(
                `Writing the files failed. The Compose file was put back to its previous version (backup: ${backupPaths.join(", ")}).`,
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
    } finally {
        await pinned?.close();
    }
}
