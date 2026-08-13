import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';

const DEFAULT_SOCKET_PATH = '/var/run/docker.sock';
const DEFAULT_SOCKET_URI = `unix://${DEFAULT_SOCKET_PATH}`;

/** The database every suite's own database is cloned from. Migrated once, then never written to. */
export const TEMPLATE_DATABASE = 'pp_template';

/**
 * Testcontainers looks for the daemon at the well-known socket paths and does not read Docker
 * CLI contexts, so runtimes that put their socket elsewhere (Colima, OrbStack, rootless Docker)
 * are invisible to it. Resolve the active context and pass its endpoint through DOCKER_HOST.
 */
function resolveDockerHost(): void {
  if (process.env.DOCKER_HOST) return;

  let host: string;
  try {
    host = execFileSync(
      'docker',
      ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
  } catch {
    // No docker CLI, or no context: let Testcontainers report the failure itself.
    return;
  }

  if (!host || host === DEFAULT_SOCKET_URI) return;

  process.env.DOCKER_HOST = host;
  // Ryuk mounts the daemon socket by its path *inside* the VM, where it is always the default.
  process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE ??= DEFAULT_SOCKET_PATH;
}

/**
 * One Postgres and one Redis for the whole run.
 *
 * Every database-backed suite used to start its own Postgres *and* run the full migration chain
 * inside it — thirty container starts and thirty migrations per run. That cost about five
 * seconds a suite before a single test executed, and the Docker contention it created is the
 * best explanation for the low-rate, two-symptom flakiness that survived every other fix.
 *
 * Instead the migrations run once into a template database, and each suite clones it with
 * `CREATE DATABASE … TEMPLATE …`, which Postgres does as a file copy. Isolation is unchanged —
 * every suite still gets a private database with the real schema, so a missing migration still
 * fails the suite rather than passing against a shape that only exists in test code.
 */
export default async function globalSetup(): Promise<void> {
  resolveDockerHost();

  const postgres = await new PostgreSqlContainer('pgvector/pgvector:pg16')
    .withDatabase(TEMPLATE_DATABASE)
    // One server for every suite now, and most suites hold two clients. The default 100 is
    // enough only while teardown keeps up; headroom is cheaper than a connection error surfacing
    // as a failed assertion three suites later.
    .withCommand(['postgres', '-c', 'max_connections=300'])
    .start();
  const redis = await new RedisContainer('redis:7-alpine').start();

  // `prisma migrate deploy` directly, not the dotenv-wrapped script: the container's URL must
  // win, and dotenv -e would overwrite it with the developer's local one.
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: join(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: postgres.getConnectionUri() },
    stdio: 'pipe',
  });

  // Read by the per-suite helpers. Jest forks workers from this process, so the environment
  // reaches them whether the run is in band or not.
  process.env.PP_TEST_PG_URI = postgres.getConnectionUri();
  process.env.PP_TEST_REDIS_URL = redis.getConnectionUrl();

  // Held for the teardown hook, which runs in this same process.
  (globalThis as Record<string, unknown>).__PP_CONTAINERS__ = { postgres, redis };
}
