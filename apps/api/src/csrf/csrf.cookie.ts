import type { CookieOptions, Response } from 'express';
import { ConfigService } from '../config/config.module';

export const CSRF_COOKIE = 'pp_csrf';

/**
 * Sets the CSRF cookie, dropping any value already queued on this response. The middleware
 * mints one on every safe request, so a handler that also issues one — login and logout, which
 * re-bind it — would otherwise emit two contradictory Set-Cookie headers for the same name.
 */
export function setCsrfCookie(res: Response, value: string, config: ConfigService): void {
  const existing = res.getHeader('Set-Cookie');
  const kept = (Array.isArray(existing) ? existing : existing ? [String(existing)] : []).filter(
    (cookie) => !cookie.startsWith(`${CSRF_COOKIE}=`),
  );
  res.setHeader('Set-Cookie', kept);
  res.cookie(CSRF_COOKIE, value, csrfCookieOptions(config));
}

export function csrfCookieOptions(config: ConfigService): CookieOptions {
  return {
    // Readable by JS on purpose — the SPA has to echo the value back in a header.
    httpOnly: false,
    sameSite: 'lax',
    // Without this an active network attacker on plain HTTP could plant a value of their own.
    secure: config.get('PATREON_REDIRECT_URI').startsWith('https://'),
    path: '/',
  };
}
