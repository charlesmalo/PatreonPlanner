import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { TEMPLATE_DATABASE } from '../global-setup';

export interface TestDatabase {
  /** Connection string for this suite's own database. */
  getConnectionUri(): string;
  /** Drops it. Named `stop` so suites read the same as they did against a container. */
  stop(): Promise<void>;
}

function serverUri(): string {
  const uri = process.env.PP_TEST_PG_URI;
  if (!uri) throw new Error('PP_TEST_PG_URI is unset — global setup did not run');
  return uri;
}

function uriFor(database: string): string {
  const url = new URL(serverUri());
  url.pathname = `/${database}`;
  // Every suite shares one Postgres, so pools add up against its max_connections where before
  // each suite had a server to itself. Prisma defaults to `cpus * 2 + 1` per client and most
  // suites hold two clients; a suite never needs that many.
  url.searchParams.set('connection_limit', '5');
  // Generous timeouts, because the failure this chases was P1002/P1008/P1017 — Prisma's connect
  // and operation timeouts tripping while Docker was busy, surfacing as an intermittent 500 in
  // whichever suite was unlucky. Production keeps the defaults; a laptop or a CI runner starting
  // containers alongside 48 suites does not deserve a five-second budget.
  url.searchParams.set('connect_timeout', '30');
  url.searchParams.set('pool_timeout', '30');
  return url.toString();
}

/**
 * Gives the suite a private database cloned from the migrated template.
 *
 * `CREATE DATABASE … TEMPLATE …` is a file copy, so this costs milliseconds where starting a
 * container and replaying every migration cost seconds. The schema is still the real one — it
 * came from the committed migrations — so a missing migration still fails the suite.
 */
export async function startDatabase(): Promise<TestDatabase> {
  // Postgres identifiers cannot start with a digit and dislike hyphens.
  const name = `pp_${randomUUID().replace(/-/g, '')}`;
  const admin = new Client({ connectionString: serverUri() });
  await admin.connect();
  try {
    // The template must have no other sessions attached at copy time; nothing connects to it
    // after the migration step, and each suite's own writes land in its own copy.
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE "${TEMPLATE_DATABASE}"`);
  } finally {
    await admin.end();
  }

  return {
    getConnectionUri: () => uriFor(name),
    stop: async () => {
      const cleanup = new Client({ connectionString: serverUri() });
      await cleanup.connect();
      try {
        // WITH (FORCE) rather than a polite DROP: a suite that leaked a connection would
        // otherwise fail teardown and cascade into the next one.
        await cleanup.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await cleanup.end();
      }
    },
  };
}

/**
 * The shared Redis, flushed for the caller.
 *
 * Sharing one server relies on suites running sequentially (`--runInBand`), which the test
 * script pins. Flushing at suite start rather than teardown means a crashed suite cannot leave
 * keys behind for the next one.
 */
export function redisUrl(): string {
  const url = process.env.PP_TEST_REDIS_URL;
  if (!url) throw new Error('PP_TEST_REDIS_URL is unset — global setup did not run');
  return url;
}
