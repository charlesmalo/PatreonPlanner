import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

const PREFIX = 'ratelimit:';

@Injectable()
export class RateLimitService {
  constructor(private readonly redis: RedisService) {}

  /**
   * Fixed-window counter. Returns false once the window's allowance is spent, and refund()
   * gives it back when the request turned out not to cost anything.
   *
   * INCR and EXPIRE run as one script. Issued separately, a process death or failover between
   * them leaves a key with no TTL — the counter then only grows and the caller is locked out
   * permanently, which design §9 forbids ("capped + decaying, never permanent").
   */
  async consume(key: string, limit: number, windowSeconds: number): Promise<boolean> {
    const count = (await this.redis.raw().eval(
      `local c = redis.call('INCR', KEYS[1])
       if c == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
       return c`,
      1,
      `${PREFIX}${key}`,
      windowSeconds,
    )) as number;
    return count <= limit;
  }

  /** Returns an allowance that was consumed for work that did not happen. Never goes below 0. */
  async refund(key: string): Promise<void> {
    await this.redis.raw().eval(
      `local c = tonumber(redis.call('GET', KEYS[1]) or '0')
       if c > 0 then redis.call('DECR', KEYS[1]) end
       return 1`,
      1,
      `${PREFIX}${key}`,
    );
  }
}
