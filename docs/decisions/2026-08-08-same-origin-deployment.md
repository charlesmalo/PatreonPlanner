# Same-origin deployment for the SPA and API

**Date:** 2026-08-08
**Status:** Accepted
**Context:** Raised by the Plan 02 code review, which required this settled before Plan 03 builds
authorization on top of the session and CSRF machinery.

## Decision

The SPA and the API are served from **one origin**. In production nginx serves the built SPA and
proxies `/api/`, `/auth/` and `/webhooks/` to the API container; in development Vite's dev server
proxies the same three prefixes. There is no CORS configuration, and the API is never exposed on
its own public origin.

**Amended 2026-09-09:** `/webhooks/` was missing from both, and had been since this was written.
Every Patreon and Resend delivery fell to the SPA fallback and was answered by `index.html` — a
405 to the sender, and nothing visibly wrong on this side. See the consequence below about which
paths must be forwarded, which is the rule that would have caught it.

## Why

Design §9 commits to an httpOnly session cookie plus a CSRF token the SPA must read back. A split
origin breaks both halves:

- `SameSite=Lax` withholds the session cookie on cross-site XHR, so every authenticated API call
  from the SPA would fail. Relaxing to `SameSite=None` would require `Secure` everywhere and give
  up the protection Lax provides against cross-site requests.
- A `pp_csrf` cookie set by an API host is not readable by script on the web host, so the SPA
  could never echo it in the `x-csrf-token` header.

Same-origin also removes an entire class of configuration risk: no CORS allow-list to maintain, no
credentialed-CORS preflight subtleties, and no chance of a permissive origin regex reaching
production.

This was already the direction the repo pointed — `apps/web/vite.config.ts` proxied `/api` from
Plan 01 — but production had no matching proxy, so the two environments disagreed. They now match.

## Consequences

- `apps/web/nginx.conf` and `apps/web/vite.config.ts` must be kept in step. Both carry a comment
  saying so.
- **Every path excluded from the API's global prefix must be forwarded by both proxies, or
  deliberately not forwarded.** The exclusions live in `apps/web/../api/src/app.setup.ts` and exist
  because an outside party registered the URL — Patreon, Resend — so the two lists are the same
  list seen from opposite ends. They drifted once already: adding `webhooks/*` to the exclusions
  without adding it to the proxies made the API's own routing correct and unreachable.

  The failure is silent in the worst way. A path the proxy does not forward is answered by the SPA
  fallback with **200 and `index.html`**, or 405 for a POST — never an error this side can see.
  `e2e/tests/webhook-routing.spec.ts` guards it by asserting who answered, on status *and* content
  type.

- **`/healthz` and `/readyz` are deliberately not forwarded, and that has a sharp edge.** Reaching
  them through the web origin returns `200 text/html` — the SPA — so anything pointed there reports
  healthy no matter what the API is doing. The compose health checks are correct: they hit the API
  container directly on `:3000`, never through nginx. But an uptime monitor or load balancer aimed
  at `https://<app>/healthz` would sit green through a total API outage.

  Left unforwarded on purpose rather than fixed: proxying them would publish readiness — which
  names the dependencies that are down — to anyone who asks. If a public health endpoint is ever
  wanted, it should be a new route that says only "up", not these two. Decide it deliberately.
- `PATREON_REDIRECT_URI` points at the **web** origin (`https://<app>/auth/patreon/callback`), not
  a separate API host. The OAuth routes stay at the root rather than under `/api/v1` because that
  URI is registered with Patreon and changing it means editing their app settings.
- `WEB_ORIGIN` is the origin the SPA and API share.
- The CSRF token can be bound to the session, which the review asked for: the SPA and API see the
  same cookie jar, so the token minted for a session is the one presented back.
- A future browser extension talking to the API is genuinely cross-origin and will need its own
  scheme — most likely a token header rather than cookies. That is out of scope until it exists.

## Alternatives considered

**Split origins with CORS.** Rejected: it forces `SameSite=None` on the session cookie and makes
the CSRF cookie unreadable to the SPA, i.e. it discards two of design §9's controls to gain
deployment flexibility we do not currently need.

**Token in a header, no cookies.** Rejected for the SPA: it requires storing a bearer token where
JavaScript can read it, trading a well-understood CSRF problem for an XSS-exfiltration one.
Design §9's httpOnly cookie is the stronger default. This remains the likely answer for the
extension.
