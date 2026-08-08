import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * Starts a throwaway Postgres and applies the committed migrations to it. Tests get the real
 * schema rather than a hand-built one, so a missing migration fails the suite instead of
 * silently passing against a shape that only exists in test code.
 */
export async function startDatabase(): Promise<StartedPostgreSqlContainer> {
  const container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  // `prisma migrate deploy` directly, not the dotenv-wrapped script: the container's URL must
  // win, and dotenv -e would overwrite it with the developer's local one.
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: join(__dirname, '..', '..'),
    env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
    stdio: 'pipe',
  });
  return container;
}
