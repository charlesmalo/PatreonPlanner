import { timingSafeEqual } from 'node:crypto';
import { ForbiddenException, Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { ConfigService } from '../config/config.module';
import { SESSION_COOKIE } from '../session/session.cookie';
import { CSRF_COOKIE, csrfCookieOptions } from './csrf.cookie';
import { CsrfTokenService } from './csrf-token.service';

const CSRF_HEADER = 'x-csrf-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// Nobody else's servers can carry our double-submit token; these routes authenticate with an
// HMAC signature over the raw body instead. The exempt boundary and the signature-verified
// boundary must stay the same set — an exemption wider than the verification is an unauthenticated
// mutating endpoint.
//
// The billing entry is the exact path rather than the `/billing/` namespace for that reason:
// `/billing/checkout` sits beside it, is session-authenticated, and needs the token like anything
// else. A prefix here would have quietly exempted it.
const CSRF_EXEMPT_PREFIXES = ['/webhooks/patreon/'];
const CSRF_EXEMPT_PATHS = ['/api/v1/billing/webhook'];
/**
 * The fake provider's checkout stand-in, exempt *only* on an instance actually running it.
 *
 * It breaks the rule above — the stand-in's form post is a plain browser form, so nothing has
 * verified a signature by the time it arrives — and it is listed separately to keep that visible
 * rather than buried in the set beside the honest entries.
 *
 * What makes it acceptable is what the fake provider already is. An instance running it grants
 * premium to anyone who asks, by design and with two config keys saying so; CSRF on this route
 * would protect something that is being given away on the next line. On every other instance the
 * exemption does not exist and the route answers 404.
 */
const FAKE_CHECKOUT_PATH = '/api/v1/billing/fake-checkout';

/**
 * Double-submit CSRF over signed, session-bound tokens. The token sits in a cookie the SPA can
 * read and must be echoed in a header: a cross-site form post sends the cookie automatically
 * but cannot set the header, and same-origin policy stops another site reading the cookie.
 * The signature additionally rules out a token the attacker chose rather than one we issued.
 */
@Injectable()
export class CsrfMiddleware implements NestMiddleware {
  constructor(
    private readonly tokens: CsrfTokenService,
    private readonly config: ConfigService,
  ) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const path = req.originalUrl.split('?')[0];
    if (
      CSRF_EXEMPT_PREFIXES.some((prefix) => req.originalUrl.startsWith(prefix)) ||
      CSRF_EXEMPT_PATHS.includes(path) ||
      (path === FAKE_CHECKOUT_PATH && this.config.get('BILLING_PROVIDER') === 'fake')
    ) {
      return next();
    }

    const sessionToken = req.cookies?.[SESSION_COOKIE];
    const cookieToken = req.cookies?.[CSRF_COOKIE];

    if (SAFE_METHODS.has(req.method)) {
      // Re-mint whenever the token is absent or no longer matches the caller's session, so the
      // binding self-heals across login and logout without the SPA doing anything.
      if (!this.tokens.verify(cookieToken, sessionToken)) {
        res.cookie(CSRF_COOKIE, this.tokens.issue(sessionToken), csrfCookieOptions(this.config));
      }
      return next();
    }

    const headerToken = req.header(CSRF_HEADER);
    if (
      !cookieToken ||
      !headerToken ||
      !equals(cookieToken, headerToken) ||
      !this.tokens.verify(cookieToken, sessionToken)
    ) {
      throw new ForbiddenException('Invalid CSRF token');
    }
    next();
  }
}

function equals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
