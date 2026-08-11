import { execFileSync } from 'node:child_process';

const STUB = process.env.E2E_STUB_URL ?? 'http://localhost:4000';

export interface StubMembership {
  campaignId: string;
  amountCents: number;
  isActivePatron: boolean;
  tierIds?: string[];
}

/** Tells the stub who the next login is and what they support. */
export async function setPatreonIdentity(options: {
  id: string;
  fullName?: string;
  memberships?: StubMembership[];
}): Promise<void> {
  const response = await fetch(`${STUB}/__control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      identity: { id: options.id, full_name: options.fullName ?? 'Ada Lovelace' },
      memberships: options.memberships ?? [],
    }),
  });
  if (!response.ok) throw new Error(`stub control failed: ${response.status}`);
}

// Addressed by container name rather than `docker compose exec`, which differs between the v1
// binary and the v2 plugin. The project name is pinned in docker-compose.e2e.yml, so this is
// deterministic.
const POSTGRES_CONTAINER = process.env.E2E_POSTGRES_CONTAINER ?? 'patreonplanner-e2e-postgres-1';

/**
 * Seeds directly through psql rather than the API: claiming needs a Patreon campaign the stub
 * would have to own, and these tests are about the patron journey, not the claim flow.
 */
export function seed(sql: string): void {
  try {
    execFileSync(
      'docker',
      [
        'exec',
        '-i',
        POSTGRES_CONTAINER,
        'psql',
        '-U',
        'planner',
        '-d',
        'planner',
        '-v',
        'ON_ERROR_STOP=1',
        '-q',
        '-c',
        sql,
      ],
      { stdio: 'pipe' },
    );
  } catch (error) {
    const detail = (error as { stderr?: Buffer }).stderr?.toString() ?? String(error);
    throw new Error(`Seeding failed against ${POSTGRES_CONTAINER}: ${detail}`);
  }
}

const REDIS_CONTAINER = process.env.E2E_REDIS_CONTAINER ?? 'patreonplanner-e2e-redis-1';

/**
 * Clears the submission rate-limit counters. Their window is an hour, so without this the suite
 * is not hermetic: counters survive between runs and CI retries, and a later run starts hitting
 * 429 on submissions that should succeed.
 */
export function resetRateLimits(): void {
  execFileSync(
    'docker',
    [
      'exec',
      '-i',
      REDIS_CONTAINER,
      'sh',
      '-c',
      "redis-cli --scan --pattern 'ratelimit:*' | xargs -r redis-cli del > /dev/null",
    ],
    { stdio: 'pipe' },
  );
}

export const CREATOR = {
  id: '11111111-1111-1111-1111-111111111111',
  campaignId: 'campaign-e2e',
  slug: 'ada-writes',
  displayName: 'Ada Writes',
  ownerId: '22222222-2222-2222-2222-222222222222',
  policyId: '33333333-3333-3333-3333-333333333333',
  tierId: '44444444-4444-4444-4444-444444444444',
};

export function seedCreator(): void {
  seed(`
    DELETE FROM "Recommendation" WHERE "creatorId" = '${CREATOR.id}';
    INSERT INTO "User"(id,"patreonUserId","fullName","createdAt","updatedAt")
      VALUES ('${CREATOR.ownerId}','owner-e2e','Owner',now(),now())
      ON CONFLICT ("patreonUserId") DO NOTHING;
    INSERT INTO "Creator"(id,"patreonCampaignId","ownerUserId","displayName",slug,"claimedAt","createdAt","updatedAt")
      VALUES ('${CREATOR.id}','${CREATOR.campaignId}','${CREATOR.ownerId}','${CREATOR.displayName}','${CREATOR.slug}',now(),now(),now())
      ON CONFLICT ("patreonCampaignId") DO NOTHING;
    INSERT INTO "Tier"(id,"creatorId","patreonTierId",title,"amountCents","order","createdAt","updatedAt")
      VALUES ('${CREATOR.tierId}','${CREATOR.id}','tier-e2e','Supporter',500,0,now(),now())
      ON CONFLICT ("creatorId","patreonTierId") DO NOTHING;
    INSERT INTO "CreatorPolicy"(id,"creatorId","createdAt","updatedAt")
      VALUES ('${CREATOR.policyId}','${CREATOR.id}',now(),now())
      ON CONFLICT ("creatorId") DO NOTHING;
    UPDATE "CreatorPolicy" SET "viewVisibility"='PUBLIC', "submitMinTierId"=NULL, "upvoteMinTierId"=NULL
      WHERE "creatorId"='${CREATOR.id}';
  `);
}

export function setVisibility(value: 'PUBLIC' | 'ANY_PATREON_USER' | 'SUBSCRIBERS_ONLY'): void {
  seed(`UPDATE "CreatorPolicy" SET "viewVisibility"='${value}' WHERE "creatorId"='${CREATOR.id}';`);
}
