import { expect, test } from "bun:test";
import { readDockerFileTar } from "../src/docker-file-tar.ts";
import { fileTar, tarEntry } from "./helpers/tar.ts";

const read = (bytes: Uint8Array) => readDockerFileTar(bytes, "package.json", 1024);

test("tar reads require an intact single named file and end markers", () => {
    expect(read(fileTar("package.json", "{\"é\":\"🙂\"}"))).toEqual({ kind: "ok", content: "{\"é\":\"🙂\"}" });
    const invalid = fileTar("package.json", "{}");
    invalid[20] = 1;
    for (const bytes of [invalid, fileTar("../package.json", "{}"), fileTar("other.json", "{}"),
        fileTar("package.json", "{}").subarray(0, 1024),
        Buffer.concat([tarEntry("package.json", "{}"), fileTar("package.json", "{}")])]) {
        expect(read(bytes).kind).toBe("error");
    }
});

function pax(key: string, value: string): string {
    const suffix = ` ${key}=${value}\n`;
    let size = suffix.length + 1;
    while (String(size).length + suffix.length !== size) size = String(size).length + suffix.length;
    return `${size}${suffix}`;
}

test("PAX may carry timestamps but cannot override paths, sizes or links", () => {
    const archive = (record: string) => Buffer.concat([tarEntry("PaxHeader", record, "x"), fileTar("package.json", "{}")]);
    expect(read(archive(pax("mtime", "1700000000.123"))).kind).toBe("ok");
    for (const key of ["path", "linkpath", "size", "GNU.sparse.size"]) {
        expect(read(archive(pax(key, "evil"))).kind).toBe("error");
    }
    expect(read(archive("999 mtime=x\n")).kind).toBe("error");
});
