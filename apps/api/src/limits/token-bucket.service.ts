import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

const PREFIX = 'bucket:';

/**
 * Continuous refill, evaluated atomically in one round trip.
 *
 * The clock comes from the caller rather than `redis.call('TIME')`: it keeps the script
 * deterministic and testable, and replicas never disagree about now.
 */
const SCRIPT = `
local now = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local refill = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])

local state = redis.call('HMGET', KEYS[1], 'tokens', 'at')
local tokens = tonumber(state[1])
local at = tonumber(state[2])
if tokens == nil then tokens = capacity end
if at == nil then at = now end

tokens = math.min(capacity, tokens + (now - at) * refill)
local allowed = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
end

redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'at', tostring(now))
redis.call('EXPIRE', KEYS[1], ttl)

local wait = 0
if allowed == 0 then wait = (1 - tokens) / refill end
return { allowed, tostring(wait) }
`;

export interface BucketDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

@Injectable()
export class TokenBucketService {
  private readonly logger = new Logger(TokenBucketService.name);

  constructor(private readonly redis: RedisService) {}

  /**
   * Spends one token. `capacity` is the burst a caller may use at once; `refillPerSecond` is the
   * sustained rate they earn it back at.
   *
   * Fails **open**. A limiter is a safety margin: making it a hard dependency would turn a Redis
   * blip into a total outage, which is strictly worse than a few minutes without a ceiling.
   */
  async take(key: string, capacity: number, refillPerSecond: number): Promise<BucketDecision> {
    // Long enough that a bucket cannot be reset by waiting, short enough that idle keys go away.
    const ttl = Math.ceil(capacity / refillPerSecond) + 60;
    try {
      const [allowed, wait] = (await this.redis
        .raw()
        .eval(
          SCRIPT,
          1,
          `${PREFIX}${key}`,
          String(Date.now() / 1000),
          String(capacity),
          String(refillPerSecond),
          String(ttl),
        )) as [number, string];

      return {
        allowed: allowed === 1,
        // Rounded up: a Retry-After of 0 invites an immediate retry that cannot succeed.
        retryAfterSeconds: allowed === 1 ? 0 : Math.max(1, Math.ceil(Number(wait))),
      };
    } catch (error) {
      this.logger.warn(`Rate-limit bucket unavailable, allowing: ${(error as Error).message}`);
      return { allowed: true, retryAfterSeconds: 0 };
    }
  }

  /** Test seam only: buckets are otherwise cleared by their TTL. */
  async reset(): Promise<void> {
    const keys = await this.redis.raw().keys(`${PREFIX}*`);
    if (keys.length > 0) await this.redis.raw().del(...keys);
  }
}
