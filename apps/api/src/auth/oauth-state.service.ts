import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

const STATE_PREFIX = 'oauth-state:';
// The window between redirecting to Patreon and the callback arriving. Kept short because a
// pending state is an unauthenticated write that anyone can provoke.
const STATE_TTL_SECONDS = 600;

@Injectable()
export class OAuthStateService {
  constructor(private readonly redis: RedisService) {}

  async start(): Promise<{ state: string; codeChallenge: string }> {
    const state = randomBytes(32).toString('base64url');
    const codeVerifier = randomBytes(32).toString('base64url');
    await this.redis.raw().set(`${STATE_PREFIX}${state}`, codeVerifier, 'EX', STATE_TTL_SECONDS);
    return {
      state,
      // Only the challenge ever leaves the server; the verifier stays in Redis until the
      // callback redeems it, which is what binds the two legs of the flow together.
      codeChallenge: createHash('sha256').update(codeVerifier).digest('base64url'),
    };
  }

  /**
   * GETDEL makes consumption atomic, so a replayed callback finds nothing even under
   * concurrent requests — a captured `code` cannot be exchanged a second time.
   */
  async consume(state: string): Promise<string | null> {
    return this.redis.raw().getdel(`${STATE_PREFIX}${state}`);
  }
}
