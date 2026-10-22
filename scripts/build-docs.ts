#!/usr/bin/env bun
/**
 * Static documentation site builder for GitHub Pages.
 *
 * Renders the Markdown in docs/ (plus the root README and CHANGELOG) with
 * Bun's built-in Markdown renderer and writes a self-contained site to
 * dist/docs: one HTML page per document, a shared sidebar, a copy of the
 * design tokens and the brand assets. No Ruby, no Jekyll, no dependency
 * beyond Bun itself.
 *
 * Cross-document links (`deployment.md#behind-caddy-https`) are rewritten to
 * the built pages; links to files that are not part of the site (LICENSE,
 * AGENTS.md, .env.example) point at the GitHub repository.
 *
 * Usage:
 *   bun scripts/build-docs.ts           # build into dist/docs
 *   bun scripts/build-docs.ts --serve   # build, then serve on :8090
 */

import { mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const DOCS_DIR = join(ROOT, "docs");
const OUT_DIR = join(ROOT, "dist", "docs");
const CSS_SRC = join(import.meta.dir, "docs", "site.css");
const REPO = "https://github.com/lekoala/compose-panel";
const PORT = 8090;

type Group = "guide" | "adr";

interface Page {
    src: string;
    out: string;
    label: string;
    title: string;
    group: Group;
}

const GUIDES: ReadonlyArray<{ src: string; label: string }> = [
    { src: "README.md", label: "Overview" },
    { src: "docs/product.md", label: "Product" },
    { src: "docs/architecture.md", label: "Architecture" },
    { src: "docs/security.md", label: "Security" },
    { src: "docs/installation.md", label: "Ubuntu installation" },
    { src: "docs/deployment.md", label: "Deployment" },
    { src: "docs/operations.md", label: "Operations" },
    { src: "docs/integrations/libredb.md", label: "LibreDB explorer" },
    { src: "docs/integrations/runtime-settings.md", label: "Runtime settings" },
    { src: "docs/migrating-from-dockge.md", label: "Migrating from Dockge" },
    { src: "docs/troubleshooting.md", label: "Troubleshooting" },
    { src: "docs/ci.md", label: "CI" },
    { src: "docs/roadmap.md", label: "Roadmap" },
    { src: "CHANGELOG.md", label: "Changelog" },
];

function outFor(src: string): string {
    if (src === "README.md") return "index.html";
    if (src === "CHANGELOG.md") return "changelog.html";
    const adr = /^docs\/adr\/(.+)\.md$/.exec(src);
    if (adr?.[1]) return `adr/${adr[1]}.html`;
    const doc = /^docs\/(.+)\.md$/.exec(src);
    if (doc?.[1]) return `${doc[1]}.html`;
    return `${posix.basename(src, ".md")}.html`;
}

function firstHeading(md: string, fallback: string): string {
    const match = /^#\s+(.+?)\s*$/m.exec(md);
    return match?.[1] ? plain(match[1]) : fallback;
}

function plain(md: string): string {
    return md.replace(/[`*_]/g, "").trim();
}

function escapeHtml(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** GitHub-compatible heading slugger, with `-1`, `-2` suffixes on repeats. */
function makeSlugger(): (text: string) => string {
    const seen = new Map<string, number>();
    return (text: string): string => {
        const id = text
            .toLowerCase()
            .trim()
            .replace(/[^\p{L}\p{N} -]/gu, "")
            .replace(/ /g, "-");
        const count = seen.get(id) ?? 0;
        seen.set(id, count + 1);
        return count === 0 ? id : `${id}-${count}`;
    };
}

function resolveRepo(fromSrc: string, href: string): string {
    return posix.normalize(posix.join(posix.dirname(fromSrc), href));
}

function relLink(fromOut: string, toOut: string): string {
    const rel = posix.relative(posix.dirname(fromOut), toOut);
    return rel === "" ? posix.basename(toOut) : rel;
}

function mapTarget(repoPath: string, isImage: boolean, isDir: boolean, pageOut: Map<string, string>): { site?: string; url?: string } {
    const path = repoPath.replace(/^\.\//, "");
    const page = pageOut.get(path);
    if (page) return { site: page };
    if (path.startsWith("docs/assets/")) return { site: `assets/${path.slice("docs/assets/".length)}` };
    if (isImage) return { url: `${REPO}/raw/HEAD/${path}` };
    if (isDir) return { url: `${REPO}/tree/HEAD/${path}` };
    return { url: `${REPO}/blob/HEAD/${path}` };
}

function rewriteUrl(url: string, fromSrc: string, fromOut: string, isImage: boolean, pageOut: Map<string, string>): string {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\/)/i.test(url)) return url;
    const hash = url.indexOf("#");
    const rawPath = hash >= 0 ? url.slice(0, hash) : url;
    const anchor = hash >= 0 ? url.slice(hash) : "";
    if (rawPath === "") return url;
    const target = resolveRepo(fromSrc, rawPath);
    const mapped = mapTarget(target, isImage, rawPath.endsWith("/"), pageOut);
    const dest = mapped.site ?? mapped.url ?? url;
    return mapped.site ? relLink(fromOut, dest) + anchor : dest + anchor;
}

function rewriteHtml(html: string, fromSrc: string, fromOut: string, pageOut: Map<string, string>): string {
    const slug = makeSlugger();
    const withIds = html.replace(/<h([1-6])>([\s\S]*?)<\/h\1>/g, (_match, level: string, inner: string) => {
        const id = slug(inner.replace(/<[^>]+>/g, ""));
        return `<h${level} id="${id}">${inner}</h${level}>`;
    });
    return withIds.replace(/\s(href|srcset|src)="([^"]*)"/g, (_match, attr: string, value: string) => {
        if (attr === "srcset") {
            const next = value
                .split(",")
                .map((part) => {
                    const trimmed = part.trim();
                    const space = trimmed.indexOf(" ");
                    const url = space >= 0 ? trimmed.slice(0, space) : trimmed;
                    const descriptor = space >= 0 ? trimmed.slice(space) : "";
                    return rewriteUrl(url, fromSrc, fromOut, true, pageOut) + descriptor;
                })
                .join(", ");
            return ` ${attr}="${next}"`;
        }
        const isImage = attr === "src";
        return ` ${attr}="${rewriteUrl(value, fromSrc, fromOut, isImage, pageOut)}"`;
    });
}

function sidebar(pages: Page[], current: Page): string {
    const link = (page: Page): string => {
        const href = relLink(current.out, page.out);
        const active = page.src === current.src ? ' class="active"' : "";
        const num = /^(\d{4})/.exec(page.out.replace(/^adr\//, ""))?.[1];
        const label =
            page.group === "adr" && num ? `<span class="side-num">${num}</span>${escapeHtml(page.label)}` : escapeHtml(page.label);
        return `<li><a href="${href}"${active}>${label}</a></li>`;
    };
    const guides = pages
        .filter((p) => p.group === "guide")
        .map(link)
        .join("");
    const adrs = pages
        .filter((p) => p.group === "adr")
        .map(link)
        .join("");
    return [
        `<p class="side-title">Documentation</p>`,
        `<ul class="side-list">${guides}</ul>`,
        `<p class="side-title">Architecture decisions</p>`,
        `<ul class="side-list">${adrs}</ul>`,
    ].join("\n");
}

function layout(page: Page, pages: Page[], content: string): string {
    const home = relLink(page.out, "index.html");
    const css = relLink(page.out, "style.css");
    const favicon = relLink(page.out, "favicon.svg");
    const title = page.src === "README.md" ? "Compose Panel" : `${page.title} · Compose Panel`;
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="icon" href="${favicon}" type="image/svg+xml">
<link rel="stylesheet" href="${css}">
</head>
<body>
<a class="skip" href="#content">Skip to content</a>
<header class="topbar">
  <a class="brand" href="${home}">
    <img src="${favicon}" alt="" width="22" height="22">
    <span>Compose Panel</span>
    <span class="brand-tag">docs</span>
  </a>
  <nav class="top-nav">
    <a href="${REPO}">GitHub</a>
  </nav>
</header>
<div class="layout">
  <aside class="sidebar">
    <nav>
${sidebar(pages, page)}
    </nav>
  </aside>
  <main class="content" id="content">
    <article class="doc">
${content}
    </article>
    <footer class="footer">
      <p>Compose Panel — EUPL-1.2. <a href="${REPO}">Source on GitHub</a>.</p>
    </footer>
  </main>
</div>
</body>
</html>
`;
}

async function build(): Promise<void> {
    await rm(OUT_DIR, { recursive: true, force: true });
    await mkdir(OUT_DIR, { recursive: true });

    const pages: Page[] = GUIDES.map((guide) => ({
        src: guide.src,
        out: outFor(guide.src),
        label: guide.label,
        title: guide.label,
        group: "guide",
    }));

    const adrDir = join(DOCS_DIR, "adr");
    const adrFiles = (await readdir(adrDir)).filter((name) => name.endsWith(".md")).sort();
    for (const name of adrFiles) {
        const src = `docs/adr/${name}`;
        const md = await Bun.file(join(ROOT, src)).text();
        const heading = firstHeading(md, name);
        pages.push({
            src,
            out: outFor(src),
            label: heading.replace(/^ADR\s+\d+\s*[—-]\s*/, ""),
            title: heading,
            group: "adr",
        });
    }

    const pageOut = new Map(pages.map((page) => [page.src, page.out] as const));

    for (const page of pages) {
        const md = await Bun.file(join(ROOT, page.src)).text();
        const html = rewriteHtml(Bun.markdown.html(md), page.src, page.out, pageOut);
        const target = join(OUT_DIR, page.out);
        await mkdir(dirname(target), { recursive: true });
        await Bun.write(target, layout(page, pages, html));
    }

    await mkdir(join(OUT_DIR, "assets"), { recursive: true });
    for (const name of await readdir(join(DOCS_DIR, "assets"))) {
        await Bun.write(join(OUT_DIR, "assets", name), Bun.file(join(DOCS_DIR, "assets", name)));
    }
    for (const name of ["favicon.svg", "apple-touch-icon.png"]) {
        await Bun.write(join(OUT_DIR, name), Bun.file(join(ROOT, "public", name)));
    }
    await Bun.write(join(OUT_DIR, "style.css"), Bun.file(CSS_SRC));

    console.log(`Built ${pages.length} pages into ${posix.relative(ROOT.replace(/\\/g, "/"), OUT_DIR.replace(/\\/g, "/"))}`);
}

async function serve(): Promise<void> {
    Bun.serve({
        port: PORT,
        async fetch(request) {
            const path = decodeURIComponent(new URL(request.url).pathname);
            const rel = path.endsWith("/") ? `${path}index.html` : path;
            const file = Bun.file(join(OUT_DIR, rel));
            if (!(await file.exists())) return new Response("Not found", { status: 404 });
            return new Response(file);
        },
    });
    console.log(`Serving docs on http://127.0.0.1:${PORT}`);
}

await build();
if (process.argv.includes("--serve")) await serve();
