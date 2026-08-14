import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { ConfigService } from '../config/config.module';
import { SESSION_COOKIE } from '../session/session.cookie';
import { SessionService } from '../session/session.service';
import { clientIp } from './client-ip';
import { TokenBucketService } from './token-bucket.service';

/** Opts a *read* into limiting. Reads are otherwise free; search is the one with a real cost. */
export const RATE_LIMIT_BUCKET = 'RATE_LIMIT_BUCKET';
export const RateLimited = (bucket: 'search') => SetMetadata(RATE_LIMIT_BUCKET, bucket);

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Design §6.2's coarse limiter: a Redis token bucket on every mutating route, keyed by IP *and*
 * user.
 *
 * Both buckets must pass. Per-user alone lets one account spread across a botnet; per-IP alone
 * lets a NAT full of patrons throttle each other. The tighter refusal is the one reported.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly buckets: TokenBucketService,
    private readonly sessions: SessionService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const named = this.reflector.getAllAndOverride<'search' | undefined>(RATE_LIMIT_BUCKET, [
      context.getHandler(),
      context.getClass(),
    ]);

    // Reads are free unless they opted in.
    if (!named && SAFE_METHODS.has(request.method)) return true;

    const [capacity, perMinute] = named
      ? [this.config.get('SEARCH_LIMIT_BURST'), this.config.get('SEARCH_LIMIT_PER_MINUTE')]
      : [this.config.get('COARSE_LIMIT_BURST'), this.config.get('COARSE_LIMIT_PER_MINUTE')];
    const refill = perMinute / 60;
    const scope = named ?? 'write';

    let refused;
    try {
      const ip = clientIp(request, this.config.get('TRUSTED_PROXY_HOPS'));
      const userId = await this.resolveUser(request);

      const decisions = [await this.buckets.take(`${scope}:ip:${ip}`, capacity, refill)];
      if (userId) {
        decisions.push(await this.buckets.take(`${scope}:user:${userId}`, capacity, refill));
      }
      refused = decisions.find((decision) => !decision.allowed);
    } catch (error) {
      // Belt as well as braces: the bucket already fails open on a Redis error, but a fault
      // *here* would otherwise refuse every mutating request in the application. A limiter is a
      // safety margin, and it must never be the thing that takes the API down.
      this.logger.warn(`Rate limiting unavailable, allowing: ${(error as Error).message}`);
      return true;
    }
    if (!refused) return true;

    const response = context.switchToHttp().getResponse<Response>();
    response.setHeader('Retry-After', String(refused.retryAfterSeconds));
    // When, and nothing about the rule: design §9 wants no probing.
    throw new HttpException('Slow down', HttpStatus.TOO_MANY_REQUESTS);
  }

  /** Best effort: an unresolvable session is simply anonymous, limited by address alone. */
  private async resolveUser(request: Request): Promise<string | null> {
    const token = (request.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
    if (!token) return null;
    try {
      return await this.sessions.resolve(token);
    } catch {
      return null;
    }
  }
}
