import { Controller, Get, Query, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { CookieOptions, Request, Response } from 'express';
import { ConfigService } from '../config/config.module';
import { SESSION_COOKIE } from '../session/session.cookie';
import { SessionService } from '../session/session.service';
import { AuthService } from './auth.service';

@Controller()
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly config: ConfigService,
  ) {}

  @Get('auth/patreon/login')
  async login(@Res() res: Response): Promise<void> {
    res.redirect(await this.auth.buildLoginUrl());
  }

  @Get('auth/patreon/callback')
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: Response,
  ): Promise<void> {
    if (!code || !state) throw new UnauthorizedException('Invalid authentication request');
    const token = await this.auth.completeLogin(code, state);
    res.cookie(SESSION_COOKIE, token, this.cookieOptions());
    res.redirect(this.config.get('WEB_ORIGIN'));
  }

  @Get('auth/logout')
  async logout(@Req() req: Request, @Res() res: Response): Promise<void> {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) await this.sessions.destroy(token);
    res.clearCookie(SESSION_COOKIE, this.cookieOptions());
    res.status(204).send();
  }

  private cookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      // Lax rather than Strict: the OAuth callback is a top-level cross-site GET navigation,
      // and Strict would strip the cookie from exactly that request.
      sameSite: 'lax',
      secure: this.config.get('NODE_ENV') === 'production',
      path: '/',
      maxAge: this.config.get('SESSION_TTL_SECONDS') * 1000,
    };
  }
}
