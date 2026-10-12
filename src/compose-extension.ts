/**
 * Shared helpers for reading Compose extension fields (`x-compose-panel.*`).
 * Compose ignores `x-*` fields at deploy time, so they never reach the deployed
 * project. The parser is defensive and callers read only known keys, so a cyclic
 * YAML alias elsewhere in the document cannot be traversed.
 */

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

/**
 * Parse a raw Compose file and return its `x-compose-panel` mapping, or null
 * when the field is absent or not a mapping. Invalid YAML is an error.
 */
export function readComposeExtension(composeSource: string): ParseResult<Record<string, unknown> | null> {
    let document: unknown;
    try {
        document = Bun.YAML.parse(composeSource);
    } catch {
        return { ok: false, error: "The Compose file is not valid YAML." };
    }
    const root = asRecord(document);
    const extension = root ? asRecord(root["x-compose-panel"]) : null;
    return { ok: true, value: extension };
}
