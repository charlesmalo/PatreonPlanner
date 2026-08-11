import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

const PREFIX = 'ratelimit:';

@Injectable()
export class RateLimitService {
  constructor(private readonly redis: RedisService) {}

  /**
   * Fixed-window counter. Returns false once the window's allowance is spent. Counted in Redis
   * rather than derived from createdAt, so it survives deletions and stays O(1).
   */
  async consume(key: string, limit: number, windowSeconds: number): Promise<boolean> {
    const redisKey = `${PREFIX}${key}`;
    const count = await this.redis.raw().incr(redisKey);
    // TTL set only when the counter is created: extending it on every call would let a steady
    // stream of requests hold the window open indefinitely.
    if (count === 1) await this.redis.raw().expire(redisKey, windowSeconds);
    return count <= limit;
  }
}
