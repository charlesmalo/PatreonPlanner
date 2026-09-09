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
const REDIS_CONTAINER = process.env.E2E_REDIS_CONTAINER ?? 'patreonplanner-e2e-redis-1';
const POSTGRES_CONTAINER = process.env.E2E_POSTGRES_CONTAINER ?? 'patreonplanner-e2e-postgres-1';

/**
 * Seeds directly through psql rather than the API: claiming needs a Patreon campaign the stub
 * would have to own, and these tests are about the patron journey, not the claim flow.
 */
/**
 * Drops every session the API knows about, without touching the browser's cookie — which is
 * exactly what a session store restart looks like from the reader's side.
 */
export function forgetAllSessions(): void {
  execFileSync('docker', ['exec', REDIS_CONTAINER, 'redis-cli', 'FLUSHALL'], { stdio: 'pipe' });
}

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

/**
 * Clears the submission rate-limit counters and the coarse token buckets.
 *
 * Every request in this suite comes from one address, so the per-IP bucket is shared by the
 * whole run — without clearing it, a late journey fails on a ceiling an early one spent. Their window is an hour, so without this the suite
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
      "redis-cli --scan --pattern 'ratelimit:*' | xargs -r redis-cli del > /dev/null; redis-cli --scan --pattern 'bucket:*' | xargs -r redis-cli del > /dev/null",
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
  // A real v4 UUID rather than repeated digits like the ids above. `44444444-…-4444` is
  // accepted by Postgres but is **not** RFC 4122 — its variant nibble is wrong — so
  // `@IsUUID()` rejects it. This id is the only fixture id that travels in a request body
  // (the policy gates), and a 400 there looks exactly like the feature being broken.
  tierId: '89b82fa7-eef7-4bd5-a5ea-67a14b2fae59',
};

/** A second board, for the journeys that are about more than one. */
export const OTHER_CREATOR = {
  id: '55555555-5555-5555-5555-555555555555',
  campaignId: 'campaign-two-e2e',
  slug: 'bea-reads',
  displayName: 'Bea Reads',
  policyId: '66666666-6666-6666-6666-666666666666',
};

export function seedSecondBoard(): void {
  seed(`
    DELETE FROM "Recommendation" WHERE "creatorId" = '${OTHER_CREATOR.id}';
    INSERT INTO "Creator"(id,"patreonCampaignId","ownerUserId","displayName",slug,"claimedAt","createdAt","updatedAt")
      VALUES ('${OTHER_CREATOR.id}','${OTHER_CREATOR.campaignId}','${CREATOR.ownerId}','${OTHER_CREATOR.displayName}','${OTHER_CREATOR.slug}',now(),now(),now())
      ON CONFLICT ("patreonCampaignId") DO NOTHING;
    INSERT INTO "CreatorPolicy"(id,"creatorId","createdAt","updatedAt")
      VALUES ('${OTHER_CREATOR.policyId}','${OTHER_CREATOR.id}',now(),now())
      ON CONFLICT ("creatorId") DO NOTHING;
  `);
}

/**
 * Nobody starts premium.
 *
 * Called from `beforeEach`, because `premiumUntil` outlives a run: `seedCreator` clears
 * recommendations but not users, so a test that grants premium leaves the next run's reader
 * already holding it. That passes on a fresh database and fails on every run afterwards — which
 * is the worst shape of failure, because the first thing anybody does is re-run it.
 */
export function clearPremium(): void {
  // The projection *and* everything that would rebuild it. Nulling premiumUntil alone leaves the
  // Subscription row from the previous run, so the purchase journey would open /premium already
  // subscribed and pass without buying anything — green on a fresh database, green ever after,
  // and testing nothing.
  seed(`
    UPDATE "User" SET "premiumUntil" = NULL;
    DELETE FROM "PaymentReceipt";
    DELETE FROM "ProcessedWebhookEvent";
    DELETE FROM "Subscription";
  `);
}

/**
 * Grants premium directly, for the journeys that are about what premium *does* rather than about
 * buying it. Buying it is now a journey of its own — see the purchase test — and this shortcut
 * stays so the other tests do not each pay for a subscription first.
 */
export function makePremium(patreonUserId: string): void {
  seed(`
    UPDATE "User" SET "premiumUntil" = now() + interval '1 year'
     WHERE "patreonUserId" = ${sqlLiteral(patreonUserId)};
  `);
}

/** An active pledge to a board, which is what makes it a carry-over target. */
export function supports(patreonUserId: string, creatorId: string): void {
  seed(`
    INSERT INTO "Membership"(id,"userId","creatorId","amountCents","isActivePatron","createdAt","updatedAt")
      SELECT gen_random_uuid(), u.id, '${creatorId}', 500, true, now(), now()
      FROM "User" u WHERE u."patreonUserId" = ${sqlLiteral(patreonUserId)}
      ON CONFLICT ("userId","creatorId") DO UPDATE SET "isActivePatron" = true, "amountCents" = 500;
  `);
}

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
    UPDATE "CreatorPolicy" SET "viewVisibility"='PUBLIC', "submitMinTierId"=NULL,
      "upvoteMinTierId"=NULL, "hidePendingFromPublic"=false
      WHERE "creatorId"='${CREATOR.id}';
  `);
}

export function setVisibility(value: 'PUBLIC' | 'ANY_PATREON_USER' | 'SUBSCRIBERS_ONLY'): void {
  seed(`UPDATE "CreatorPolicy" SET "viewVisibility"='${value}' WHERE "creatorId"='${CREATOR.id}';`);
}

/**
 * Grants moderation power to an already-logged-in identity. The User row only exists after a
 * first login, so this is keyed on the Patreon id and runs after signing in.
 */
/**
 * Favourites and notifications outlive a test otherwise — a favourite left by an earlier run
 * makes the star a toggle in the wrong direction, and a stale unread count makes the bell lie.
 */
export function clearReaderState(): void {
  seed(`DELETE FROM "CreatorFavorite"; DELETE FROM "Notification";`);
}

/** Weights per Patreon tier id, creating the tier row if the sync has not yet made one. */
export function setTierWeights(weights: Record<string, number>): void {
  const rows = Object.entries(weights)
    .map(
      ([patreonTierId, weight], index) =>
        `INSERT INTO "Tier"(id,"creatorId","patreonTierId",title,"amountCents","voteWeight","order","createdAt","updatedAt")
           VALUES (gen_random_uuid(),'${CREATOR.id}','${patreonTierId}','${patreonTierId}',${weight * 100},${weight},${index},now(),now())
           ON CONFLICT ("creatorId","patreonTierId") DO UPDATE SET "voteWeight"=${weight};`,
    )
    .join('\n');
  seed(rows);
}

export function clearReactions(): void {
  seed(`DELETE FROM "Reaction";`);
}

export function clearTickets(): void {
  seed(`DELETE FROM "Ticket";`);
}

export function makeStaff(patreonUserId: string): void {
  seed(`
    -- The full set, matching what accepting an invite grants: an invitation says "come and
    -- moderate this board", and a moderator who can do nothing has been told something untrue.
    INSERT INTO "CreatorStaff"(id,"creatorId","userId",role,permissions,"createdAt","updatedAt")
      SELECT gen_random_uuid(),'${CREATOR.id}',u.id,'MOD',
             ARRAY['MOVE_ENTRIES','EDIT_ENTRIES','HANDLE_REPORTS','WRITE_NOTES','MANAGE_THEMES']::"StaffPermission"[],
             now(),now()
      FROM "User" u WHERE u."patreonUserId"=${sqlLiteral(patreonUserId)}
      ON CONFLICT ("creatorId","userId") DO NOTHING;
  `);
}

export function setHidePending(value: boolean): void {
  seed(
    `UPDATE "CreatorPolicy" SET "hidePendingFromPublic"=${value} WHERE "creatorId"='${CREATOR.id}';`,
  );
}

/**
 * Seeds an entry attributed to someone other than the browser's identity. Used where a journey
 * needs a second patron's submission without a second login — switching identities mid-test
 * proved flaky, and the property under test is about *whose* entry it is, not how it got there.
 */
/** Postgres string literal quoting — the seed helpers interpolate titles straight into SQL. */
function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function seedEntryFrom(
  patreonUserId: string,
  title: string,
  status: 'PENDING' | 'ACCEPTED' | 'ACTIVE' | 'COMPLETED' = 'PENDING',
): void {
  const normalized = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  seed(`
    INSERT INTO "User"(id,"patreonUserId","fullName","createdAt","updatedAt")
      VALUES (gen_random_uuid(),${sqlLiteral(patreonUserId)},'Other Patron',now(),now())
      ON CONFLICT ("patreonUserId") DO NOTHING;
    INSERT INTO "Recommendation"(id,"creatorId","submittedByUserId",type,"customTitle","normalizedTitle",status,"createdAt","updatedAt")
      SELECT gen_random_uuid(),'${CREATOR.id}',u.id,'EXTERNAL_LINK',${sqlLiteral(title)},${sqlLiteral(normalized)},'${status}',now(),now()
      FROM "User" u WHERE u."patreonUserId"=${sqlLiteral(patreonUserId)};
  `);
}

/**
 * Seeds the relation graph directly. The enrichment job is disabled in this stack and ticks every
 * fifteen minutes anyway, so waiting for it would test the scheduler rather than the board; the
 * builder itself has its own integration suite. What these journeys exercise is the *read* path:
 * that the SPA renders what the API projects.
 */
export function seedRelation(
  fromTmdbId: number,
  toTmdbId: number,
  kind: 'SEASON_OF' | 'SAME_FRANCHISE' | 'RELATED',
): void {
  seed(`
    INSERT INTO "TitleRelation"(id,"fromId","toId",kind,"createdAt")
      SELECT gen_random_uuid(), f.id, t.id, '${kind}', now()
      FROM "Title" f, "Title" t
      WHERE f."tmdbId" = ${fromTmdbId} AND t."tmdbId" = ${toTmdbId} AND f.id <> t.id
      ON CONFLICT ("fromId","toId",kind) DO NOTHING;
  `);
}

export function seedTheme(name: string, tmdbIds: number[]): void {
  const slug = name.toLowerCase();
  seed(`
    INSERT INTO "Theme"(id,"creatorId",name,slug,"createdAt","updatedAt")
      VALUES (gen_random_uuid(),'${CREATOR.id}','${name}','${slug}',now(),now())
      ON CONFLICT ("creatorId",slug) DO NOTHING;
    INSERT INTO "ThemeSource"("creatorId","sourceKey","themeId")
      SELECT '${CREATOR.id}','${slug}', th.id FROM "Theme" th
      WHERE th."creatorId"='${CREATOR.id}' AND th.slug='${slug}'
      ON CONFLICT DO NOTHING;
    ${
      // A theme with no titles is a legitimate thing to seed — it is what a rename or a merge
      // test wants — and an empty list produced `IN ()`, which is a syntax error rather than an
      // empty result. Skipped entirely instead.
      tmdbIds.length === 0
        ? ''
        : `INSERT INTO "TitleTheme"("titleId","themeId")
      SELECT t.id, th.id FROM "Title" t, "Theme" th
      WHERE t."tmdbId" IN (${tmdbIds.join(',')}) AND th."creatorId" = '${CREATOR.id}'
        AND th.slug = '${slug}'
      ON CONFLICT DO NOTHING;`
    }
  `);
}

export function clearIntelligence(): void {
  seed(`
    DELETE FROM "TitleRelation";
    DELETE FROM "TitleTheme";
    DELETE FROM "Theme" WHERE "creatorId" = '${CREATOR.id}';
  `);
}

/** Times a signed-in identity out, as the abuse curve would after repeated strikes. */
export function timeOutPatron(patreonUserId: string): void {
  seed(`
    INSERT INTO "AbuseRecord"(id,"userId","strikeCount","timeoutUntil","lastStrikeAt","createdAt","updatedAt")
      SELECT gen_random_uuid(), u.id, 3, now() + interval '1 hour', now(), now(), now()
      FROM "User" u WHERE u."patreonUserId" = ${sqlLiteral(patreonUserId)}
      ON CONFLICT ("userId") DO UPDATE SET "timeoutUntil" = now() + interval '1 hour';
  `);
}

export function clearAbuse(): void {
  seed(`DELETE FROM "AbuseRecord";`);
}

/** Makes the seeded creator's owner row point at a signed-in identity. */
export function makeOwner(patreonUserId: string): void {
  seed(`
    INSERT INTO "CreatorStaff"(id,"creatorId","userId",role,"createdAt","updatedAt")
      SELECT gen_random_uuid(),'${CREATOR.id}',u.id,'OWNER',now(),now()
      FROM "User" u WHERE u."patreonUserId"=${sqlLiteral(patreonUserId)}
      ON CONFLICT ("creatorId","userId") DO UPDATE SET role = 'OWNER';
  `);
}

/**
 * The blocklist outlives a run: nothing else deletes it, so a test that adds a word leaves the
 * next run starting with it already there. That passes on a fresh database and fails on every run
 * afterwards — the worst shape of failure, because the first thing anybody does is re-run it.
 */
export function clearBlocklist(): void {
  seed(`DELETE FROM "CreatorBlockword" WHERE "creatorId" = '${CREATOR.id}';`);
}

export function clearStaff(): void {
  seed(`
    DELETE FROM "StaffInvite" WHERE "creatorId" = '${CREATOR.id}';
    DELETE FROM "CreatorStaff" WHERE "creatorId" = '${CREATOR.id}';
  `);
}
