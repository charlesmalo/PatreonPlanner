# Same-origin deployment for the SPA and API

**Date:** 2026-08-08
**Status:** Accepted
**Context:** Raised by the Plan 02 code review, which required this settled before Plan 03 builds
authorization on top of the session and CSRF machinery.

## Decision

The SPA and the API are served from **one origin**. In production nginx serves the built SPA and
proxies `/api/` and `/auth/` to the API container; in development Vite's dev server proxies the
same two prefixes. There is no CORS configuration, and the API is never exposed on its own public
origin.

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
