import { expect, test } from "bun:test";
import { documentHtml, escapeHtml, healthSummaryBadge, htmlResponse, logsPanel, operationPanel, renderSidebar, servicesSection, usageBar, databaseSection, domainsSection } from "../src/html.ts";
import { buildExplorerUrl } from "../src/database.ts";
import type { ComposeService } from "../src/compose-state.ts";
import type { OperationView } from "../src/operations.ts";

function operation(overrides: Partial<OperationView>): OperationView {
    return {
        id: "op1", stack: "demo", action: "up", label: "up", status: "succeeded",
        startedAt: 0, endedAt: 1, exitCode: 0, output: "", truncated: false, timedOut: false,
        ...overrides,
    };
}

test("operationPanel uses its own label for a script named like an Object property", () => {
    // `constructor`/`toString` resolve to inherited `OPERATION_LABELS` members;
    // escaping that function used to throw and break every page showing it.
    const html = operationPanel(operation({ action: "constructor", label: "Self test", source: "backend", script: "constructor" }));
    expect(html).toContain("Self test");
    expect(html).not.toContain("function");
});

test("operationPanel keeps the friendly Compose action label", () => {
    expect(operationPanel(operation({ action: "pull-up", label: "pull-up" }))).toContain("Pull + up");
});

test("operationPanel shows an application action's own label, not the Compose name", () => {
    // A script named `start` must not collide with the Compose "Start" action.
    const html = operationPanel(operation({ action: "start", label: "Start application worker", source: "backend", script: "start" }));
    expect(html).toContain("Start application worker");
    expect(html).not.toContain("Last action: Start<");
});

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

test("database section is absent without a valid explorer link", () => {
    expect(databaseSection(null)).toBe("");
});

test("database section reports an invalid declaration as a warning without a link", () => {
    const html = databaseSection(null, "x-compose-panel.database.query must be a mapping of scalar values.");
    expect(html).toContain('class="note note-warn"');
    expect(html).not.toContain("<a ");
});

test("database section escapes the warning message", () => {
    const html = databaseSection(null, '<script>alert("x")</script>');
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
});

test("database section renders a long but valid explorer link", () => {
    // Two 256-character values exceed metadataUrl's 512-char cap while staying
    // within the ADR 0027 bounds: the link must still be rendered.
    const query = { a: "x".repeat(256), b: "y".repeat(256) };
    const url = buildExplorerUrl("https://db.example.com", query);
    expect(url).not.toBeNull();
    expect(url!.length).toBeGreaterThan(512);
    const html = databaseSection({ url: url!, label: null, query });
    expect(html).toContain('<a class="btn" href=');
    expect(html).toContain('rel="noopener noreferrer"');
});

test("database section links to the explorer in a new tab without opener access", () => {
    const html = databaseSection({
        url: "https://db.example.com/?connection=seed%3Ashop-staging",
        label: "LibreDB",
        query: { connection: "seed:shop-staging" },
    });
    expect(html).toContain('class="card database"');
    expect(html).toContain('<a class="btn" href="https://db.example.com/?connection=seed%3Ashop-staging"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("LibreDB");
    expect(html).toContain("connection=seed:shop-staging");
});

test("database section escapes the label and query values and refuses a non-http link", () => {
    const escaped = databaseSection({ url: "https://db.example.com/", label: '<script>"', query: { db: "<b>x</b>" } });
    expect(escaped).not.toContain("<script>");
    expect(escaped).toContain("&lt;script&gt;");
    expect(escaped).not.toContain("<b>x</b>");
    expect(escaped).toContain("&lt;b&gt;x&lt;/b&gt;");
    const bad = databaseSection({ url: "javascript:alert(1)", label: null, query: { db: "shop" } });
    expect(bad).not.toContain("javascript:");
    expect(bad).not.toContain("<a ");
});

test("domains section renders a preview form with service suggestions", () => {
    const html = domainsSection({
        stackName: "web",
        csrf: "csrf-token",
        services: ["web", "worker"],
        owner: null,
        attached: [],
        statusError: null,
        socketReady: false,
        preview: { domain: "", service: "", port: "", file: null, error: null, hasInput: false },
        confirmDetach: null,
    });
    expect(html).toContain('class="card domains"');
    expect(html).toContain('method="get"');
    expect(html).toContain('name="caddyDomain"');
    expect(html).toContain('<option value="web">');
});

test("domains section escapes the generated file instead of interpreting it", () => {
    const file = "# compose-panel:managed v1\n# compose-panel:stack web\n# compose-panel:service <b>web</b>\n\napp.example.com {\n\treverse_proxy 127.0.0.1:8080\n}\n";
    const html = domainsSection({
        stackName: "web",
        csrf: "csrf-token",
        services: ["web"],
        owner: null,
        attached: [],
        statusError: null,
        socketReady: false,
        preview: { domain: "app.example.com", service: "web", port: "8080", file, error: null, hasInput: true },
        confirmDetach: null,
    });
    expect(html).toContain("<pre");
    expect(html).not.toContain("<b>web</b>");
    expect(html).toContain("&lt;b&gt;web&lt;/b&gt;");
});

test("domains section reports invalid input as a warning and stays read-only for external owners", () => {
    const invalid = domainsSection({
        stackName: "web",
        csrf: "csrf-token",
        services: ["web"],
        owner: null,
        attached: [],
        statusError: null,
        socketReady: false,
        preview: { domain: "", service: "", port: "", file: null, error: "This domain is not valid.", hasInput: true },
        confirmDetach: null,
    });
    expect(invalid).toContain('class="note note-warn"');
    expect(invalid).not.toContain("<pre");
    const external = domainsSection({
        stackName: "web",
        csrf: "csrf-token",
        services: ["web"],
        owner: "external-deployer",
        attached: [],
        statusError: null,
        socketReady: true,
        preview: { domain: "", service: "", port: "", file: null, error: null, hasInput: false },
        confirmDetach: null,
    });
    expect(external).not.toContain("<form");
    expect(external).not.toContain('name="caddyDomain"');
});

test("domains section lists attached domains with an application link and a detach form", () => {
    const html = domainsSection({
        stackName: "web",
        csrf: "csrf-token",
        services: ["web"],
        owner: null,
        attached: [{ domain: "app.example.com", service: "web", port: 8080 }],
        statusError: null,
        socketReady: true,
        preview: { domain: "", service: "", port: "", file: null, error: null, hasInput: false },
        confirmDetach: null,
    });
    expect(html).toContain('href="https://app.example.com"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('action="/stacks/web/domains/detach"');
    expect(html).toContain('action="/stacks/web/domains/attach"');
    expect(html).not.toContain("Confirm detach");
    const confirming = domainsSection({
        stackName: "web",
        csrf: "csrf-token",
        services: ["web"],
        owner: null,
        attached: [{ domain: "app.example.com", service: "web", port: 8080 }],
        statusError: null,
        socketReady: true,
        preview: { domain: "", service: "", port: "", file: null, error: null, hasInput: false },
        confirmDetach: "app.example.com",
    });
    expect(confirming).toContain("Confirm detach");
    expect(confirming).toContain('name="confirm" value="1"');
});

test("domains section escapes attached values and reports an unreadable status", () => {
    const html = domainsSection({
        stackName: "web",
        csrf: "csrf-token",
        services: ["web"],
        owner: null,
        attached: [{ domain: "app.example.com", service: "<b>web</b>", port: 8080 }],
        statusError: "The Caddy helper did not answer.",
        socketReady: true,
        preview: { domain: "", service: "", port: "", file: null, error: null, hasInput: false },
        confirmDetach: null,
    });
    expect(html).not.toContain("<b>web</b>");
    expect(html).toContain("&lt;b&gt;web&lt;/b&gt;");
    expect(html).toContain('class="note note-warn"');
});
