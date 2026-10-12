import { expect, test } from "bun:test";
import { documentHtml, escapeHtml, healthSummaryBadge, htmlResponse, logsPanel, renderSidebar, servicesSection, usageBar } from "../src/html.ts";
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
    expect(html.match(/<th[\s>]/g)).toHaveLength(3);
    expect(html).not.toContain("state-done");
});

test("shows the health column, with a not-configured cell, once one service declares one", () => {
    const html = servicesSection([service("app", "healthy"), service("cache", null)], "running");
    expect(html.match(/<th[\s>]/g)).toHaveLength(4);
    expect(html).toContain("state-done");
    expect(html).toContain('class="muted"');
});

test("keeps health apart from run state and flags unhealthy services", () => {
    const services = [service("app", "unhealthy"), service("cache", "starting")];
    const html = servicesSection(services, "running");
    expect(html).toContain("state-failed");
    expect(html).toContain("state-stopped");
    const badge = healthSummaryBadge(services);
    expect(badge).toMatch(/<span class="state state-failed">[^<]*1[^<]*<\/span>/);
    expect(healthSummaryBadge([service("app", "healthy")])).toBe("");
});

test("sidebar lists the sections and the stacks, marking the current ones", () => {
    const html = renderSidebar({ stacks: ["alpha", "beta"], section: "stacks", stack: "beta" });
    expect(html).toContain('<a href="/" aria-current="page">');
    expect(html).toContain('<a href="/containers">');
    expect(html).toContain('<a href="/stacks/alpha">');
    expect(html).toContain('<a href="/stacks/beta" aria-current="page">');
});

test("sidebar escapes stack names and never emits other markup", () => {
    const html = renderSidebar({ stacks: ["<script>alert(1)</script>"], section: "stacks" });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
});

test("the document renders the sidebar only when navigation is supplied", () => {
    const withNav = documentHtml("Test", "<h1>OK</h1>", { nav: { stacks: ["alpha"], section: "stacks" } });
    expect(withNav).toContain('<nav class="nav-sections"');
    expect(withNav).toContain('id="nav-list"');

    const withoutNav = documentHtml("Test", "<h1>OK</h1>");
    expect(withoutNav).not.toContain("nav-sections");
});

test("logs panel exposes the snapshot link and the follow stream", () => {
    const html = logsPanel("demo", 200, "Europe/Brussels");
    expect(html).toContain('data-logs-snapshot="/stacks/demo/logs"');
    expect(html).toContain('data-logs-stream="/stacks/demo/logs/events"');
    expect(html).toContain('id="logs-follow"');
    expect(html).toContain('id="logs-refresh"');
});

test("logs panel offers server-known services and line counts without trusting them", () => {
    const html = logsPanel("demo", 200, "", ["web", "db", "web", "<b>evil</b>"]);
    expect(html).toContain('id="logs-service"');
    expect(html).toContain('name="service"');
    expect(html).toContain('value=""');
    expect(html).toContain('value="web"');
    expect(html).toContain('value="db"');
    expect(html).toContain("&lt;b&gt;evil&lt;/b&gt;");
    expect(html).not.toContain("<b>evil</b>");
    expect(html).toContain('value="500"');
    expect(html).toContain('method="get"');
});

test("usage bars are clamped, decorative, and absent when the value is unknown", () => {
    expect(usageBar(null)).toBe("");
    expect(usageBar(Number.NaN)).toBe("");
    const quarter = usageBar(0.25);
    expect(quarter).toContain('<rect class="bar-fill" width="25"');
    expect(quarter).toContain('aria-hidden="true"');
    // No inline style: the CSP forbids it, the width is an SVG attribute.
    expect(quarter).not.toContain("style=");
    expect(usageBar(1.7)).toContain('<rect class="bar-fill" width="100"');
    expect(usageBar(-1)).toContain('<rect class="bar-fill" width="0"');
    expect(usageBar(0.95)).toContain('class="bar bar-high"');
    expect(usageBar(0.5)).not.toContain("bar-high");
});
