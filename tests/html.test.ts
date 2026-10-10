import { expect, test } from "bun:test";
import { documentHtml, escapeHtml, healthSummaryBadge, htmlResponse, logsPanel, servicesSection } from "../src/html.ts";
import type { ComposeService } from "../src/compose-state.ts";

function service(name: string, health: string | null): ComposeService {
    return { name, state: "running", health, exitCode: 0, container: `demo-${name}-1`, image: "nginx:1" };
}

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

test("hides the health column when no service declares a health check", () => {
    const html = servicesSection([service("app", null), service("cache", null)], "running");
    expect(html).not.toContain("Health check");
    expect(html).not.toContain("Not configured");
});

test("shows the health column, with Not configured, once one service declares one", () => {
    const html = servicesSection([service("app", "healthy"), service("cache", null)], "running");
    expect(html).toContain("Health check");
    expect(html).toContain(">Healthy<");
    expect(html).toContain("Not configured");
});

test("keeps health apart from run state and flags unhealthy services", () => {
    const services = [service("app", "unhealthy"), service("cache", "starting")];
    const html = servicesSection(services, "running");
    expect(html).toContain("Unhealthy");
    expect(html).toContain("Starting");
    expect(healthSummaryBadge(services)).toContain("1 unhealthy");
    expect(healthSummaryBadge([service("app", "healthy")])).toBe("");
});

test("logs panel exposes the snapshot link and the follow stream", () => {
    const html = logsPanel("demo", 200, "Europe/Brussels");
    expect(html).toContain('data-logs-snapshot="/stacks/demo/logs"');
    expect(html).toContain('data-logs-stream="/stacks/demo/logs/events"');
    expect(html).toContain("Latest 200 lines");
    expect(html).toContain("Follow live");
});
