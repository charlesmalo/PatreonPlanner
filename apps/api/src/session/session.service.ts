import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '../config/config.module';
import { RedisService } from '../redis/redis.service';

const TOKEN_BYTES = 32;
const SESSION_PREFIX = 'sess:';
const USER_SESSIONS_PREFIX = 'sess-user:';

@Injectable()
export class SessionService {
  constructor(
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  async create(userId: string): Promise<string> {
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const ttl = this.config.get('SESSION_TTL_SECONDS');
    const key = this.keyFor(token);
    // The per-user index is what makes logout-everywhere possible without scanning the
    // keyspace, which would degrade as sessions accumulate.
    await this.redis
      .raw()
      .multi()
      .set(key, userId, 'EX', ttl)
      .sadd(`${USER_SESSIONS_PREFIX}${userId}`, key)
      .expire(`${USER_SESSIONS_PREFIX}${userId}`, ttl)
      .exec();
    return token;
  }

  async resolve(token: string): Promise<string | null> {
    return this.redis.raw().get(this.keyFor(token));
  }

  async destroy(token: string): Promise<void> {
    const key = this.keyFor(token);
    const userId = await this.redis.raw().get(key);
    const pipeline = this.redis.raw().multi().del(key);
    if (userId) pipeline.srem(`${USER_SESSIONS_PREFIX}${userId}`, key);
    await pipeline.exec();
  }

  async destroyAllForUser(userId: string): Promise<void> {
    const indexKey = `${USER_SESSIONS_PREFIX}${userId}`;
    const keys = await this.redis.raw().smembers(indexKey);
    if (keys.length > 0) await this.redis.raw().del(...keys);
    await this.redis.raw().del(indexKey);
  }

  /**
   * Sessions are stored under a SHA-256 of the token, never the token itself, so a dump of
   * Redis yields nothing a caller could present as a credential. Lookup is an O(1) keyed GET,
   * so there is also no secret-dependent comparison for a timing attack to target — which is
   * what design §9's "constant-time comparison for session tokens" is protecting against.
   */
  private keyFor(token: string): string {
    return `${SESSION_PREFIX}${createHash('sha256').update(token).digest('hex')}`;
  }
}
