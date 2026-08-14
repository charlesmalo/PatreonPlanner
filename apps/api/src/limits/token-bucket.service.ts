import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

export const BUCKET_PREFIX = 'bucket:';
const PREFIX = BUCKET_PREFIX;

/**
 * Continuous refill, evaluated atomically in one round trip.
 *
 * The clock is Redis's own. Taking it from the caller was backwards: `redis.call('TIME')` is
 * precisely what makes every app instance agree about now, and `Date.now()` is what makes them
 * disagree. With two instances 30s apart, a request from the one ahead drove the shared bucket
 * negative and the one behind was refused *every* request until real time caught up — a total
 * outage for half the traffic, from a design note that claimed the opposite.
 */
const SCRIPT = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) + tonumber(clock[2]) / 1000000
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])

local state = redis.call('HMGET', KEYS[1], 'tokens', 'at')
local tokens = tonumber(state[1])
local at = tonumber(state[2])
if tokens == nil then tokens = capacity end
if at == nil then at = now end

-- Floored as well as capped: a clock that ever moves backwards would otherwise drive the count
-- negative, where it stays until real time overtakes the skew.
tokens = math.max(0, math.min(capacity, tokens + math.max(0, now - at) * refill))
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
  /** Whether the last call failed, so an outage logs twice rather than once per request. */
  private degraded = false;

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
          String(capacity),
          String(refillPerSecond),
          String(ttl),
        )) as [number, string];

      if (this.degraded) {
        this.degraded = false;
        this.logger.log('Rate-limit buckets available again');
      }
      return {
        allowed: allowed === 1,
        // Rounded up: a Retry-After of 0 invites an immediate retry that cannot succeed.
        retryAfterSeconds: allowed === 1 ? 0 : Math.max(1, Math.ceil(Number(wait))),
      };
    } catch (error) {
      // Logged on the transition only. One line per failed call means one or two lines per
      // request for the duration of a Redis outage — a synchronous stderr flood that costs more
      // than the outage it is reporting.
      if (!this.degraded) {
        this.degraded = true;
        this.logger.error(
          `Rate-limit buckets unavailable, allowing all requests: ${(error as Error).message}`,
        );
      }
      return { allowed: true, retryAfterSeconds: 0 };
    }
  }
}
