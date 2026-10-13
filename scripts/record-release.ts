import { parseReleaseRegistry, recordRelease } from "../src/release-registry.ts";

const [path, version, digest, revision] = process.argv.slice(2);
if (!path || !version || !digest || !revision || process.argv.length !== 6) {
    throw new Error("Usage: record-release.ts <registry.json> <version> <digest> <revision>");
}
const file = Bun.file(path);
if (file.size > 512 * 1024) throw new Error("Release registry is too large.");
const registry = parseReleaseRegistry(await file.json());
if (!registry) throw new Error("Invalid release registry.");
const next = recordRelease(registry, { version, digest, revision, recordedAt: new Date().toISOString() });
if (next !== registry) {
    const text = `${JSON.stringify(next, null, 2)}\n`;
    if (Buffer.byteLength(text) > 512 * 1024) throw new Error("Release registry is full; review the retention policy before publishing.");
    await Bun.write(path, text);
}
