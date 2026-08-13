import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedRedisContainer } from '@testcontainers/redis';

/** Stops the shared containers global-setup started. Ryuk would eventually, but not promptly. */
export default async function globalTeardown(): Promise<void> {
  const held = (globalThis as Record<string, unknown>).__PP_CONTAINERS__ as
    | { postgres: StartedPostgreSqlContainer; redis: StartedRedisContainer }
    | undefined;
  if (!held) return;
  await Promise.all([held.postgres.stop(), held.redis.stop()]);
}
