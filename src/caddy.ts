/**
 * Optional Caddy site management (ADR 0030, PR1: pure model only).
 *
 * This module is pure: domain/service/stack/port validation, canonical site
 * file generation and strict header parsing. No Docker, no filesystem, no
 * network, no Caddy call. The privileged helper (PR2) is authoritative for
 * writes; the preview on the stack page must render byte-identical content to
 * what the helper generates, as specified here.
 *
 * Canonical file layout (managed directory lives on the host, e.g.
 * `/etc/caddy/compose-panel.d/<domain>.caddy`):
 *
 * ```caddyfile
 * # compose-panel:managed v1
 * # compose-panel:stack web
 * # compose-panel:service web
 *
 * app.example.com {
 *     reverse_proxy 127.0.0.1:8080
 * }
 * ```
 */

import type { ParseResult } from "./compose-extension.ts";

/** Ownership header version. Bumped only by a new ADR. */
export const CADDY_MANAGED_VERSION = "v1";

/** Host-side managed directory (fixed in the helper configuration, PR2). */
export const CADDY_MANAGED_DIR = "/etc/caddy/compose-panel.d";

const MAX_DOMAIN_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;
const DOMAIN_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
/** Same service grammar as the scoped-operation check: no option-like names. */
const SERVICE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
/** Same stack grammar as `validateStackName` (`src/stacks.ts`). */
const STACK_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const IPV4 = /^\d+\.\d+\.\d+\.\d+$/;

export interface CaddySiteRequest {
    domain: string;
    stack: string;
    service: string;
    port: number;
}

function usableText(value: string): boolean {
    return value.length > 0 && !/[\x00-\x1f\x7f]/.test(value);
}

/**
 * Normalize a domain for comparison and file naming: trim and lowercase.
 * Returns null when the input carries control characters.
 */
export function normalizeDomain(value: string): string | null {
    const domain = value.trim().toLowerCase();
    if (!usableText(domain)) return null;
    return domain;
}

/**
 * Strict public-domain check for V1: at least two dot-separated LDH labels,
 * no wildcard, no trailing dot, no port/path, no IP literal.
 */
export function isValidDomain(value: string): boolean {
    const domain = normalizeDomain(value);
    if (!domain || domain.length > MAX_DOMAIN_LENGTH) return false;
    if (domain.includes("*") || domain.includes("/") || domain.includes(":") || domain.includes(" ")) return false;
    if (domain.startsWith(".") || domain.endsWith(".") || domain.includes("..")) return false;
    const labels = domain.split(".");
    if (labels.length < 2) return false;
    for (const label of labels) {
        if (label.length < 1 || label.length > MAX_LABEL_LENGTH) return false;
        if (!DOMAIN_LABEL.test(label)) return false;
    }
    if (IPV4.test(domain)) return false;
    return true;
}

export function isValidServiceName(value: string): boolean {
    return SERVICE_NAME.test(value);
}

export function isValidStackName(value: string): boolean {
    return STACK_NAME.test(value);
}

export function isValidUpstreamPort(port: number): boolean {
    return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * Split a `docker inspect` host binding (`127.0.0.1:8080`, `[::1]:8080`)
 * into its IP and port. Anything else is not a usable binding.
 */
export function splitHostBinding(host: string): { ip: string; port: number } | null {
    const match = /^\[([^\]]+)\]:(\d+)$/.exec(host) ?? /^([^:[\]]+):(\d+)$/.exec(host);
    if (!match) return null;
    const port = Number(match[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { ip: match[1]!, port };
}

/**
 * Whether a Docker published port is exactly the upstream the managed file
 * generates (`reverse_proxy 127.0.0.1:<port>` over TCP): the container-side
 * protocol must be TCP and the host binding must be `127.0.0.1` with the
 * requested port. An IPv6-only (`::1`) or UDP publication is refused here,
 * since dialing `127.0.0.1` would fail or reach a different service.
 */
export function matchesGeneratedUpstream(containerPort: string, hostBinding: string | null, port: number): boolean {
    if (hostBinding === null) return false;
    const protocol = containerPort.split("/")[1] ?? "";
    if (protocol.toLowerCase() !== "tcp") return false;
    const split = splitHostBinding(hostBinding);
    return split !== null && split.ip === "127.0.0.1" && split.port === port;
}

/** File name of a managed site, after domain validation. */
export function siteFilename(domain: string): string | null {
    const normalized = normalizeDomain(domain);
    if (!normalized || !isValidDomain(normalized)) return null;
    return `${normalized}.caddy`;
}

/**
 * Render the canonical managed file. Inputs are validated first; an invalid
 * request throws, so callers validate user input before previewing.
 */
export function buildSiteFile(request: CaddySiteRequest): string {
    const domain = normalizeDomain(request.domain);
    if (!domain || !isValidDomain(domain)) throw new Error("Invalid domain.");
    if (!isValidStackName(request.stack)) throw new Error("Invalid stack name.");
    if (!isValidServiceName(request.service)) throw new Error("Invalid service name.");
    if (!isValidUpstreamPort(request.port)) throw new Error("Invalid upstream port.");
    return `# compose-panel:managed ${CADDY_MANAGED_VERSION}
# compose-panel:stack ${request.stack}
# compose-panel:service ${request.service}

${domain} {
\treverse_proxy 127.0.0.1:${request.port}
}
`;
}

/**
 * Parse a managed file strictly: the exact ownership header, one blank line,
 * then exactly the canonical site block. Anything else (foreign file,
 * externally modified content, extra directives) is an error — never silently
 * adopted. Returns the extracted request on success.
 */
export function parseSiteFile(source: string): ParseResult<CaddySiteRequest> {
    const lines = source.split("\n");
    // Trailing newline produces a final empty element; drop exactly one.
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    // Canonical layout: 3 header lines, 1 blank line, 3 body lines.
    if (lines.length !== 7) return { ok: false, error: "Not a panel-managed Caddy site file." };
    if (lines[0] !== `# compose-panel:managed ${CADDY_MANAGED_VERSION}`) {
        return { ok: false, error: "Not a panel-managed Caddy site file." };
    }
    const stackMatch = /^# compose-panel:stack ([a-z0-9][a-z0-9_-]{0,62})$/.exec(lines[1] ?? "");
    const serviceMatch = /^# compose-panel:service ([a-zA-Z0-9][a-zA-Z0-9_.-]{0,62})$/.exec(lines[2] ?? "");
    if (!stackMatch || !serviceMatch) return { ok: false, error: "Not a panel-managed Caddy site file." };
    if (lines[3] !== "") return { ok: false, error: "Not a panel-managed Caddy site file." };
    const domainMatch = /^([a-z0-9.-]+) \{$/.exec(lines[4] ?? "");
    const proxyMatch = /^\treverse_proxy 127\.0\.0\.1:(\d+)$/.exec(lines[5] ?? "");
    if (!domainMatch || !proxyMatch || lines[6] !== "}") {
        return { ok: false, error: "The managed file was changed outside the panel and is refused." };
    }
    const domain = domainMatch[1]!;
    const port = Number(proxyMatch[1]!);
    if (!isValidDomain(domain) || !isValidUpstreamPort(port)) {
        return { ok: false, error: "The managed file was changed outside the panel and is refused." };
    }
    return { ok: true, value: { domain, stack: stackMatch[1]!, service: serviceMatch[1]!, port } };
}
