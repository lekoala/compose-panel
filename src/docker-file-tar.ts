import type { ActionFileResult } from "./action-runner.ts";

// One manifest plus bounded headers, padding and PAX metadata. Never extract.
export const DOCKER_FILE_TAR_OVERHEAD = 16 * 1024;
const BLOCK = 512;
const decoder = new TextDecoder("utf-8", { fatal: true });

function text(bytes: Uint8Array): string {
    const end = bytes.indexOf(0);
    return decoder.decode(end < 0 ? bytes : bytes.subarray(0, end));
}

function octal(bytes: Uint8Array): number {
    const value = text(bytes).trim();
    return /^[0-7]+$/.test(value) ? Number.parseInt(value, 8) : NaN;
}

/** Docker's uncompressed tar: exactly one regular named file, no links. */
export function readDockerFileTar(bytes: Uint8Array, filename: string, maxBytes: number): ActionFileResult {
    if (bytes.byteLength > maxBytes + DOCKER_FILE_TAR_OVERHEAD) return { kind: "too-large" };
    let content: string | undefined;
    let metadata = 0;
    try {
        for (let offset = 0; offset + BLOCK <= bytes.byteLength;) {
            const header = bytes.subarray(offset, offset + BLOCK);
            if (header.every((byte) => byte === 0)) {
                const tail = bytes.subarray(offset);
                return tail.byteLength >= BLOCK * 2 &&
                    tail.byteLength % BLOCK === 0 &&
                    tail.every((byte) => byte === 0) &&
                    content !== undefined
                    ? { kind: "ok", content }
                    : { kind: "error" };
            }
            const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
            if (checksum !== octal(header.subarray(148, 156))) return { kind: "error" };
            const size = octal(header.subarray(124, 136));
            if (!Number.isSafeInteger(size) || size < 0) return { kind: "error" };
            const type = header[156];
            const start = offset + BLOCK;
            const end = start + size;
            offset = start + Math.ceil(size / BLOCK) * BLOCK;
            if (type === 120) {
                // Per-file PAX metadata from Go's archive/tar.
                metadata += size + BLOCK;
                if (content !== undefined || metadata > DOCKER_FILE_TAR_OVERHEAD - 2048 || end > bytes.byteLength) return { kind: "error" };
                const pax = bytes.subarray(start, end);
                for (let cursor = 0; cursor < pax.length;) {
                    const space = pax.indexOf(32, cursor);
                    if (space < 0) return { kind: "error" };
                    const countText = decoder.decode(pax.subarray(cursor, space));
                    if (!/^[1-9][0-9]*$/.test(countText)) return { kind: "error" };
                    const count = Number(countText);
                    if (
                        !Number.isSafeInteger(count) ||
                        count <= space - cursor + 2 ||
                        cursor + count > pax.length ||
                        pax[cursor + count - 1] !== 10
                    )
                        return { kind: "error" };
                    const record = decoder.decode(pax.subarray(space + 1, cursor + count - 1));
                    const equals = record.indexOf("=");
                    const key = record.slice(0, equals);
                    // No path, size or link overrides, sparse files or global
                    // headers. Only metadata which cannot change file semantics.
                    if (equals < 1 || (!["mtime", "atime", "ctime"].includes(key) && !key.startsWith("SCHILY.xattr.")))
                        return { kind: "error" };
                    cursor += count;
                }
                continue;
            }
            if (type !== 0 && type !== 48) return { kind: "not-file" };
            if (
                content !== undefined ||
                text(header.subarray(0, 100)) !== filename ||
                text(header.subarray(157, 257)) !== "" ||
                text(header.subarray(345, 500)) !== ""
            )
                return { kind: "error" };
            if (size > maxBytes) return { kind: "too-large" };
            if (offset > bytes.byteLength) return { kind: "error" };
            content = decoder.decode(bytes.subarray(start, end));
        }
    } catch {
        /* Malformed metadata or invalid UTF-8 is unavailable. */
    }
    return { kind: "error" };
}
