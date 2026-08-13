import type Redis from 'ioredis';
import { RATE_LIMIT_PREFIX } from '../../src/limits/rate-limit.service';

/**
 * Rate-limit manipulation for tests, talking to Redis directly.
 *
 * Deliberately not methods on `RateLimitService`: that service is injected app-wide, and
 * `exhaust` is a griefing primitive — one careless controller away from letting anyone lock any
 * user out for an hour.
 */
export class LimitsHarness {
  constructor(private readonly redis: Redis) {}

  /** Clears every window. */
  async reset(): Promise<void> {
    const keys = await this.redis.keys(`${RATE_LIMIT_PREFIX}*`);
    if (keys.length > 0) await this.redis.del(...keys);
  }

  /** Drives a window past any plausible limit. */
  async exhaust(key: string): Promise<void> {
    await this.redis.set(`${RATE_LIMIT_PREFIX}${key}`, '1000000', 'EX', 3600);
  }

  /** Leaves exactly one allowance against a limit of `limit`. */
  async exhaustToOne(key: string, limit = 50): Promise<void> {
    await this.redis.set(`${RATE_LIMIT_PREFIX}${key}`, String(limit - 1), 'EX', 3600);
  }
}
