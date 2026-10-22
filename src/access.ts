/**
 * Native access diagnostics (ADR 0013). Read-only and privilege-free: the report
 * is derived only from the panel's own configuration and the access point the
 * current request arrived on. It runs no host command and never claims an access
 * is secure from its declared configuration alone — "configured" and "unknown"
 * are distinct from "verified" on purpose.
 */

/**
 * The access point a request arrived on, resolved from its Host header (see
 * app.ts). Kept here so the report and the request handling share one shape.
 */
export type Access = { kind: "loopback" } | { kind: "proxy"; origin: string };

export type AccessStatus = "verified" | "configured" | "unknown";

export interface AccessFinding {
    /** What the row is about, e.g. "Panel listener" or "HTTPS origin https://…". */
    area: string;
    status: AccessStatus;
    detail: string;
}

export interface AccessReport {
    /** How the current request reached the panel. */
    request: string;
    findings: AccessFinding[];
    warnings: string[];
    /** Findings the panel checked and controls itself. */
    verifiedCount: number;
    /** Findings that need an external check the panel cannot perform. */
    externalCount: number;
}

export interface AccessReportInput {
    port: number;
    proxyOrigins: string[];
    allowLoopback: boolean;
    cookieSecure: boolean;
    devMode: boolean;
    allowOpaqueOrigin: boolean;
    /** Access point resolved for the current request; null only if routing was bypassed. */
    currentAccess: Access | null;
}

export function buildAccessReport(input: AccessReportInput): AccessReport {
    const loopbackEnabled = input.proxyOrigins.length === 0 || input.allowLoopback;
    const findings: AccessFinding[] = [];
    const warnings: string[] = [];

    findings.push({
        area: "Panel listener",
        status: "verified",
        detail: `Binds 127.0.0.1:${input.port} only. The bind is not configurable, so a published port cannot expose the panel.`,
    });
    findings.push({
        area: "Administrator authentication",
        status: "verified",
        detail: "One administrator account, Argon2id password hash, in-memory sessions with idle and absolute timeouts; common usernames are refused.",
    });
    findings.push({
        area: "CSRF and Origin/Host checks",
        status: "verified",
        detail: "Every change requires a matching CSRF token, and the Origin must match the access point the request arrived on.",
    });

    for (const origin of input.proxyOrigins) {
        findings.push({
            area: `Proxy origin ${origin}`,
            status: "configured",
            detail: "Only the https scheme is checked at startup. Whether this origin is restricted to a VPN, IP allow-list, firewall or identity proxy cannot be verified from the panel.",
        });
    }

    if (input.proxyOrigins.length === 0) {
        findings.push({
            area: "SSH tunnel (loopback)",
            status: "configured",
            detail: `http://127.0.0.1:${input.port} is the only path. The panel cannot tell whether a tunnel is currently open.`,
        });
    } else if (loopbackEnabled) {
        findings.push({
            area: "SSH tunnel (loopback)",
            status: "configured",
            detail: `http://127.0.0.1:${input.port} is allowed alongside the proxy origins. The panel cannot tell whether a tunnel is currently open.`,
        });
    } else {
        findings.push({
            area: "SSH tunnel (loopback)",
            status: "verified",
            detail: "Refused: proxy origins are configured and no loopback path is allowed (COMPOSE_PANEL_ALLOW_LOOPBACK is off).",
        });
    }

    findings.push({
        area: "Network restriction of the proxy origins",
        status: "unknown",
        detail: "The panel cannot confirm that a firewall, VPN, IP allow-list or identity proxy actually restricts these origins. Verify it from outside the trusted network.",
    });

    if (input.devMode) {
        warnings.push("COMPOSE_PANEL_DEV=true: development mode. Weak usernames are allowed; never use this in production.");
    }
    if (input.proxyOrigins.some((origin) => origin.startsWith("http:"))) {
        warnings.push("A proxy origin uses plain HTTP (development only): the password and session cookie travel in clear.");
    }
    if (input.allowOpaqueOrigin) {
        warnings.push(
            "COMPOSE_PANEL_ALLOW_OPAQUE_ORIGIN=true: an absent or opaque Origin is accepted for same-origin requests. Local testing only.",
        );
    }
    if (input.cookieSecure && loopbackEnabled) {
        warnings.push(
            "COMPOSE_PANEL_COOKIE_SECURE=true marks cookies Secure on the plain-HTTP loopback listener; sign-in through an SSH tunnel can fail in some browsers.",
        );
    }
    if (input.proxyOrigins.length > 0 && !input.allowLoopback) {
        warnings.push(
            "Proxy origins are configured and loopback is off: the SSH tunnel is refused. Set COMPOSE_PANEL_ALLOW_LOOPBACK=true to keep it.",
        );
    }

    const request =
        input.currentAccess === null
            ? "unknown"
            : input.currentAccess.kind === "loopback"
              ? `loopback (127.0.0.1:${input.port})`
              : `proxy origin ${input.currentAccess.origin}`;

    return {
        request,
        findings,
        warnings,
        verifiedCount: findings.filter((finding) => finding.status === "verified").length,
        externalCount: findings.filter((finding) => finding.status !== "verified").length,
    };
}
