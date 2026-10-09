export function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, char => {
        switch (char) {
            case "&": return "&amp;";
            case "<": return "&lt;";
            case ">": return "&gt;";
            case '"': return "&quot;";
            case "'": return "&#39;";
            default: return char;
        }
    });
}

export interface DocumentOptions {
    /** When set, the header renders an authenticated logout form using this CSRF token. */
    logoutCsrf?: string;
    mode?: string;
}

export function documentHtml(title: string, body: string, options: DocumentOptions = {}): string {
    // 'body' must contain ONLY trusted markup assembled with escapeHtml().
    const logout = options.logoutCsrf
        ? `<form method="post" action="/logout" class="logout"><input type="hidden" name="csrf" value="${escapeHtml(options.logoutCsrf)}"><button type="submit">Log out</button></form>`
        : "";
    const mode = options.mode ?? "Local prototype · read-only";
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · Compose Panel</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <div class="shell">
    <header><a href="/" class="brand">Compose Panel</a><span class="mode">${escapeHtml(mode)}</span>${logout}</header>
    <main>${body}</main>
    <footer>Docker and Compose files remain the sources of truth.</footer>
  </div>
</body>
</html>`;
}

export function loginPage(options: { csrf: string; error?: string | null }): string {
    const error = options.error ? `<p class="error" role="alert">${escapeHtml(options.error)}</p>` : "";
    return documentHtml("Log in", `<h1>Log in</h1>${error}
<form method="post" action="/login" class="login-form">
  <input type="hidden" name="csrf" value="${escapeHtml(options.csrf)}">
  <label>User <input name="user" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" required></label>
  <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
  <button type="submit">Log in</button>
</form>`, { mode: "Authentication required" });
}

export interface EditPageOptions {
    name: string;
    csrf: string;
    composeFilename: string;
    composeSource: string;
    composeHash: string;
    envSource: string;
    envHash: string;
    envExists: boolean;
    error?: string | null;
}

export function editPage(options: EditPageOptions): string {
    const error = options.error ? `<p class="error" role="alert">${escapeHtml(options.error)}</p>` : "";
    const action = `/stacks/${encodeURIComponent(options.name)}/edit`;
    return documentHtml(`Edit ${options.name}`, `<p><a href="/stacks/${encodeURIComponent(options.name)}">← ${escapeHtml(options.name)}</a></p>
<h1>Edit ${escapeHtml(options.name)}</h1>${error}
<p class="note">Files are saved as raw text; comments and formatting are preserved. The draft is validated with the Compose CLI before writing. Every save keeps a backup.</p>
<form method="post" action="${action}" class="edit-form">
  <input type="hidden" name="csrf" value="${escapeHtml(options.csrf)}">
  <input type="hidden" name="composeHash" value="${escapeHtml(options.composeHash)}">
  <input type="hidden" name="envHash" value="${escapeHtml(options.envHash)}">
  <input type="hidden" name="envExists" value="${options.envExists ? "1" : "0"}">
  <label>${escapeHtml(options.composeFilename)}
    <textarea name="compose" rows="24" spellcheck="false" autocapitalize="none" required>${escapeHtml(options.composeSource)}</textarea>
  </label>
  <label>.env <small>sensitive — never shown in logs</small>
    <textarea name="env" rows="12" spellcheck="false" autocapitalize="none">${escapeHtml(options.envSource)}</textarea>
  </label>
  <button type="submit">Save and validate</button>
</form>`, { mode: "Editing" });
}

export function htmlResponse(body: string, status = 200): Response {
    return new Response(body, {
        status,
        headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
            "X-Frame-Options": "DENY",
            "Vary": "Cookie",
            "Content-Security-Policy": "default-src 'none'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        },
    });
}
