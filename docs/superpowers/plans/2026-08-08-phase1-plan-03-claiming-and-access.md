# Creator Claiming & Access Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Patreon creator claim their own campaign as a tenant, and enforce per-creator view/upvote/submit/moderate rules server-side — so later plans can add recommendations behind real authorization.

**Architecture:** Claiming proves ownership by asking Patreon, with the claimer's own access token, which campaigns *they* own; a campaign absent from that list cannot be claimed. A successful claim writes `Creator`, its `Tier`s, an `OWNER` `CreatorStaff` row and a default `CreatorPolicy` in one transaction. Authorization is a pure resolver (`can(capability, viewer, policy)`) with no I/O, wrapped by a `CreatorAccessGuard` that loads the viewer's membership and staff rows. Because claiming is the first consumer of stored Patreon tokens, this plan also adds refresh-on-demand.

**Tech Stack:** NestJS 10, Prisma 5.20, Redis, existing `SessionGuard`/`EncryptionService`/`PatreonClient` from Plan 02, Jest + supertest + Testcontainers.

## Global Constraints

Carried forward from design §9; every task's requirements implicitly include these.

- **Input validation:** `class-validator` DTOs on every endpoint (types, lengths, formats, malformed-body rejection).
- **Generic errors:** no user-enumeration; generic client messages; no stack traces/SQL/secrets in responses; **secrets never logged**.
- **All tier/role checks are server-side.** The SPA never gates security — design §4.
- **Moderation power derives only from a `CreatorStaff` row** — design §3.
- **Secret handling:** Patreon tokens stay encrypted at rest; a decrypted token never leaves the service that used it and is never logged or returned.
- **SQL injection:** Prisma parameterizes everything; `$queryRaw` only via tagged-template bound params.
- **Identifier normalization:** Patreon IDs are canonical keys; slug normalization is explicit with DB-level uniqueness.
- **CSRF:** every state-changing route sits behind the existing middleware; tests must send a signed, session-bound token.

## Scope

**In scope:** `CreatorStaff` + `CreatorPolicy` models, Patreon token refresh, owned-campaign lookup, `POST /creators/claim`, the capability resolver, `CreatorAccessGuard`, `GET /creators/:slug`, `GET|PATCH /creators/:id/policy`.

**Out of scope — deliberately deferred:**

- **Patreon webhooks** (design §4 "Keeping tier status fresh", primary path) → Plan 04. Login re-sync from Plan 02 remains the only freshness path.
- **Recommendations, upvotes, the board, moderation pipeline, abuse limiters** (design §5–§7) → Plan 05+. This plan builds the gate, not what sits behind it.
- **Staff invite/remove endpoints** (design §7 "Staff") → Plan 06. Plan 03 creates only the `OWNER` row at claim time; there is no way to add a `MOD` through the API yet.
- **Themes** (design §7) → Plan 07.

## Prerequisites

Plan 02 merged: `SessionGuard`, `SessionService`, `EncryptionService`, `PatreonClient` + `FakePatreonClient`, `CsrfMiddleware`, and the `User`/`Creator`/`Tier`/`Membership` models.

**No Patreon credentials are required.** Every test runs against `FakePatreonClient`, extended here with campaign and refresh support.

## Decisions this plan settles

**Tier comparison uses `amountCents`, not `Tier.order`.** Design §14 flags "verify tier ordering semantics during implementation" as an open assumption. `order` is a display concern and Patreon does not guarantee it expresses entitlement; `amountCents` is the value a patron actually pledges and is what "tier ≥ `submitMinTier`" must mean. The resolver therefore compares pledge amounts, and `order` is retained purely for rendering.

**Staff bypass the patron gates.** A `CreatorStaff` row grants `MODERATE` and implies `VIEW`, `UPVOTE` and `SUBMIT`. Design §4 says moderation is staff-only but is silent on whether a mod who is not a patron can see the board they moderate; requiring them to also pledge would make the product unusable for a creator's own mods. This is written into the resolver's tests so the intent is explicit rather than incidental.

**Claiming requires the `campaigns` scope, which changes the consent screen.** `HttpPatreonClient.buildAuthorizationUrl` gains `campaigns` in its scope list. Consequence: sessions created before this change hold tokens without that scope, so their owner must log in again before claiming succeeds. The claim endpoint must therefore fail with a clear, non-leaking error rather than a 500 when Patreon refuses the campaigns call.

---

## Task 1: `CreatorStaff`, `CreatorPolicy` and the claim fields

**Files:**

- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/*` (generated)
- Test: `apps/api/test/creator-model.int-spec.ts`

**Interfaces:**

- Consumes: `startDatabase()` from Plan 02's `test/support/database.ts`.
- Produces: enums `StaffRole { OWNER, MOD }` and `ViewVisibility { PUBLIC, ANY_PATREON_USER, SUBSCRIBERS_ONLY }`; models `CreatorStaff` and `CreatorPolicy`; `Creator.baseUrl`.

- [ ] **Step 1: Add the enums, models and `Creator.baseUrl` to `apps/api/prisma/schema.prisma`**

Add the enums above the models, add `baseUrl` plus the two new relations to `Creator`, and append the new models:

```prisma
enum StaffRole {
  OWNER
  MOD
}

enum ViewVisibility {
  PUBLIC
  ANY_PATREON_USER
  SUBSCRIBERS_ONLY
}
```

Inside `model Creator`, add the field and relations:

```prisma
  // The creator's own site, registered at claim time for the Phase 4 extension.
  baseUrl           String?

  staff  CreatorStaff[]
  policy CreatorPolicy?
```

Then append:

```prisma
model CreatorStaff {
  id               String    @id @default(uuid()) @db.Uuid
  creatorId        String    @db.Uuid
  userId           String    @db.Uuid
  role             StaffRole
  assignedByUserId String?   @db.Uuid
  createdAt        DateTime  @default(now())
  updatedAt        DateTime  @updatedAt

  creator    Creator @relation(fields: [creatorId], references: [id], onDelete: Cascade)
  user       User    @relation("StaffMember", fields: [userId], references: [id], onDelete: Cascade)
  assignedBy User?   @relation("StaffAssigner", fields: [assignedByUserId], references: [id])

  // One row per person per creator: moderation power derives only from this row, so a
  // duplicate would make "is this user staff?" ambiguous.
  @@unique([creatorId, userId])
  @@index([creatorId])
  @@index([userId])
  @@index([assignedByUserId])
}

model CreatorPolicy {
  id                   String         @id @default(uuid()) @db.Uuid
  creatorId            String         @unique @db.Uuid
  viewVisibility       ViewVisibility @default(PUBLIC)
  submitMinTierId      String?        @db.Uuid
  upvoteMinTierId      String?        @db.Uuid
  hidePendingFromPublic Boolean       @default(false)
  createdAt            DateTime       @default(now())
  updatedAt            DateTime       @updatedAt

  creator        Creator @relation(fields: [creatorId], references: [id], onDelete: Cascade)
  submitMinTier  Tier?   @relation("SubmitMinTier", fields: [submitMinTierId], references: [id])
  upvoteMinTier  Tier?   @relation("UpvoteMinTier", fields: [upvoteMinTierId], references: [id])

  @@index([submitMinTierId])
  @@index([upvoteMinTierId])
}
```

Add the matching back-relations. In `model User`:

```prisma
  staffRoles     CreatorStaff[] @relation("StaffMember")
  staffAssigned  CreatorStaff[] @relation("StaffAssigner")
```

In `model Tier`:

```prisma
  submitPolicies CreatorPolicy[] @relation("SubmitMinTier")
  upvotePolicies CreatorPolicy[] @relation("UpvoteMinTier")
```

Rate-limit overrides and the per-creator profanity blocklist from design §3 are intentionally absent: nothing reads them until Plan 05's moderation pipeline, and adding unused columns now invites them to drift from what that plan actually needs.

- [ ] **Step 2: Create the migration**

```bash
cd apps/api && pnpm prisma:migrate --name creator_staff_and_policy
```

Expected: a new directory under `prisma/migrations/` and `Generated Prisma Client`.

- [ ] **Step 3: Write the model test**

`apps/api/test/creator-model.int-spec.ts`:

```ts
import { PrismaClient } from '@prisma/client';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startDatabase } from './support/database';

describe('Creator staff and policy models (integration)', () => {
  let pg: StartedPostgreSqlContainer;
  let prisma: PrismaClient;

  beforeAll(async () => {
    pg = await startDatabase();
    prisma = new PrismaClient({ datasources: { db: { url: pg.getConnectionUri() } } });
    await prisma.$connect();
  }, 180_000);

  afterAll(async () => {
    await prisma.$disconnect();
    await pg.stop();
  });

  async function seedCreator(suffix: string) {
    const owner = await prisma.user.create({ data: { patreonUserId: `owner-${suffix}` } });
    const creator = await prisma.creator.create({
      data: {
        patreonCampaignId: `campaign-${suffix}`,
        ownerUserId: owner.id,
        displayName: `Creator ${suffix}`,
        slug: `creator-${suffix}`,
      },
    });
    return { owner, creator };
  }

  it('allows only one staff row per user per creator', async () => {
    const { owner, creator } = await seedCreator('a');
    await prisma.creatorStaff.create({
      data: { creatorId: creator.id, userId: owner.id, role: 'OWNER' },
    });
    await expect(
      prisma.creatorStaff.create({
        data: { creatorId: creator.id, userId: owner.id, role: 'MOD' },
      }),
    ).rejects.toThrow();
  });

  it('allows only one policy per creator', async () => {
    const { creator } = await seedCreator('b');
    await prisma.creatorPolicy.create({ data: { creatorId: creator.id } });
    await expect(prisma.creatorPolicy.create({ data: { creatorId: creator.id } })).rejects.toThrow();
  });

  it('defaults a policy to public with no tier gates', async () => {
    const { creator } = await seedCreator('c');
    const policy = await prisma.creatorPolicy.create({ data: { creatorId: creator.id } });
    expect(policy.viewVisibility).toBe('PUBLIC');
    expect(policy.submitMinTierId).toBeNull();
    expect(policy.upvoteMinTierId).toBeNull();
    expect(policy.hidePendingFromPublic).toBe(false);
  });

  it('removes staff and policy when the creator is deleted', async () => {
    const { owner, creator } = await seedCreator('d');
    await prisma.creatorStaff.create({
      data: { creatorId: creator.id, userId: owner.id, role: 'OWNER' },
    });
    await prisma.creatorPolicy.create({ data: { creatorId: creator.id } });

    await prisma.creator.delete({ where: { id: creator.id } });

    expect(await prisma.creatorStaff.count({ where: { creatorId: creator.id } })).toBe(0);
    expect(await prisma.creatorPolicy.count({ where: { creatorId: creator.id } })).toBe(0);
  });
});
```

- [ ] **Step 4: Run the test**

Run: `cd apps/api && pnpm test -- creator-model`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(api): creator staff and policy models"
```

---

## Task 2: Patreon token refresh

**Files:**

- Modify: `apps/api/src/patreon/patreon.client.ts`, `apps/api/src/patreon/http-patreon.client.ts`
- Modify: `apps/api/test/support/fake-patreon.client.ts`
- Create: `apps/api/src/patreon/patreon-token.service.ts`
- Modify: `apps/api/src/patreon/patreon.module.ts`
- Test: `apps/api/test/patreon-token.int-spec.ts`

**Interfaces:**

- Consumes: `PrismaService`, `EncryptionService`, `PATREON_CLIENT`.
- Produces: `PatreonClient.refreshTokens(refreshToken: string): Promise<PatreonTokens>`; `PatreonTokenService.getAccessToken(userId: string): Promise<string>` which decrypts, refreshes when expired, persists the new pair re-encrypted, and returns the plaintext access token.

Claiming is the first thing to use a stored Patreon token. Access tokens expire in about a month, so without this a user whose token lapsed could never claim — and the failure would look like "you do not own this campaign".

- [ ] **Step 1: Add `refreshTokens` to the interface**

In `apps/api/src/patreon/patreon.client.ts`, add to the `PatreonClient` interface:

```ts
  refreshTokens(refreshToken: string): Promise<PatreonTokens>;
```

- [ ] **Step 2: Implement it in `HttpPatreonClient`**

Add to `apps/api/src/patreon/http-patreon.client.ts`:

```ts
  async refreshTokens(refreshToken: string): Promise<PatreonTokens> {
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: this.config.get('PATREON_CLIENT_ID'),
        client_secret: this.config.get('PATREON_CLIENT_SECRET'),
      }).toString(),
    });
    if (!response.ok) {
      this.logger.warn(`Patreon token refresh failed with status ${response.status}`);
      throw new Error('Patreon token refresh failed');
    }
    const body = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresInSeconds: body.expires_in,
    };
  }
```

- [ ] **Step 3: Add `campaigns` to the requested scope**

In the same file, change the `scope` value in `buildAuthorizationUrl` to:

```ts
      scope: 'identity identity[email] identity.memberships campaigns',
```

Without it, Patreon returns no campaigns and every claim looks like a failed ownership check.

- [ ] **Step 4: Extend the fake**

In `apps/api/test/support/fake-patreon.client.ts`, add:

```ts
  public refreshCalls: string[] = [];
  public refreshShouldFail = false;

  async refreshTokens(refreshToken: string): Promise<PatreonTokens> {
    this.refreshCalls.push(refreshToken);
    if (this.refreshShouldFail) throw new Error('Patreon token refresh failed');
    return {
      accessToken: 'refreshed-access-token',
      refreshToken: 'refreshed-refresh-token',
      expiresInSeconds: 3600,
    };
  }
```

- [ ] **Step 5: Write the failing test**

`apps/api/test/patreon-token.int-spec.ts`:

```ts
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { AuthTestContext, pickCookie, startAuthApp } from './support/auth-app';
import { PatreonTokenService } from '../src/patreon/patreon-token.service';

describe('PatreonTokenService (integration)', () => {
  let ctx: AuthTestContext;
  let tokens: PatreonTokenService;
  let prisma: PrismaClient;

  beforeAll(async () => {
    ctx = await startAuthApp();
    tokens = ctx.app.get(PatreonTokenService);
    prisma = ctx.prisma;
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
  });

  async function loginAs(patreonUserId: string): Promise<string> {
    ctx.patreon.identity = { ...ctx.patreon.identity, patreonUserId };
    const start = await request(ctx.app.getHttpServer()).get('/auth/patreon/login').expect(302);
    const state = new URL(start.headers.location).searchParams.get('state') as string;
    await request(ctx.app.getHttpServer())
      .get(`/auth/patreon/callback?code=auth-code&state=${state}`)
      .set('Cookie', pickCookie(start, 'pp_oauth_state'))
      .expect(302);
    const user = await prisma.user.findUniqueOrThrow({ where: { patreonUserId } });
    return user.id;
  }

  it('returns the stored token without refreshing while it is valid', async () => {
    const userId = await loginAs('token-user-1');
    ctx.patreon.refreshCalls = [];
    expect(await tokens.getAccessToken(userId)).toBe('access-token');
    expect(ctx.patreon.refreshCalls).toHaveLength(0);
  });

  it('refreshes and persists when the stored token has expired', async () => {
    const userId = await loginAs('token-user-2');
    await prisma.user.update({
      where: { id: userId },
      data: { tokenExpiresAt: new Date(Date.now() - 1000) },
    });
    ctx.patreon.refreshCalls = [];

    expect(await tokens.getAccessToken(userId)).toBe('refreshed-access-token');
    expect(ctx.patreon.refreshCalls).toEqual(['refresh-token']);

    // Persisted, so the next call does not refresh again.
    ctx.patreon.refreshCalls = [];
    expect(await tokens.getAccessToken(userId)).toBe('refreshed-access-token');
    expect(ctx.patreon.refreshCalls).toHaveLength(0);
  });

  it('stores the refreshed pair encrypted', async () => {
    const userId = await loginAs('token-user-3');
    await prisma.user.update({
      where: { id: userId },
      data: { tokenExpiresAt: new Date(Date.now() - 1000) },
    });
    await tokens.getAccessToken(userId);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.accessTokenEncrypted).toContain('v1:');
    expect(user.accessTokenEncrypted).not.toContain('refreshed-access-token');
  });

  it('refreshes a token that is valid but within the expiry skew', async () => {
    const userId = await loginAs('token-user-4');
    // 30s left: a call made now could still arrive at Patreon after expiry.
    await prisma.user.update({
      where: { id: userId },
      data: { tokenExpiresAt: new Date(Date.now() + 30_000) },
    });
    ctx.patreon.refreshCalls = [];
    expect(await tokens.getAccessToken(userId)).toBe('refreshed-access-token');
    expect(ctx.patreon.refreshCalls).toHaveLength(1);
  });

  it('reports a missing token rather than throwing something opaque', async () => {
    const user = await prisma.user.create({ data: { patreonUserId: 'token-user-5' } });
    await expect(tokens.getAccessToken(user.id)).rejects.toThrow('No Patreon token');
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd apps/api && pnpm test -- patreon-token`
Expected: FAIL — cannot find module `../src/patreon/patreon-token.service`.

- [ ] **Step 7: Implement `PatreonTokenService`**

`apps/api/src/patreon/patreon-token.service.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { EncryptionService } from '../crypto/encryption.service';
import { PrismaService } from '../prisma/prisma.service';
import { PATREON_CLIENT, PatreonClient } from './patreon.client';

// Refresh a little early: a token valid at the moment of the check could still expire in
// flight, and the retry would look like an ownership failure to the caller.
const EXPIRY_SKEW_MS = 60_000;

@Injectable()
export class PatreonTokenService {
  constructor(
    @Inject(PATREON_CLIENT) private readonly patreon: PatreonClient,
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {}

  /** Returns a usable plaintext access token, refreshing and persisting it if needed. */
  async getAccessToken(userId: string): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { accessTokenEncrypted: true, refreshTokenEncrypted: true, tokenExpiresAt: true },
    });
    if (!user?.accessTokenEncrypted || !user.refreshTokenEncrypted) {
      throw new Error('No Patreon token for user');
    }

    const stillValid =
      user.tokenExpiresAt && user.tokenExpiresAt.getTime() - EXPIRY_SKEW_MS > Date.now();
    if (stillValid) return this.encryption.decrypt(user.accessTokenEncrypted);

    const refreshed = await this.patreon.refreshTokens(
      this.encryption.decrypt(user.refreshTokenEncrypted),
    );
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        accessTokenEncrypted: this.encryption.encrypt(refreshed.accessToken),
        refreshTokenEncrypted: this.encryption.encrypt(refreshed.refreshToken),
        tokenExpiresAt: new Date(Date.now() + refreshed.expiresInSeconds * 1000),
      },
    });
    return refreshed.accessToken;
  }
}
```

- [ ] **Step 8: Export it from `PatreonModule`**

```ts
@Global()
@Module({
  providers: [{ provide: PATREON_CLIENT, useClass: HttpPatreonClient }, PatreonTokenService],
  exports: [PATREON_CLIENT, PatreonTokenService],
})
export class PatreonModule {}
```

- [ ] **Step 9: Run the tests**

Run: `cd apps/api && pnpm test -- patreon-token`
Expected: PASS (5 tests).

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(api): refresh patreon tokens on demand and request the campaigns scope"
```

---

## Task 3: Owned-campaign lookup

**Files:**

- Modify: `apps/api/src/patreon/patreon.types.ts`, `patreon.client.ts`, `http-patreon.client.ts`
- Modify: `apps/api/test/support/fake-patreon.client.ts`
- Test: `apps/api/test/patreon-campaigns.e2e-spec.ts`

**Interfaces:**

- Produces: `PatreonCampaign { campaignId, displayName, tiers: PatreonTier[] }`, `PatreonTier { patreonTierId, title, amountCents, order }`, and `PatreonClient.fetchOwnedCampaigns(accessToken: string): Promise<PatreonCampaign[]>`.

- [ ] **Step 1: Add the types**

Append to `apps/api/src/patreon/patreon.types.ts`:

```ts
export interface PatreonTier {
  patreonTierId: string;
  title: string;
  amountCents: number;
  order: number;
}

export interface PatreonCampaign {
  campaignId: string;
  displayName: string;
  tiers: PatreonTier[];
}
```

- [ ] **Step 2: Add the method to the interface**

```ts
  fetchOwnedCampaigns(accessToken: string): Promise<PatreonCampaign[]>;
```

- [ ] **Step 3: Write the failing test**

`apps/api/test/patreon-campaigns.e2e-spec.ts`:

```ts
import { ConfigService } from '../src/config/config.module';
import { HttpPatreonClient } from '../src/patreon/http-patreon.client';
import { applyTestConfigDefaults } from './support/env';

describe('HttpPatreonClient.fetchOwnedCampaigns', () => {
  let client: HttpPatreonClient;
  const originalFetch = global.fetch;

  beforeAll(() => {
    process.env.DATABASE_URL = 'postgresql://planner:planner@localhost:5432/planner';
    process.env.REDIS_URL = 'redis://localhost:6379';
    applyTestConfigDefaults();
    client = new HttpPatreonClient(new ConfigService());
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('flattens campaigns and their tiers, ordered by pledge amount', async () => {
    const payload = {
      data: [
        {
          id: 'campaign-1',
          attributes: { creation_name: 'Ada Writes' },
          relationships: { tiers: { data: [{ id: 'tier-hi' }, { id: 'tier-lo' }] } },
        },
      ],
      included: [
        { id: 'tier-hi', type: 'tier', attributes: { title: 'Gold', amount_cents: 1000 } },
        { id: 'tier-lo', type: 'tier', attributes: { title: 'Bronze', amount_cents: 300 } },
        { id: 'someone-else', type: 'tier', attributes: { title: 'Other', amount_cents: 100 } },
      ],
    };
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, json: async () => payload } as unknown as Response);

    const campaigns = await client.fetchOwnedCampaigns('token');

    expect(campaigns).toHaveLength(1);
    expect(campaigns[0].campaignId).toBe('campaign-1');
    expect(campaigns[0].displayName).toBe('Ada Writes');
    // Ascending by amount, and `order` follows that ranking rather than payload order.
    expect(campaigns[0].tiers).toEqual([
      { patreonTierId: 'tier-lo', title: 'Bronze', amountCents: 300, order: 0 },
      { patreonTierId: 'tier-hi', title: 'Gold', amountCents: 1000, order: 1 },
    ]);
  });

  it('returns an empty list when the user owns no campaigns', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ data: [] }) } as unknown as Response);
    expect(await client.fetchOwnedCampaigns('token')).toEqual([]);
  });

  it('throws without leaking the response body when Patreon rejects the call', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 403 } as unknown as Response);
    await expect(client.fetchOwnedCampaigns('token')).rejects.toThrow(
      'Patreon campaign lookup failed',
    );
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `cd apps/api && pnpm test -- patreon-campaigns`
Expected: FAIL — `fetchOwnedCampaigns` is not a function.

- [ ] **Step 5: Implement it**

Add to `apps/api/src/patreon/http-patreon.client.ts`:

```ts
const CAMPAIGNS_URL = 'https://www.patreon.com/api/oauth2/v2/campaigns';

interface CampaignsPayload {
  data: Array<{
    id: string;
    attributes?: { creation_name?: string };
    relationships?: { tiers?: { data?: Array<{ id: string }> } };
  }>;
  included?: Array<{
    id: string;
    type: string;
    attributes?: { title?: string; amount_cents?: number };
  }>;
}
```

```ts
  /**
   * Patreon only returns campaigns the bearer of this token owns, which is what makes it an
   * ownership proof: a campaign absent from this list cannot be claimed by this user.
   */
  async fetchOwnedCampaigns(accessToken: string): Promise<PatreonCampaign[]> {
    const params = new URLSearchParams({
      include: 'tiers',
      'fields[campaign]': 'creation_name',
      'fields[tier]': 'title,amount_cents',
    });
    const response = await fetch(`${CAMPAIGNS_URL}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      this.logger.warn(`Patreon campaign lookup failed with status ${response.status}`);
      throw new Error('Patreon campaign lookup failed');
    }
    const body = (await response.json()) as CampaignsPayload;
    const tiersById = new Map((body.included ?? []).filter((e) => e.type === 'tier').map((e) => [e.id, e]));

    return (body.data ?? []).map((campaign) => {
      const tiers = (campaign.relationships?.tiers?.data ?? [])
        .map((ref) => tiersById.get(ref.id))
        .filter((tier): tier is NonNullable<typeof tier> => tier !== undefined)
        .map((tier) => ({
          patreonTierId: tier.id,
          title: tier.attributes?.title ?? 'Untitled',
          amountCents: tier.attributes?.amount_cents ?? 0,
        }))
        // Sorted by pledge amount so `order` expresses entitlement rank, not payload order.
        .sort((a, b) => a.amountCents - b.amountCents)
        .map((tier, index) => ({ ...tier, order: index }));

      return {
        campaignId: campaign.id,
        displayName: campaign.attributes?.creation_name ?? 'Untitled campaign',
        tiers,
      };
    });
  }
```

- [ ] **Step 6: Extend the fake**

In `apps/api/test/support/fake-patreon.client.ts`:

```ts
  public campaigns: PatreonCampaign[] = [];
  public campaignsShouldFail = false;

  async fetchOwnedCampaigns(): Promise<PatreonCampaign[]> {
    if (this.campaignsShouldFail) throw new Error('Patreon campaign lookup failed');
    return this.campaigns;
  }
```

- [ ] **Step 7: Run the tests**

Run: `cd apps/api && pnpm test -- patreon-campaigns`
Expected: PASS (3 tests).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(api): look up the campaigns a patreon user owns"
```

---

## Task 4: Claim a campaign

**Files:**

- Create: `apps/api/src/creators/creators.service.ts`, `creators.controller.ts`, `creators.module.ts`, `dto/claim-creator.dto.ts`, `slug.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/test/claim.int-spec.ts`, `apps/api/test/slug.e2e-spec.ts`

**Interfaces:**

- Consumes: `PatreonTokenService`, `PATREON_CLIENT`, `PrismaService`, `SessionGuard`.
- Produces: `POST /api/v1/creators/claim` with body `{ patreonCampaignId: string; baseUrl?: string }` → `201 { id, slug, displayName }`. `CreatorsService.claim(userId, dto)`.

- [ ] **Step 1: Write the slug helper and its test**

`apps/api/src/creators/slug.ts`:

```ts
/**
 * Lowercase, ASCII-ish, hyphen-separated. Deliberately explicit rather than a library: design
 * §9 requires identifier normalization to be visible and paired with DB-level uniqueness.
 */
export function slugify(input: string): string {
  const base = input
    .normalize('NFKD')
    // Strip combining marks so accented letters fold to their base rather than vanishing.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base.length > 0 ? base : 'creator';
}
```

`apps/api/test/slug.e2e-spec.ts`:

```ts
import { slugify } from '../src/creators/slug';

describe('slugify', () => {
  it.each([
    ['Ada Writes', 'ada-writes'],
    ['  Ada   Writes  ', 'ada-writes'],
    ['Ada’s Café', 'ada-s-cafe'],
    ['A/B  Testing!', 'a-b-testing'],
    ['---', 'creator'],
    ['', 'creator'],
    ['日本語', 'creator'],
  ])('turns %j into %j', (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  it('bounds the length so a long name cannot dominate a URL', () => {
    expect(slugify('a'.repeat(200))).toHaveLength(48);
  });
});
```

Run: `cd apps/api && pnpm test -- slug` → PASS (8 tests).

- [ ] **Step 2: Write the DTO**

`apps/api/src/creators/dto/claim-creator.dto.ts`:

```ts
import { IsOptional, IsString, IsUrl, Length } from 'class-validator';

export class ClaimCreatorDto {
  @IsString()
  @Length(1, 64)
  patreonCampaignId!: string;

  // The creator's own site, used by the Phase 4 extension. Restricted to http(s) so a
  // javascript: or data: URL can never be stored and later rendered as a link.
  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @Length(1, 2048)
  baseUrl?: string;
}
```

- [ ] **Step 3: Write the failing claim test**

`apps/api/test/claim.int-spec.ts`:

```ts
import request from 'supertest';
import { AuthTestContext, pickCookie, startAuthApp } from './support/auth-app';

describe('POST /api/v1/creators/claim (integration)', () => {
  let ctx: AuthTestContext;

  beforeAll(async () => {
    ctx = await startAuthApp();
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
  });

  /** Logs in and returns the cookies plus CSRF token needed for a state-changing request. */
  async function loginAs(patreonUserId: string) {
    ctx.patreon.identity = { ...ctx.patreon.identity, patreonUserId, memberships: [] };
    const start = await request(ctx.app.getHttpServer()).get('/auth/patreon/login').expect(302);
    const state = new URL(start.headers.location).searchParams.get('state') as string;
    const res = await request(ctx.app.getHttpServer())
      .get(`/auth/patreon/callback?code=auth-code&state=${state}`)
      .set('Cookie', pickCookie(start, 'pp_oauth_state'))
      .expect(302);
    const session = pickCookie(res, 'pp_session');
    const csrf = pickCookie(res, 'pp_csrf').split(';')[0];
    return { session, csrf, csrfToken: csrf.split('=').slice(1).join('=') };
  }

  function claim(auth: Awaited<ReturnType<typeof loginAs>>, body: unknown) {
    return request(ctx.app.getHttpServer())
      .post('/api/v1/creators/claim')
      .set('Cookie', [auth.session, auth.csrf])
      .set('x-csrf-token', auth.csrfToken)
      .send(body);
  }

  const campaign = {
    campaignId: 'campaign-owned',
    displayName: 'Ada Writes',
    tiers: [
      { patreonTierId: 'tier-lo', title: 'Bronze', amountCents: 300, order: 0 },
      { patreonTierId: 'tier-hi', title: 'Gold', amountCents: 1000, order: 1 },
    ],
  };

  it('requires authentication', async () => {
    await request(ctx.app.getHttpServer())
      .post('/api/v1/creators/claim')
      .send({ patreonCampaignId: 'campaign-owned' })
      .expect(403); // CSRF rejects before auth is even considered
  });

  it('rejects a campaign the user does not own', async () => {
    const auth = await loginAs('claimer-1');
    ctx.patreon.campaigns = [];
    await claim(auth, { patreonCampaignId: 'campaign-owned' }).expect(403);
  });

  it('creates the creator, tiers, owner staff row and default policy', async () => {
    const auth = await loginAs('claimer-2');
    ctx.patreon.campaigns = [campaign];

    const res = await claim(auth, {
      patreonCampaignId: 'campaign-owned',
      baseUrl: 'https://ada.example.com',
    }).expect(201);

    expect(res.body).toEqual({
      id: expect.any(String),
      slug: 'ada-writes',
      displayName: 'Ada Writes',
    });

    const creator = await ctx.prisma.creator.findUniqueOrThrow({
      where: { patreonCampaignId: 'campaign-owned' },
      include: { tiers: true, staff: true, policy: true },
    });
    expect(creator.baseUrl).toBe('https://ada.example.com');
    expect(creator.tiers.map((t) => t.patreonTierId).sort()).toEqual(['tier-hi', 'tier-lo']);
    expect(creator.staff).toHaveLength(1);
    expect(creator.staff[0].role).toBe('OWNER');
    expect(creator.policy?.viewVisibility).toBe('PUBLIC');
  });

  it('refuses to claim a campaign someone else already claimed', async () => {
    const first = await loginAs('claimer-3');
    ctx.patreon.campaigns = [{ ...campaign, campaignId: 'campaign-contested' }];
    await claim(first, { patreonCampaignId: 'campaign-contested' }).expect(201);

    const second = await loginAs('claimer-4');
    ctx.patreon.campaigns = [{ ...campaign, campaignId: 'campaign-contested' }];
    await claim(second, { patreonCampaignId: 'campaign-contested' }).expect(409);
  });

  it('gives a second creator with the same name a distinct slug', async () => {
    const auth = await loginAs('claimer-5');
    ctx.patreon.campaigns = [{ ...campaign, campaignId: 'campaign-dup' }];
    const res = await claim(auth, { patreonCampaignId: 'campaign-dup' }).expect(201);
    expect(res.body.slug).not.toBe('ada-writes');
    expect(res.body.slug).toMatch(/^ada-writes-/);
  });

  it('rejects a malformed body', async () => {
    const auth = await loginAs('claimer-6');
    await claim(auth, { patreonCampaignId: '' }).expect(400);
    await claim(auth, { patreonCampaignId: 'x', unexpected: 'field' }).expect(400);
    await claim(auth, { patreonCampaignId: 'x', baseUrl: 'javascript:alert(1)' }).expect(400);
  });

  it('reports a Patreon outage without a 500', async () => {
    const auth = await loginAs('claimer-7');
    ctx.patreon.campaignsShouldFail = true;
    await claim(auth, { patreonCampaignId: 'campaign-owned' }).expect(502);
    ctx.patreon.campaignsShouldFail = false;
  });

  it('leaves nothing behind when the claim fails', async () => {
    const auth = await loginAs('claimer-8');
    ctx.patreon.campaigns = [];
    await claim(auth, { patreonCampaignId: 'campaign-ghost' }).expect(403);
    expect(
      await ctx.prisma.creator.count({ where: { patreonCampaignId: 'campaign-ghost' } }),
    ).toBe(0);
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `cd apps/api && pnpm test -- claim`
Expected: FAIL — 404 on `/api/v1/creators/claim`.

- [ ] **Step 5: Implement `CreatorsService.claim`**

`apps/api/src/creators/creators.service.ts`:

```ts
import {
  BadGatewayException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PATREON_CLIENT, PatreonClient } from '../patreon/patreon.client';
import { PatreonTokenService } from '../patreon/patreon-token.service';
import { PrismaService } from '../prisma/prisma.service';
import { ClaimCreatorDto } from './dto/claim-creator.dto';
import { slugify } from './slug';

@Injectable()
export class CreatorsService {
  constructor(
    @Inject(PATREON_CLIENT) private readonly patreon: PatreonClient,
    private readonly tokens: PatreonTokenService,
    private readonly prisma: PrismaService,
  ) {}

  async claim(
    userId: string,
    dto: ClaimCreatorDto,
  ): Promise<{ id: string; slug: string; displayName: string }> {
    let owned;
    try {
      owned = await this.patreon.fetchOwnedCampaigns(await this.tokens.getAccessToken(userId));
    } catch {
      // An upstream failure is not the caller's fault and must not read as "you do not own this".
      throw new BadGatewayException('Could not reach Patreon');
    }

    const campaign = owned.find((c) => c.campaignId === dto.patreonCampaignId);
    // Patreon returns only campaigns this token's owner controls, so absence is the proof.
    if (!campaign) throw new ForbiddenException('Campaign not owned by this account');

    if (await this.prisma.creator.findUnique({ where: { patreonCampaignId: campaign.campaignId } })) {
      throw new ConflictException('Campaign already claimed');
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const creator = await tx.creator.create({
          data: {
            patreonCampaignId: campaign.campaignId,
            ownerUserId: userId,
            displayName: campaign.displayName,
            slug: await this.uniqueSlug(tx, slugify(campaign.displayName)),
            baseUrl: dto.baseUrl ?? null,
            tiers: { create: campaign.tiers },
            // Design §3: moderation power derives only from a CreatorStaff row, so the owner
            // needs one from the start rather than being special-cased everywhere.
            staff: { create: { userId, role: 'OWNER' } },
            policy: { create: {} },
          },
          select: { id: true, slug: true, displayName: true },
        });
        return creator;
      });
    } catch (error) {
      // Two claims racing past the check above collide on the unique constraint instead.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('Campaign already claimed');
      }
      throw error;
    }
  }

  private async uniqueSlug(tx: Prisma.TransactionClient, base: string): Promise<string> {
    if (!(await tx.creator.findUnique({ where: { slug: base } }))) return base;
    // Random rather than a counter: a counter leaks how many creators share a name and needs a
    // scan to compute.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = `${base}-${randomBytes(3).toString('hex')}`;
      if (!(await tx.creator.findUnique({ where: { slug: candidate } }))) return candidate;
    }
    throw new ConflictException('Could not allocate a slug');
  }
}
```

- [ ] **Step 6: Implement the controller and module**

`apps/api/src/creators/creators.controller.ts`:

```ts
import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { CurrentUser, CurrentUserPayload, SessionGuard } from '../session/session.guard';
import { CreatorsService } from './creators.service';
import { ClaimCreatorDto } from './dto/claim-creator.dto';

@Controller('creators')
export class CreatorsController {
  constructor(private readonly creators: CreatorsService) {}

  @Post('claim')
  @UseGuards(SessionGuard)
  claim(@CurrentUser() user: CurrentUserPayload, @Body() dto: ClaimCreatorDto) {
    return this.creators.claim(user.id, dto);
  }
}
```

`apps/api/src/creators/creators.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { CreatorsController } from './creators.controller';
import { CreatorsService } from './creators.service';

@Module({ controllers: [CreatorsController], providers: [CreatorsService] })
export class CreatorsModule {}
```

Register `CreatorsModule` in `AppModule`'s `imports`.

- [ ] **Step 7: Run the tests**

Run: `cd apps/api && pnpm test -- claim`
Expected: PASS (8 tests).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(api): claim a patreon campaign as a creator tenant"
```

---

## Task 5: The capability resolver

**Files:**

- Create: `apps/api/src/access/capability.ts`
- Test: `apps/api/test/capability.e2e-spec.ts`

**Interfaces:**

- Consumes: nothing — deliberately pure, no Prisma, no Redis.
- Produces: `type Capability = 'VIEW' | 'UPVOTE' | 'SUBMIT' | 'MODERATE'`, `interface Viewer`, `interface Policy`, and `can(capability: Capability, viewer: Viewer, policy: Policy): boolean`.

Keeping this pure is the point: authorization rules are the part most worth exhaustive testing, and they should be testable without a database.

- [ ] **Step 1: Write the failing test**

`apps/api/test/capability.e2e-spec.ts`:

```ts
import { Policy, Viewer, can } from '../src/access/capability';

const anonymous: Viewer = {
  isAuthenticated: false,
  isActivePatron: false,
  tierAmountCents: null,
  isStaff: false,
};
const loggedIn: Viewer = { ...anonymous, isAuthenticated: true };
const patron: Viewer = { ...loggedIn, isActivePatron: true, tierAmountCents: 500 };
const staff: Viewer = { ...loggedIn, isStaff: true };

const open: Policy = {
  viewVisibility: 'PUBLIC',
  submitMinTierAmountCents: null,
  upvoteMinTierAmountCents: null,
};

describe('can()', () => {
  describe('VIEW', () => {
    it('lets anyone view a PUBLIC creator', () => {
      expect(can('VIEW', anonymous, open)).toBe(true);
    });

    it('requires a login for ANY_PATREON_USER', () => {
      const policy: Policy = { ...open, viewVisibility: 'ANY_PATREON_USER' };
      expect(can('VIEW', anonymous, policy)).toBe(false);
      expect(can('VIEW', loggedIn, policy)).toBe(true);
    });

    it('requires an active pledge for SUBSCRIBERS_ONLY', () => {
      const policy: Policy = { ...open, viewVisibility: 'SUBSCRIBERS_ONLY' };
      expect(can('VIEW', loggedIn, policy)).toBe(false);
      expect(can('VIEW', patron, policy)).toBe(true);
    });

    it('does not treat a lapsed patron as active', () => {
      const lapsed: Viewer = { ...patron, isActivePatron: false };
      expect(can('VIEW', lapsed, { ...open, viewVisibility: 'SUBSCRIBERS_ONLY' })).toBe(false);
    });
  });

  describe('UPVOTE and SUBMIT', () => {
    it('requires an active pledge even with no tier gate', () => {
      expect(can('UPVOTE', loggedIn, open)).toBe(false);
      expect(can('UPVOTE', patron, open)).toBe(true);
      expect(can('SUBMIT', loggedIn, open)).toBe(false);
      expect(can('SUBMIT', patron, open)).toBe(true);
    });

    it('compares pledge amount against the gate', () => {
      const policy: Policy = { ...open, submitMinTierAmountCents: 1000 };
      expect(can('SUBMIT', patron, policy)).toBe(false);
      expect(can('SUBMIT', { ...patron, tierAmountCents: 1000 }, policy)).toBe(true);
      expect(can('SUBMIT', { ...patron, tierAmountCents: 1500 }, policy)).toBe(true);
    });

    it('gates upvote and submit independently', () => {
      const policy: Policy = {
        ...open,
        upvoteMinTierAmountCents: 300,
        submitMinTierAmountCents: 1000,
      };
      expect(can('UPVOTE', patron, policy)).toBe(true);
      expect(can('SUBMIT', patron, policy)).toBe(false);
    });

    it('treats an active patron with no entitled tier as pledging nothing', () => {
      const tierless: Viewer = { ...patron, tierAmountCents: null };
      expect(can('UPVOTE', tierless, open)).toBe(true);
      expect(can('UPVOTE', tierless, { ...open, upvoteMinTierAmountCents: 1 })).toBe(false);
    });
  });

  describe('MODERATE', () => {
    it('is granted only by a staff row', () => {
      expect(can('MODERATE', patron, open)).toBe(false);
      expect(can('MODERATE', staff, open)).toBe(true);
    });
  });

  describe('staff bypass', () => {
    it('lets staff view, upvote and submit without pledging', () => {
      const locked: Policy = {
        viewVisibility: 'SUBSCRIBERS_ONLY',
        submitMinTierAmountCents: 10_000,
        upvoteMinTierAmountCents: 10_000,
      };
      expect(can('VIEW', staff, locked)).toBe(true);
      expect(can('UPVOTE', staff, locked)).toBe(true);
      expect(can('SUBMIT', staff, locked)).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && pnpm test -- capability`
Expected: FAIL — cannot find module `../src/access/capability`.

- [ ] **Step 3: Implement the resolver**

`apps/api/src/access/capability.ts`:

```ts
export type Capability = 'VIEW' | 'UPVOTE' | 'SUBMIT' | 'MODERATE';

export type ViewVisibilityValue = 'PUBLIC' | 'ANY_PATREON_USER' | 'SUBSCRIBERS_ONLY';

export interface Viewer {
  isAuthenticated: boolean;
  isActivePatron: boolean;
  /**
   * The pledge behind the viewer's current tier. Compared against the policy gates rather than
   * Tier.order, because design §14 leaves tier ordering unverified while the pledge amount is
   * the value a patron actually commits — `order` is kept for display only.
   */
  tierAmountCents: number | null;
  isStaff: boolean;
}

export interface Policy {
  viewVisibility: ViewVisibilityValue;
  submitMinTierAmountCents: number | null;
  upvoteMinTierAmountCents: number | null;
}

export function can(capability: Capability, viewer: Viewer, policy: Policy): boolean {
  if (capability === 'MODERATE') return viewer.isStaff;

  // Staff bypass the patron gates: a creator's own moderators must be able to work the board
  // they moderate without also pledging to it.
  if (viewer.isStaff) return true;

  switch (capability) {
    case 'VIEW':
      return canView(viewer, policy);
    case 'UPVOTE':
      return meetsPledge(viewer, policy.upvoteMinTierAmountCents);
    case 'SUBMIT':
      return meetsPledge(viewer, policy.submitMinTierAmountCents);
  }
}

function canView(viewer: Viewer, policy: Policy): boolean {
  switch (policy.viewVisibility) {
    case 'PUBLIC':
      return true;
    case 'ANY_PATREON_USER':
      return viewer.isAuthenticated;
    case 'SUBSCRIBERS_ONLY':
      return viewer.isActivePatron;
  }
}

function meetsPledge(viewer: Viewer, minimumCents: number | null): boolean {
  if (!viewer.isActivePatron) return false;
  return (viewer.tierAmountCents ?? 0) >= (minimumCents ?? 0);
}
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/api && pnpm test -- capability`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(api): pure capability resolver for creator access rules"
```

---

## Task 6: `CreatorAccessGuard`

**Files:**

- Create: `apps/api/src/access/creator-access.guard.ts`, `apps/api/src/access/require-capability.decorator.ts`, `apps/api/src/access/access.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/test/creator-access.int-spec.ts`

**Interfaces:**

- Consumes: `PrismaService`, `SessionService`, the resolver from Task 5.
- Produces: `@RequireCapability('VIEW' | 'UPVOTE' | 'SUBMIT' | 'MODERATE')` and `CreatorAccessGuard`, which resolves the creator from a `:slug` or `:creatorId` route parameter, loads the viewer's membership and staff rows, and throws `404` when the creator does not exist, `401` when the capability needs a login the caller lacks, and `403` when they are logged in but not entitled.

- [ ] **Step 1: Write the decorator**

`apps/api/src/access/require-capability.decorator.ts`:

```ts
import { SetMetadata } from '@nestjs/common';
import { Capability } from './capability';

export const REQUIRED_CAPABILITY = 'required-capability';
export const RequireCapability = (capability: Capability) =>
  SetMetadata(REQUIRED_CAPABILITY, capability);
```

- [ ] **Step 2: Write the failing guard test**

`apps/api/test/creator-access.int-spec.ts` — uses the `/creators/:slug` route added in Task 7, so write this test now and expect it to fail on a 404 until that route exists:

```ts
import request from 'supertest';
import { AuthTestContext, pickCookie, startAuthApp } from './support/auth-app';

describe('CreatorAccessGuard (integration)', () => {
  let ctx: AuthTestContext;
  let creatorId: string;

  beforeAll(async () => {
    ctx = await startAuthApp();
    const owner = await ctx.prisma.user.create({ data: { patreonUserId: 'guard-owner' } });
    const creator = await ctx.prisma.creator.create({
      data: {
        patreonCampaignId: 'guard-campaign',
        ownerUserId: owner.id,
        displayName: 'Guarded',
        slug: 'guarded',
        tiers: {
          create: [
            { patreonTierId: 'g-lo', title: 'Bronze', amountCents: 300, order: 0 },
            { patreonTierId: 'g-hi', title: 'Gold', amountCents: 1000, order: 1 },
          ],
        },
        policy: { create: {} },
      },
    });
    creatorId = creator.id;
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
  });

  async function setVisibility(value: 'PUBLIC' | 'ANY_PATREON_USER' | 'SUBSCRIBERS_ONLY') {
    await ctx.prisma.creatorPolicy.update({
      where: { creatorId },
      data: { viewVisibility: value },
    });
  }

  async function loginAs(patreonUserId: string): Promise<string> {
    ctx.patreon.identity = { ...ctx.patreon.identity, patreonUserId, memberships: [] };
    const start = await request(ctx.app.getHttpServer()).get('/auth/patreon/login').expect(302);
    const state = new URL(start.headers.location).searchParams.get('state') as string;
    const res = await request(ctx.app.getHttpServer())
      .get(`/auth/patreon/callback?code=auth-code&state=${state}`)
      .set('Cookie', pickCookie(start, 'pp_oauth_state'))
      .expect(302);
    return pickCookie(res, 'pp_session');
  }

  async function makePatron(patreonUserId: string, amountCents: number) {
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { patreonUserId } });
    const tier = await ctx.prisma.tier.findFirstOrThrow({
      where: { creatorId, amountCents },
    });
    await ctx.prisma.membership.upsert({
      where: { userId_creatorId: { userId: user.id, creatorId } },
      create: {
        userId: user.id,
        creatorId,
        currentTierId: tier.id,
        amountCents,
        isActivePatron: true,
      },
      update: { currentTierId: tier.id, amountCents, isActivePatron: true },
    });
  }

  const get = (cookie?: string) => {
    const req = request(ctx.app.getHttpServer()).get('/api/v1/creators/guarded');
    return cookie ? req.set('Cookie', cookie) : req;
  };

  it('404s for a creator that does not exist', async () => {
    await request(ctx.app.getHttpServer()).get('/api/v1/creators/nope').expect(404);
  });

  it('lets anyone read a PUBLIC creator', async () => {
    await setVisibility('PUBLIC');
    await get().expect(200);
  });

  it('401s an anonymous caller when a login is required', async () => {
    await setVisibility('ANY_PATREON_USER');
    // 401, not 403: the caller can fix this by logging in.
    await get().expect(401);
  });

  it('lets any logged-in user read an ANY_PATREON_USER creator', async () => {
    await setVisibility('ANY_PATREON_USER');
    await get(await loginAs('guard-user-1')).expect(200);
  });

  it('403s a logged-in non-patron when a pledge is required', async () => {
    await setVisibility('SUBSCRIBERS_ONLY');
    // 403, not 401: they are authenticated and still not entitled.
    await get(await loginAs('guard-user-2')).expect(403);
  });

  it('lets an active patron read a SUBSCRIBERS_ONLY creator', async () => {
    await setVisibility('SUBSCRIBERS_ONLY');
    const cookie = await loginAs('guard-user-3');
    await makePatron('guard-user-3', 300);
    await get(cookie).expect(200);
  });

  it('stops honouring a membership once it lapses', async () => {
    await setVisibility('SUBSCRIBERS_ONLY');
    const cookie = await loginAs('guard-user-4');
    await makePatron('guard-user-4', 300);
    await get(cookie).expect(200);

    const user = await ctx.prisma.user.findUniqueOrThrow({
      where: { patreonUserId: 'guard-user-4' },
    });
    await ctx.prisma.membership.update({
      where: { userId_creatorId: { userId: user.id, creatorId } },
      data: { isActivePatron: false },
    });
    await get(cookie).expect(403);
  });

  it('lets staff read a SUBSCRIBERS_ONLY creator without pledging', async () => {
    await setVisibility('SUBSCRIBERS_ONLY');
    const cookie = await loginAs('guard-staff');
    const user = await ctx.prisma.user.findUniqueOrThrow({
      where: { patreonUserId: 'guard-staff' },
    });
    await ctx.prisma.creatorStaff.create({
      data: { creatorId, userId: user.id, role: 'MOD' },
    });
    await get(cookie).expect(200);
  });

  it('does not leak a membership across creators', async () => {
    await setVisibility('SUBSCRIBERS_ONLY');
    const other = await ctx.prisma.user.create({ data: { patreonUserId: 'guard-other-owner' } });
    const otherCreator = await ctx.prisma.creator.create({
      data: {
        patreonCampaignId: 'other-campaign',
        ownerUserId: other.id,
        displayName: 'Other',
        slug: 'other',
        policy: { create: {} },
      },
    });
    const cookie = await loginAs('guard-user-5');
    const user = await ctx.prisma.user.findUniqueOrThrow({
      where: { patreonUserId: 'guard-user-5' },
    });
    // A pledge to a different creator must not unlock this one.
    await ctx.prisma.membership.create({
      data: {
        userId: user.id,
        creatorId: otherCreator.id,
        amountCents: 10_000,
        isActivePatron: true,
      },
    });
    await get(cookie).expect(403);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd apps/api && pnpm test -- creator-access`
Expected: FAIL — 404 everywhere (route and guard do not exist).

- [ ] **Step 4: Implement the guard**

`apps/api/src/access/creator-access.guard.ts`:

```ts
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { SESSION_COOKIE } from '../session/session.cookie';
import { SessionService } from '../session/session.service';
import { Capability, Policy, Viewer, can } from './capability';
import { REQUIRED_CAPABILITY } from './require-capability.decorator';

export interface ResolvedCreator {
  id: string;
  slug: string;
  displayName: string;
}

type CreatorRequest = Request & { creator?: ResolvedCreator; viewer?: Viewer };

@Injectable()
export class CreatorAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const capability = this.reflector.get<Capability>(REQUIRED_CAPABILITY, context.getHandler());
    const request = context.switchToHttp().getRequest<CreatorRequest>();

    const creator = await this.loadCreator(request);
    // 404 before any authorization work: an unauthenticated probe should not be able to tell a
    // private creator from one that does not exist.
    if (!creator) throw new NotFoundException();

    const userId = await this.resolveUser(request);
    const viewer = await this.loadViewer(creator.id, userId);
    const policy: Policy = {
      viewVisibility: creator.policy?.viewVisibility ?? 'PUBLIC',
      submitMinTierAmountCents: creator.policy?.submitMinTier?.amountCents ?? null,
      upvoteMinTierAmountCents: creator.policy?.upvoteMinTier?.amountCents ?? null,
    };

    if (!can(capability, viewer, policy)) {
      // 401 when logging in could fix it, 403 when it could not — so a caller is never told to
      // authenticate for something authentication will not grant.
      throw viewer.isAuthenticated ? new ForbiddenException() : new UnauthorizedException();
    }

    request.creator = { id: creator.id, slug: creator.slug, displayName: creator.displayName };
    request.viewer = viewer;
    return true;
  }

  private async loadCreator(request: CreatorRequest) {
    const { slug, creatorId } = request.params as { slug?: string; creatorId?: string };
    const where = slug ? { slug } : creatorId ? { id: creatorId } : null;
    if (!where) throw new NotFoundException();
    return this.prisma.creator.findUnique({
      where,
      select: {
        id: true,
        slug: true,
        displayName: true,
        policy: {
          select: {
            viewVisibility: true,
            submitMinTier: { select: { amountCents: true } },
            upvoteMinTier: { select: { amountCents: true } },
          },
        },
      },
    });
  }

  private async resolveUser(request: CreatorRequest): Promise<string | null> {
    const token = request.cookies?.[SESSION_COOKIE];
    if (!token) return null;
    return this.sessions.resolve(token);
  }

  private async loadViewer(creatorId: string, userId: string | null): Promise<Viewer> {
    if (!userId) {
      return {
        isAuthenticated: false,
        isActivePatron: false,
        tierAmountCents: null,
        isStaff: false,
      };
    }
    const [membership, staff] = await Promise.all([
      this.prisma.membership.findUnique({
        where: { userId_creatorId: { userId, creatorId } },
        select: { isActivePatron: true, currentTier: { select: { amountCents: true } } },
      }),
      this.prisma.creatorStaff.findUnique({
        where: { creatorId_userId: { creatorId, userId } },
        select: { id: true },
      }),
    ]);
    return {
      isAuthenticated: true,
      isActivePatron: membership?.isActivePatron ?? false,
      tierAmountCents: membership?.currentTier?.amountCents ?? null,
      isStaff: staff !== null,
    };
  }
}

export const CurrentCreator = createParamDecorator(
  (_data: unknown, context: ExecutionContext): ResolvedCreator =>
    context.switchToHttp().getRequest<CreatorRequest>().creator as ResolvedCreator,
);
```

`apps/api/src/access/access.module.ts`:

```ts
import { Global, Module } from '@nestjs/common';
import { CreatorAccessGuard } from './creator-access.guard';

@Global()
@Module({ providers: [CreatorAccessGuard], exports: [CreatorAccessGuard] })
export class AccessModule {}
```

Register `AccessModule` in `AppModule`'s `imports`.

- [ ] **Step 5: Run the tests once Task 7's route exists**

The guard cannot be exercised without a route to guard, so this suite goes green at the end of Task 7. Run it there.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(api): creator access guard resolving membership and staff"
```

---

## Task 7: Creator read and policy endpoints

**Files:**

- Modify: `apps/api/src/creators/creators.controller.ts`, `creators.service.ts`
- Create: `apps/api/src/creators/dto/update-policy.dto.ts`
- Test: `apps/api/test/creator-policy.int-spec.ts`

**Interfaces:**

- Produces: `GET /api/v1/creators/:slug` (`VIEW`) → `{ id, slug, displayName, baseUrl, tiers[] }`; `GET /api/v1/creators/:creatorId/policy` (`MODERATE`); `PATCH /api/v1/creators/:creatorId/policy` (`MODERATE`).

- [ ] **Step 1: Write the policy DTO**

`apps/api/src/creators/dto/update-policy.dto.ts`:

```ts
import { IsBoolean, IsIn, IsOptional, IsUUID } from 'class-validator';
import { ViewVisibilityValue } from '../../access/capability';

const VISIBILITIES: ViewVisibilityValue[] = ['PUBLIC', 'ANY_PATREON_USER', 'SUBSCRIBERS_ONLY'];

export class UpdatePolicyDto {
  @IsOptional()
  @IsIn(VISIBILITIES)
  viewVisibility?: ViewVisibilityValue;

  // Nullable on purpose: null clears the gate, which is different from omitting the field.
  @IsOptional()
  @IsUUID()
  submitMinTierId?: string | null;

  @IsOptional()
  @IsUUID()
  upvoteMinTierId?: string | null;

  @IsOptional()
  @IsBoolean()
  hidePendingFromPublic?: boolean;
}
```

- [ ] **Step 2: Write the failing test**

`apps/api/test/creator-policy.int-spec.ts`:

```ts
import request from 'supertest';
import { AuthTestContext, pickCookie, startAuthApp } from './support/auth-app';

describe('Creator read and policy endpoints (integration)', () => {
  let ctx: AuthTestContext;
  let creatorId: string;
  let tierIds: { lo: string; hi: string };

  beforeAll(async () => {
    ctx = await startAuthApp();
    const owner = await ctx.prisma.user.create({ data: { patreonUserId: 'policy-owner' } });
    const creator = await ctx.prisma.creator.create({
      data: {
        patreonCampaignId: 'policy-campaign',
        ownerUserId: owner.id,
        displayName: 'Policy Co',
        slug: 'policy-co',
        baseUrl: 'https://policy.example.com',
        tiers: {
          create: [
            { patreonTierId: 'p-lo', title: 'Bronze', amountCents: 300, order: 0 },
            { patreonTierId: 'p-hi', title: 'Gold', amountCents: 1000, order: 1 },
          ],
        },
        policy: { create: {} },
      },
      include: { tiers: true },
    });
    creatorId = creator.id;
    tierIds = {
      lo: creator.tiers.find((t) => t.amountCents === 300)!.id,
      hi: creator.tiers.find((t) => t.amountCents === 1000)!.id,
    };
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
  });

  async function loginAs(patreonUserId: string) {
    ctx.patreon.identity = { ...ctx.patreon.identity, patreonUserId, memberships: [] };
    const start = await request(ctx.app.getHttpServer()).get('/auth/patreon/login').expect(302);
    const state = new URL(start.headers.location).searchParams.get('state') as string;
    const res = await request(ctx.app.getHttpServer())
      .get(`/auth/patreon/callback?code=auth-code&state=${state}`)
      .set('Cookie', pickCookie(start, 'pp_oauth_state'))
      .expect(302);
    const csrf = pickCookie(res, 'pp_csrf').split(';')[0];
    return {
      session: pickCookie(res, 'pp_session'),
      csrf,
      csrfToken: csrf.split('=').slice(1).join('='),
    };
  }

  async function makeStaff(patreonUserId: string) {
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { patreonUserId } });
    await ctx.prisma.creatorStaff.upsert({
      where: { creatorId_userId: { creatorId, userId: user.id } },
      create: { creatorId, userId: user.id, role: 'OWNER' },
      update: {},
    });
  }

  it('exposes the public creator profile without a login', async () => {
    const res = await request(ctx.app.getHttpServer())
      .get('/api/v1/creators/policy-co')
      .expect(200);
    expect(res.body).toEqual({
      id: creatorId,
      slug: 'policy-co',
      displayName: 'Policy Co',
      baseUrl: 'https://policy.example.com',
      tiers: [
        { id: tierIds.lo, title: 'Bronze', amountCents: 300, order: 0 },
        { id: tierIds.hi, title: 'Gold', amountCents: 1000, order: 1 },
      ],
    });
  });

  it('never exposes the owner or internal ids on the public profile', async () => {
    const res = await request(ctx.app.getHttpServer()).get('/api/v1/creators/policy-co');
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('ownerUserId');
    expect(body).not.toContain('patreonCampaignId');
  });

  it('refuses policy reads to a non-staff user', async () => {
    const auth = await loginAs('policy-stranger');
    await request(ctx.app.getHttpServer())
      .get(`/api/v1/creators/${creatorId}/policy`)
      .set('Cookie', auth.session)
      .expect(403);
  });

  it('lets staff read the policy', async () => {
    const auth = await loginAs('policy-staff');
    await makeStaff('policy-staff');
    const res = await request(ctx.app.getHttpServer())
      .get(`/api/v1/creators/${creatorId}/policy`)
      .set('Cookie', auth.session)
      .expect(200);
    expect(res.body.viewVisibility).toBe('PUBLIC');
  });

  it('lets staff update the policy', async () => {
    const auth = await loginAs('policy-staff-2');
    await makeStaff('policy-staff-2');
    const res = await request(ctx.app.getHttpServer())
      .patch(`/api/v1/creators/${creatorId}/policy`)
      .set('Cookie', [auth.session, auth.csrf])
      .set('x-csrf-token', auth.csrfToken)
      .send({ viewVisibility: 'SUBSCRIBERS_ONLY', submitMinTierId: tierIds.hi })
      .expect(200);
    expect(res.body.viewVisibility).toBe('SUBSCRIBERS_ONLY');
    expect(res.body.submitMinTierId).toBe(tierIds.hi);
  });

  it('rejects a policy update without a csrf token', async () => {
    const auth = await loginAs('policy-staff-3');
    await makeStaff('policy-staff-3');
    await request(ctx.app.getHttpServer())
      .patch(`/api/v1/creators/${creatorId}/policy`)
      .set('Cookie', auth.session)
      .send({ viewVisibility: 'PUBLIC' })
      .expect(403);
  });

  it('refuses a tier belonging to another creator', async () => {
    const auth = await loginAs('policy-staff-4');
    await makeStaff('policy-staff-4');
    const stranger = await ctx.prisma.user.create({ data: { patreonUserId: 'tier-thief' } });
    const otherCreator = await ctx.prisma.creator.create({
      data: {
        patreonCampaignId: 'thief-campaign',
        ownerUserId: stranger.id,
        displayName: 'Thief',
        slug: 'thief',
        tiers: { create: [{ patreonTierId: 't-1', title: 'T', amountCents: 100, order: 0 }] },
      },
      include: { tiers: true },
    });
    // Otherwise a creator could gate their board on a tier nobody can ever hold.
    await request(ctx.app.getHttpServer())
      .patch(`/api/v1/creators/${creatorId}/policy`)
      .set('Cookie', [auth.session, auth.csrf])
      .set('x-csrf-token', auth.csrfToken)
      .send({ submitMinTierId: otherCreator.tiers[0].id })
      .expect(400);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd apps/api && pnpm test -- creator-policy`
Expected: FAIL — 404 on every route.

- [ ] **Step 4: Add the service methods**

Add to `apps/api/src/creators/creators.service.ts`:

```ts
  async publicProfile(creatorId: string) {
    const creator = await this.prisma.creator.findUniqueOrThrow({
      where: { id: creatorId },
      // Explicit select: ownerUserId and patreonCampaignId are internal and must not be
      // serialized into a public response.
      select: {
        id: true,
        slug: true,
        displayName: true,
        baseUrl: true,
        tiers: {
          select: { id: true, title: true, amountCents: true, order: true },
          orderBy: { amountCents: 'asc' },
        },
      },
    });
    return creator;
  }

  async getPolicy(creatorId: string) {
    return this.prisma.creatorPolicy.findUniqueOrThrow({
      where: { creatorId },
      select: {
        viewVisibility: true,
        submitMinTierId: true,
        upvoteMinTierId: true,
        hidePendingFromPublic: true,
      },
    });
  }

  async updatePolicy(creatorId: string, dto: UpdatePolicyDto) {
    for (const tierId of [dto.submitMinTierId, dto.upvoteMinTierId]) {
      if (!tierId) continue;
      const tier = await this.prisma.tier.findFirst({ where: { id: tierId, creatorId } });
      // A tier from another creator would gate this board on something nobody can hold.
      if (!tier) throw new BadRequestException('Tier does not belong to this creator');
    }
    return this.prisma.creatorPolicy.update({
      where: { creatorId },
      data: dto,
      select: {
        viewVisibility: true,
        submitMinTierId: true,
        upvoteMinTierId: true,
        hidePendingFromPublic: true,
      },
    });
  }
```

Import `BadRequestException` and `UpdatePolicyDto`.

- [ ] **Step 5: Add the routes**

Add to `apps/api/src/creators/creators.controller.ts`:

```ts
  @Get(':slug')
  @RequireCapability('VIEW')
  @UseGuards(CreatorAccessGuard)
  profile(@CurrentCreator() creator: ResolvedCreator) {
    return this.creators.publicProfile(creator.id);
  }

  @Get(':creatorId/policy')
  @RequireCapability('MODERATE')
  @UseGuards(CreatorAccessGuard)
  policy(@CurrentCreator() creator: ResolvedCreator) {
    return this.creators.getPolicy(creator.id);
  }

  @Patch(':creatorId/policy')
  @RequireCapability('MODERATE')
  @UseGuards(CreatorAccessGuard)
  updatePolicy(@CurrentCreator() creator: ResolvedCreator, @Body() dto: UpdatePolicyDto) {
    return this.creators.updatePolicy(creator.id, dto);
  }
```

Import `Get`, `Patch`, `RequireCapability`, `CreatorAccessGuard`, `CurrentCreator`, `ResolvedCreator` and `UpdatePolicyDto`.

`@Post('claim')` is declared before `@Get(':slug')` in the file, so `claim` is matched as a literal before the parameterised route can swallow it.

- [ ] **Step 6: Run both suites**

Run: `cd apps/api && pnpm test -- "creator-policy|creator-access"`
Expected: PASS (8 + 9 tests). Task 6's guard suite goes green here.

- [ ] **Step 7: Full verification**

```bash
pnpm -r typecheck && pnpm -r test && pnpm format:check
docker build -f apps/api/Dockerfile -t patreonplanner-api .
```

Expected: all green; image builds.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(api): creator profile and policy endpoints behind the access guard"
```

---

## Self-Review

**Spec coverage (design §3 data model, §4 claiming + access enforcement, §7 creator admin policy, §8 API surface):**

- `CreatorStaff`, `CreatorPolicy` models → Task 1. ✅
- Creator claiming with ownership verified against the Patreon API → Task 4 (a campaign absent from `fetchOwnedCampaigns` cannot be claimed). ✅
- Imports `Tier`s, sets `OWNER` in `CreatorStaff`, registers base URL → Task 4. ✅
- `CreatorAccessGuard` resolving `Membership` + `CreatorPolicy` per creator-scoped request → Task 6. ✅
- Capability table (View / Upvote / Submit / Moderate) → Task 5, one test per row plus the staff bypass. ✅
- All tier/role checks server-side → Tasks 5-6; nothing is exposed that lets a client assert its own capability. ✅
- `POST /creators/claim`, `GET /creators/:slug`, `GET|PATCH /creators/:id/policy` → Tasks 4, 7. ✅
- Rate-limit overrides, profanity blocklist, `hidePendingFromPublic` behaviour, staff CRUD, themes → **deferred** (stated in Scope); `hidePendingFromPublic` is stored but nothing reads it until Plan 05 has pending items to hide. ✅
- Webhooks → Plan 04. ✅

**Placeholder scan:** no TBD/TODO; every code step is compilable content. Task 6 Step 5 defers its test run to Task 7 Step 6 rather than leaving a placeholder — the suite is fully written in Task 6.

**Type consistency:** `Capability`, `Viewer` and `Policy` are defined in Task 5 and consumed unchanged in Tasks 6 and 7. `ViewVisibilityValue` is declared once in `capability.ts` and reused by the DTO in Task 7 rather than redeclared. `PatreonCampaign`/`PatreonTier` are defined in Task 3 and consumed by Task 4's `tiers: { create: campaign.tiers }` — the field names (`patreonTierId`, `title`, `amountCents`, `order`) match the `Tier` model from Plan 02 exactly, which is what makes that nested create legal. `PatreonTokenService.getAccessToken` is defined in Task 2 and called in Task 4. `CurrentCreator`/`ResolvedCreator` are defined in Task 6 and used in Task 7. `pickCookie` and `startAuthApp` come from Plan 02's `test/support/auth-app.ts`. ✅

**Known risks carried into implementation:**

1. **The `campaigns` scope changes the consent screen.** Anyone holding a session from before Task 2 has a token without it, so their claim will fail the ownership check for a reason the error cannot state precisely without leaking. Mitigation: Task 4 returns `502` for an upstream failure and `403` only for genuine non-ownership; the SPA should tell a failing claimer to log in again.
2. **Concurrent refresh.** Two requests refreshing the same user's token at once will both call Patreon, and Patreon may invalidate the first refresh token. A Redis lock around `PatreonTokenService.getAccessToken` is the fix if this shows up; not worth the complexity until claiming is not the only caller.
3. **The guard costs two queries per creator-scoped request** (membership + staff) on top of the session lookup. Fine at this scale, and the FK indexes from the Plan 02 review cover both lookups, but it is the first thing to cache when the board endpoints arrive in Plan 05.
