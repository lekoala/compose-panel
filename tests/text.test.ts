import { describe, expect, test } from "bun:test";
import { containsControlCharacters } from "../src/text.ts";

describe("containsControlCharacters", () => {
    test("rejects C0 controls and DEL, and accepts printable text including C1", () => {
        for (const value of ["\0", "\t", "\n", "\x1f", "\x7f"]) expect(containsControlCharacters(value)).toBe(true);
        for (const value of ["", "plain", "é🙂", " ", "\x80", "\x9f"]) expect(containsControlCharacters(value)).toBe(false);
    });
});
