import { timingSafeEqual } from 'node:crypto';
import { ForbiddenException, Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { ConfigService } from '../config/config.module';
import { SESSION_COOKIE } from '../session/session.cookie';
import { CSRF_COOKIE, csrfCookieOptions } from './csrf.cookie';
import { CsrfTokenService } from './csrf-token.service';

const CSRF_HEADER = 'x-csrf-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// Patreon's servers cannot carry our double-submit token; this route authenticates with an
// HMAC signature instead. Scoped to exactly the namespace WebhookSignatureGuard covers, so the
// exempt boundary and the verified boundary are the same set by construction.
const CSRF_EXEMPT_PREFIXES = ['/webhooks/patreon/'];

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
    if (CSRF_EXEMPT_PREFIXES.some((prefix) => req.originalUrl.startsWith(prefix))) {
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
