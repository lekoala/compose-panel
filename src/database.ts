import { asRecord, readComposeExtension, type ParseResult } from "./compose-extension.ts";

/**
 * External database explorer link (ADR 0027): a stack declares, through the
 * Compose `x-compose-panel.database` extension, a label and scalar query
 * parameters. The panel builds a deep link to a separately deployed explorer
 * (LibreDB Studio, Adminer, pgAdmin…). It stays agnostic of the software: it
 * never contacts the explorer, never reads a credential, and never reaches a
 * database itself. The only product-specific knowledge lives in the deployment
 * guide, as an example.
 *
 * This module is pure (parsing, validation, URL building): no Docker, no
 * filesystem, no network.
 */

/** Upper bounds for the stack-side declaration, so the link stays small. */
const MAX_QUERY_PARAMS = 16;
const MAX_KEY = 64;
const MAX_VALUE = 256;
const MAX_LABEL = 64;

export interface DatabaseExplorer {
    /** Display name of the explorer software, or null when not declared. */
    label: string | null;
    /** Scalar query parameters. Never promised in any particular order. */
    query: Record<string, string>;
}

/** Text of 1..max characters without control characters. */
function isUsableText(value: string, max: number): boolean {
    return value.length >= 1 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
}

/**
 * A query value as written in the YAML. Only strings and booleans are accepted:
 * a bare numeric scalar is parsed by YAML into a number whose textual form may
 * differ from what was written (`0123`, `0x1F`, `1e3`, huge integers), so the
 * panel refuses it and asks for quotes instead of silently changing the value.
 */
function asScalar(value: unknown): string | null {
    if (typeof value === "string") return value;
    if (typeof value === "boolean") return value ? "true" : "false";
    return null;
}

/**
 * Read `x-compose-panel.database` from a raw Compose file. Compose ignores
 * `x-*` fields, so the extension never reaches the deployed project. No
 * `database` block is not an error: the stack simply offers no explorer link.
 */
export function parseDatabaseExplorer(composeSource: string): ParseResult<DatabaseExplorer | null> {
    const extension = readComposeExtension(composeSource);
    if (!extension.ok) return extension;
    const raw = extension.value ? extension.value["database"] : undefined;
    if (raw === undefined || raw === null) return { ok: true, value: null };
    const database = asRecord(raw);
    if (!database) return { ok: false, error: "x-compose-panel.database must be a mapping." };

    let label: string | null = null;
    const rawLabel = database["label"];
    if (rawLabel !== undefined && rawLabel !== null) {
        if (typeof rawLabel !== "string" || !isUsableText(rawLabel, MAX_LABEL)) {
            return { ok: false, error: `x-compose-panel.database.label must be text of 1-${MAX_LABEL} characters.` };
        }
        label = rawLabel;
    }

    const query: Record<string, string> = Object.create(null);
    const rawQuery = database["query"];
    if (rawQuery !== undefined && rawQuery !== null) {
        const queryRecord = asRecord(rawQuery);
        if (!queryRecord) return { ok: false, error: "x-compose-panel.database.query must be a mapping of scalar values." };
        const entries = Object.entries(queryRecord);
        if (entries.length > MAX_QUERY_PARAMS) {
            return { ok: false, error: `x-compose-panel.database.query lists more than ${MAX_QUERY_PARAMS} parameters.` };
        }
        for (const [key, value] of entries) {
            if (!isUsableText(key, MAX_KEY)) {
                return { ok: false, error: `A database query parameter name must be text of 1-${MAX_KEY} characters.` };
            }
            const scalar = asScalar(value);
            if (scalar === null) {
                return {
                    ok: false,
                    error: `Database query parameter "${key}" must be a quoted string or a boolean (quote numeric values).`,
                };
            }
            if (!isUsableText(scalar, MAX_VALUE)) {
                return { ok: false, error: `Database query parameter "${key}" must be text of 1-${MAX_VALUE} characters.` };
            }
            query[key] = scalar;
        }
    }

    return { ok: true, value: { label, query } };
}

/**
 * Validate `COMPOSE_PANEL_DATABASE_EXPLORER_URL`. Returns the normalized origin,
 * or null when the setting is empty. Outside development mode the URL must use
 * https; credentials, a path, a query or a fragment are always refused. V1
 * assumes an explorer served at the root of its domain (no `BASE_PATH`).
 */
export function normalizeDatabaseExplorerUrl(raw: string, devMode: boolean): string | null {
    const text = raw.trim();
    if (text === "") return null;
    let url: URL;
    try {
        url = new URL(text);
    } catch {
        throw new Error(`COMPOSE_PANEL_DATABASE_EXPLORER_URL must be an absolute http(s) URL, got "${text}".`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error(`COMPOSE_PANEL_DATABASE_EXPLORER_URL must use http or https, got "${text}".`);
    }
    if (url.username !== "" || url.password !== "") {
        throw new Error("COMPOSE_PANEL_DATABASE_EXPLORER_URL must not contain credentials (user:pass@).");
    }
    if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
        throw new Error(
            "COMPOSE_PANEL_DATABASE_EXPLORER_URL must not contain a path, query or fragment: V1 targets an explorer served at the root of its domain.",
        );
    }
    if (!devMode && url.protocol === "http:") {
        throw new Error(
            "COMPOSE_PANEL_DATABASE_EXPLORER_URL must use https: plain HTTP would send the explorer session in clear. (COMPOSE_PANEL_DEV=true allows http for local testing only.)",
        );
    }
    return url.origin;
}

/**
 * Generous upper bound for a rendered explorer link: 16 parameters with a
 * 256-character value each, worst-case percent-encoded, plus the base origin.
 * It keeps the link bounded without rejecting any URL this module can build.
 */
export const MAX_EXPLORER_URL_LENGTH = 16 * 1024;

/**
 * The single defensive check before rendering, since `buildExplorerUrl` runs on
 * a base URL already validated at startup. Accepts http(s) without credentials,
 * up to `MAX_EXPLORER_URL_LENGTH` (it does not cap at 512 characters like
 * `metadataUrl`, so a link built from bounded parameters is never hidden).
 */
export function isExplorerHref(value: string): boolean {
    if (value.length === 0 || value.length > MAX_EXPLORER_URL_LENGTH) return false;
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return false;
    }
    return (url.protocol === "http:" || url.protocol === "https:") && url.username === "" && url.password === "";
}

/**
 * Build the declarative deep link: `<base>/?<query>`. `baseUrl` is the origin
 * validated by `normalizeDatabaseExplorerUrl` at startup and `query` comes from
 * `parseDatabaseExplorer`, so no re-validation is needed here; the render-time
 * defense lives in `isExplorerHref`.
 */
export function buildExplorerUrl(baseUrl: string, query: Record<string, string>): string {
    const url = new URL(baseUrl);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return url.href;
}
