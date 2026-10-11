# ADR 0010 — Reverse proxy mode, loopback bind kept

Status: accepted. Amended by [ADR 0012](0012-multiple-access-origins.md), which
supersedes the single-origin rule and the global `COMPOSE_PANEL_TRUST_PROXY`
handling; the hard-coded loopback bind below stays in force.

## Context
Until now the panel was reachable only through an SSH tunnel, and its docs
forbade a reverse proxy until the proxy contract was reviewed. Remote use from a
phone or a browser without a tunnel needs HTTPS in front. Real deployments show
the risk of the usual setup: a panel published on `0.0.0.0` with a port mapping
stays reachable over plain HTTP next to its proxy, and Docker port mappings
bypass host firewalls.

## Decision
- **The bind stays hard-coded to `127.0.0.1`.** It is not configurable. The
  panel is reached either through an SSH tunnel or through a TLS reverse proxy
  running on the same host (on the host itself, or in a container with
  `network_mode: host`). A published port cannot expose it, even by mistake.
- **Proxy mode is one setting:** `COMPOSE_PANEL_PUBLIC_ORIGIN=https://<host>`.
  It implies Secure cookies and reading the client address from
  `X-Forwarded-For`. Inconsistent combinations are refused at startup instead
  of warned about:
  - a plain-`http` public origin (password and session cookie in clear),
    except with `COMPOSE_PANEL_DEV=true`;
  - `COMPOSE_PANEL_COOKIE_SECURE=false` with an https public origin;
  - `COMPOSE_PANEL_TRUST_PROXY=false` with a public origin (every visitor would
    share one sign-in throttle key, so one client could keep the admin waiting);
  - `COMPOSE_PANEL_TRUST_PROXY=true` without a public origin.
- The client address is the **last** `X-Forwarded-For` entry, the one the proxy
  appended. Earlier entries are client-controlled.
- Host and Origin checks compare against the public origin. In proxy mode a
  form posted through the SSH tunnel is refused (its Origin is the loopback
  one); use one access path at a time.
- The supported and tested proxy is Caddy. `scripts/proxy-e2e/run.sh` checks the
  whole contract against a real Caddy with TLS: Secure cookies, Origin and Host
  refusal, forged `X-Forwarded-For`, live SSE for actions and logs, UTF-8, and
  stream closure on sign-out.

## Consequences
- The panel can be used remotely over HTTPS without a tunnel, and a mistaken
  port mapping cannot expose it.
- A proxy in a bridge-networked container (common with label-based setups such
  as caddy-docker-proxy) cannot reach the panel unless that proxy uses host
  networking. This is deliberate: making the bind configurable would bring back
  the exposure this decision removes, and would need its own ADR.
- Exposure to the internet still rests on one password (Argon2id, delay-based
  throttle, ADR 0009). `docs/deployment.md` recommends a second barrier in front
  (VPN such as Tailscale/WireGuard, an IP allow-list in the proxy, or proxy
  authentication) and a host-level ban on the audit log.
- Other proxies (nginx, Traefik) are not documented as supported: they need
  explicit SSE flushing and correct `X-Forwarded-For` handling, and are not
  covered by the end-to-end test.
