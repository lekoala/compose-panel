import { expect, test } from "bun:test";
import { latestReleaseRecord, parseReleaseRegistry, recordRelease, type ReleaseRecord } from "../src/release-registry.ts";

const first: ReleaseRecord = {
    version: "0.3.1",
    digest: `sha256:${"a".repeat(64)}`,
    revision: "b".repeat(40),
    recordedAt: "2026-10-13T10:00:00Z",
};

test("retries preserve the original registration and replacements preserve history", () => {
    const initial = recordRelease({ schema: 1, releases: [] }, first);
    expect(recordRelease(initial, { ...first, recordedAt: "2026-10-14T10:00:00Z" })).toBe(initial);
    const replacement = { ...first, digest: `sha256:${"c".repeat(64)}`, recordedAt: "2026-10-14T10:00:00Z" };
    const next = recordRelease(initial, replacement);
    expect(next.releases).toEqual([first, replacement]);
    expect(latestReleaseRecord(next, first.version)).toEqual(replacement);
    expect(initial.releases).toEqual([first]);
});

test("malformed and out-of-order registry records fail closed", () => {
    for (const override of [{ version: "../evil" }, { digest: "latest" }, { revision: "x" }, { recordedAt: "yesterday" }]) {
        expect(parseReleaseRegistry({ schema: 1, releases: [{ ...first, ...override }] })).toBeNull();
    }
    expect(parseReleaseRegistry({ schema: 2, releases: [] })).toBeNull();
    expect(parseReleaseRegistry({ schema: 1, releases: [first, { ...first, recordedAt: "2026-10-12T10:00:00Z" }] })).toBeNull();
    expect(() => recordRelease({ schema: 1, releases: [first] }, { ...first, revision: "d".repeat(40) })).toThrow();
});
