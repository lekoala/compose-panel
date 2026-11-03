import { describe, expect, test } from "bun:test";
import { compactComposeProgress } from "../src/compose-progress.ts";

function harness(intervalMs = 5000) {
    const chunks: string[] = [];
    let clock = 0;
    const progress = compactComposeProgress((chunk) => chunks.push(chunk), { intervalMs, now: () => clock });
    return {
        progress,
        advance: (ms: number) => {
            clock += ms;
        },
        output: () => chunks.join(""),
    };
}

describe("compactComposeProgress", () => {
    test("throttles repeated download and extract updates per layer", () => {
        const { progress, advance, output } = harness();
        progress.write(" 7801f5cb2c57 Downloading 61.87MB\n afa7f7d582de Downloading 1.049MB\n");
        progress.write(" 7801f5cb2c57 Downloading 62.91MB\n afa7f7d582de Downloading 1.049MB\n");
        advance(5000);
        progress.write(" 7801f5cb2c57 Downloading 65.01MB\n");
        progress.write(" 7801f5cb2c57 Downloading 66.06MB\n");
        progress.flush();
        expect(output()).toBe(" 7801f5cb2c57 Downloading 61.87MB\n afa7f7d582de Downloading 1.049MB\n 7801f5cb2c57 Downloading 65.01MB\n");
    });

    test("a layer status change and every other line pass unchanged", () => {
        const { progress, output } = harness();
        const lines = [
            " onedev Pulling ",
            " 7801f5cb2c57 Pulling fs layer ",
            " 7801f5cb2c57 Downloading 1.049MB",
            " 7801f5cb2c57 Download complete ",
            " 7801f5cb2c57 Extracting 21B",
            " 7801f5cb2c57 Pull complete ",
            "Error response from daemon: manifest unknown",
            "",
        ];
        for (const line of lines) progress.write(`${line}\n`);
        progress.write(" 7801f5cb2c57 Extracting 21B\n");
        progress.flush();
        expect(output()).toBe(`${lines.join("\n")}\n`);
    });

    test("lines split across chunks are classified whole", () => {
        const { progress, output } = harness();
        progress.write(" 7801f5cb2c57 Downlo");
        progress.write("ading 1MB\n 7801f5cb2c57 Down");
        progress.write("loading 2MB\n onedev Pul");
        expect(output()).toBe(" 7801f5cb2c57 Downloading 1MB\n");
        progress.flush();
        expect(output()).toBe(" 7801f5cb2c57 Downloading 1MB\n onedev Pul");
    });

    test("a very long partial line is passed through instead of buffered", () => {
        const { progress, output } = harness();
        const long = "x".repeat(70 * 1024);
        progress.write(long);
        expect(output()).toBe(long);
        progress.flush();
        expect(output()).toBe(long);
    });
});
