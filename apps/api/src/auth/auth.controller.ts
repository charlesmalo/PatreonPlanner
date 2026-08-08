import { timingSafeEqual } from 'node:crypto';
import {
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { CookieOptions, Request, Response } from 'express';
import { ConfigService } from '../config/config.module';
import { setCsrfCookie } from '../csrf/csrf.cookie';
import { CsrfTokenService } from '../csrf/csrf-token.service';
import { SESSION_COOKIE } from '../session/session.cookie';
import { CurrentUser, CurrentUserPayload, SessionGuard } from '../session/session.guard';
import { SessionService } from '../session/session.service';
import { AuthService } from './auth.service';
import { OAUTH_STATE_COOKIE, OAUTH_STATE_TTL_SECONDS } from './oauth-state.cookie';
import { PatreonCallbackQuery } from './patreon-callback.query';

@Controller()
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly csrfTokens: CsrfTokenService,
    private readonly config: ConfigService,
  ) {}

  @Get('auth/patreon/login')
  async login(@Res() res: Response): Promise<void> {
    const { url, state } = await this.auth.startLogin();
    res.cookie(OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      // Lax so the cookie survives the top-level cross-site GET that Patreon redirects back to.
      sameSite: 'lax',
      secure: this.isSecure(),
      path: '/',
      maxAge: OAUTH_STATE_TTL_SECONDS * 1000,
    });
    res.redirect(url);
  }

  @Get('auth/patreon/callback')
  async callback(
    @Query() query: PatreonCallbackQuery,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const boundState = req.cookies?.[OAUTH_STATE_COOKIE];
    // The flow must be redeemed by the browser that started it, checked before the state is
    // consumed so a mismatched attempt cannot burn someone else's pending state.
    if (!boundState || !this.matches(boundState, query.state)) {
      throw new UnauthorizedException('Invalid authentication request');
    }
    // Cleared regardless of outcome: left in place it would be replayable against a later state.
    res.clearCookie(OAUTH_STATE_COOKIE, this.clearOptions());

    const token = await this.auth.completeLogin(query.code, query.state);
    const previous = req.cookies?.[SESSION_COOKIE];
    // Rotation is only complete if the old session stops working, not merely stops being sent.
    if (previous) await this.sessions.destroy(previous);
    res.cookie(SESSION_COOKIE, token, this.sessionCookieOptions());
    // Re-bind CSRF to the new session here rather than letting the middleware heal it on the
    // next safe request, so the first write after login cannot 403.
    setCsrfCookie(res, this.csrfTokens.issue(token), this.config);
    res.redirect(this.config.get('WEB_ORIGIN'));
  }

  @Post('auth/logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res() res: Response): Promise<void> {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) await this.sessions.destroy(token);
    res.clearCookie(SESSION_COOKIE, this.clearOptions());
    // The old token was bound to the session just destroyed; re-issue it anonymous so the SPA
    // is not left holding one that can never verify again.
    setCsrfCookie(res, this.csrfTokens.issue(undefined), this.config);
    res.send();
  }

  // Served at /api/v1/me: this one is part of the versioned REST surface, unlike the OAuth
  // routes above.
  @Get('me')
  @UseGuards(SessionGuard)
  me(@CurrentUser() user: CurrentUserPayload): CurrentUserPayload {
    return user;
  }

  private sessionCookieOptions(): CookieOptions {
    return { ...this.clearOptions(), maxAge: this.config.get('SESSION_TTL_SECONDS') * 1000 };
  }

  /**
   * Deliberately carries no maxAge: express merges options over `expires: new Date(1)` and then
   * recomputes expires from maxAge, so passing it would re-issue the cookie for another full TTL
   * instead of deleting it.
   */
  private clearOptions(): CookieOptions {
    return {
      httpOnly: true,
      // Lax rather than Strict: the OAuth callback is a top-level cross-site GET navigation,
      // and Strict would strip the cookie from exactly that request.
      sameSite: 'lax',
      secure: this.isSecure(),
      path: '/',
    };
  }

  /** Derived from the redirect URI's scheme, so an HTTPS staging deploy is covered too. */
  private isSecure(): boolean {
    return this.config.get('PATREON_REDIRECT_URI').startsWith('https://');
  }

  private matches(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
  }
}
