import { randomBytes, timingSafeEqual } from 'node:crypto';
import { ForbiddenException, Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

const CSRF_COOKIE = 'pp_csrf';
const CSRF_HEADER = 'x-csrf-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Double-submit CSRF: a token is placed in a cookie the SPA can read and must be echoed back
 * in a header. A cross-site form post sends the cookie automatically but cannot set the
 * header, and same-origin policy stops another site reading the cookie to forge one — so the
 * header is the part an attacker cannot produce.
 */
@Injectable()
export class CsrfMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    if (SAFE_METHODS.has(req.method)) {
      if (!req.cookies?.[CSRF_COOKIE]) {
        res.cookie(CSRF_COOKIE, randomBytes(32).toString('base64url'), {
          // Readable by JS on purpose — the SPA has to echo it back.
          httpOnly: false,
          sameSite: 'lax',
          path: '/',
        });
      }
      return next();
    }

    const cookieToken = req.cookies?.[CSRF_COOKIE];
    const headerToken = req.header(CSRF_HEADER);
    if (!cookieToken || !headerToken || !this.matches(cookieToken, headerToken)) {
      throw new ForbiddenException('Invalid CSRF token');
    }
    next();
  }

  private matches(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    // timingSafeEqual throws on a length mismatch, so the lengths must be compared first.
    return left.length === right.length && timingSafeEqual(left, right);
  }
}
