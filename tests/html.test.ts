import { expect, test } from "bun:test";
import { documentHtml, escapeHtml, htmlResponse } from "../src/html.ts";

test("escapes file content in HTML", () => {
    const value = `<script>alert("x")</script> & 'quotes'`;
    expect(escapeHtml(value)).toBe("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;quotes&#39;");
    expect(documentHtml(value, `<pre>${escapeHtml(value)}</pre>`)).not.toContain("<script>");
});

test("disables caching and active scripts", () => {
    const response = htmlResponse(documentHtml("Test", "<h1>OK</h1>"));
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
});

test("exposes the display time zone on the document, escaped", () => {
    expect(documentHtml("Test", "<h1>OK</h1>")).not.toContain("data-timezone");
    const html = documentHtml("Test", "<h1>OK</h1>", { timezone: "Europe/Brussels" });
    expect(html).toContain('<html lang="en" data-timezone="Europe/Brussels">');
});
