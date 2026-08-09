# Patreon Webhooks & Membership Freshness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep `Membership` accurate between logins, so the access guard from Plan 03 gates on current patron status rather than whatever was true when the user last signed in.

**Architecture:** Design §4 names two paths. The **primary** is Patreon webhooks: `POST /webhooks/patreon` verifies an HMAC signature, then applies `members:pledge:create/update/delete` to the matching `Membership`. The **fallback** is a BullMQ repeatable job that re-syncs memberships whose `lastSyncedAt` has aged past a TTL, covering webhooks that were missed, dropped, or never configured. Both paths funnel through one `MembershipSyncService`, extracted from the login flow so all three callers apply identical rules.

**Tech Stack:** NestJS 10, BullMQ on the existing Redis, Prisma, Node `crypto` for signature verification, Jest + supertest + Testcontainers.

## Global Constraints

Carried forward from design §9.

- **Constant-time comparison for webhook signatures** — §9 names this explicitly.
- **Input validation:** `class-validator` DTOs on every endpoint.
- **Generic errors:** no stack traces, no secrets, nothing that lets a caller probe which check failed.
- **Secrets never logged.** The webhook secret and Patreon tokens never reach a log line.
- **SQL injection:** Prisma parameterizes; no string-built SQL.
- **All authorization stays server-side.**

## Scope

**In scope:** webhook signature verification, `POST /webhooks/patreon`, membership updates from pledge events, a shared `MembershipSyncService`, a BullMQ queue with a repeatable stale-membership re-sync job, and tier re-sync for claimed creators.

**Out of scope — deliberately deferred:**

- **Recommendations, upvotes, the board, moderation, abuse limiting** (design §5–§7) → Plan 05+.
- **Staff invite/remove** → Plan 06.
- **Other BullMQ jobs** design §8 lists (availability refresh, embedding computation, abuse-score decay) → the plans that own those features. This plan builds the queue infrastructure they will reuse, and exactly one job.
- **A separate worker process.** The job runs in the API process for now; splitting it out is a deployment change, not a code change, and there is nothing yet to justify the second image.

## Prerequisites

Plans 01–03 merged. In particular `PatreonTokenService` (refresh-on-demand), `PatreonClient.fetchIdentity` / `fetchOwnedCampaigns`, `Membership`, and `CreatorAccessGuard`, which is the consumer that makes this freshness matter.

**No Patreon credentials are required.** Signature tests compute HMACs directly; sync tests use `FakePatreonClient`.

## Decisions this plan settles

**Patreon signs with HMAC-MD5.** Their documented scheme is `X-Patreon-Signature: <hex md5 hmac of the raw request body, keyed with the webhook secret>`. MD5 is a poor choice and it is not ours to change; what *is* ours is to compare in constant time and to verify against the **raw** body rather than a re-serialized one. Note the risk explicitly rather than silently implementing a weak scheme: an attacker who learns the secret can forge events, so the secret is the whole of the security here.

**The webhook is exempt from CSRF, and must be.** It is an unauthenticated-by-cookie POST from Patreon's servers, which cannot carry our double-submit token. The signature replaces CSRF for this route. The exemption is explicit and tested, because a blanket `forRoutes('*')` would otherwise reject every event with a 403 that looks like Patreon's fault.

**Replays are tolerated rather than deduplicated.** Every handler converges on an absolute state — `create`/`update` upsert to the payload's values, `delete` marks inactive — so applying the same event twice is indistinguishable from applying it once. Patreon sends no event id to deduplicate on, so a dedupe store would key on a synthetic hash and add a failure mode without removing one.

**Tier re-sync never deletes.** Plan 03 made `CreatorPolicy`'s gate tiers `onDelete: Restrict` precisely so a re-sync could not silently widen a gate. Rather than teach the job to resolve that, it upserts only. A tier removed on Patreon lingers locally, which is visible in the UI and harmless to gates — the alternative is a job that fails, or one that quietly changes who may submit.

---

## Task 1: Extract `MembershipSyncService`

**Files:**

- Create: `apps/api/src/memberships/membership-sync.service.ts`, `apps/api/src/memberships/memberships.module.ts`
- Modify: `apps/api/src/auth/auth.service.ts` (delegate to it), `apps/api/src/app.module.ts`
- Test: `apps/api/test/membership-sync.int-spec.ts`

**Interfaces:**

- Consumes: `PrismaService`.
- Produces: `MembershipSyncService.applyIdentity(userId: string, memberships: PatreonMembership[]): Promise<void>` — the full reconciliation currently inside `AuthService.syncMemberships`, including deactivating memberships absent from the payload. `MembershipsModule` is `@Global()` and exports it.

Three callers will need identical rules: login (Plan 02), the webhook, and the background job. Leaving the logic private to `AuthService` guarantees they drift.

- [ ] **Step 1: Write the failing test**

`apps/api/test/membership-sync.int-spec.ts`:

```ts
import { MembershipSyncService } from '../src/memberships/membership-sync.service';
import { AuthTestContext, startAuthApp } from './support/auth-app';

describe('MembershipSyncService (integration)', () => {
  let ctx: AuthTestContext;
  let sync: MembershipSyncService;
  let creatorId: string;
  let tierId: string;
  let userId: string;

  beforeAll(async () => {
    ctx = await startAuthApp();
    sync = ctx.app.get(MembershipSyncService);

    const owner = await ctx.prisma.user.create({ data: { patreonUserId: 'sync-owner' } });
    const creator = await ctx.prisma.creator.create({
      data: {
        patreonCampaignId: 'sync-campaign',
        ownerUserId: owner.id,
        displayName: 'Sync Co',
        slug: 'sync-co',
        tiers: {
          create: [{ patreonTierId: 's-tier', title: 'Gold', amountCents: 1000, order: 0 }],
        },
        policy: { create: {} },
      },
      include: { tiers: true },
    });
    creatorId = creator.id;
    tierId = creator.tiers[0].id;
    const user = await ctx.prisma.user.create({ data: { patreonUserId: 'sync-user' } });
    userId = user.id;
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
  });

  it('creates a membership for a claimed campaign', async () => {
    await sync.applyIdentity(userId, [
      {
        campaignId: 'sync-campaign',
        patreonTierIds: ['s-tier'],
        amountCents: 1000,
        isActivePatron: true,
      },
    ]);
    const membership = await ctx.prisma.membership.findUniqueOrThrow({
      where: { userId_creatorId: { userId, creatorId } },
    });
    expect(membership.isActivePatron).toBe(true);
    expect(membership.amountCents).toBe(1000);
    expect(membership.currentTierId).toBe(tierId);
  });

  it('skips a campaign nobody has claimed', async () => {
    await sync.applyIdentity(userId, [
      {
        campaignId: 'unclaimed-campaign',
        patreonTierIds: [],
        amountCents: 500,
        isActivePatron: true,
      },
    ]);
    expect(await ctx.prisma.membership.count({ where: { userId } })).toBe(1);
  });

  it('deactivates a membership absent from the payload', async () => {
    await sync.applyIdentity(userId, []);
    const membership = await ctx.prisma.membership.findUniqueOrThrow({
      where: { userId_creatorId: { userId, creatorId } },
    });
    expect(membership.isActivePatron).toBe(false);
    expect(membership.currentTierId).toBeNull();
  });

  it('advances lastSyncedAt even when nothing changed', async () => {
    const before = await ctx.prisma.membership.findUniqueOrThrow({
      where: { userId_creatorId: { userId, creatorId } },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await sync.applyIdentity(userId, []);
    const after = await ctx.prisma.membership.findUniqueOrThrow({
      where: { userId_creatorId: { userId, creatorId } },
    });
    // The staleness job selects on this column; leaving it behind would re-sync forever.
    expect(after.lastSyncedAt.getTime()).toBeGreaterThan(before.lastSyncedAt.getTime());
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && pnpm test -- membership-sync`
Expected: FAIL — cannot find module `../src/memberships/membership-sync.service`.

- [ ] **Step 3: Create the service by moving the logic out of `AuthService`**

`apps/api/src/memberships/membership-sync.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { PatreonMembership } from '../patreon/patreon.types';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class MembershipSyncService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Reconciles a user's memberships against Patreon's current view. Shared by login, the
   * webhook and the staleness job, so all three grant and revoke by identical rules.
   */
  async applyIdentity(userId: string, memberships: PatreonMembership[]): Promise<void> {
    const syncedCreatorIds: string[] = [];

    for (const membership of memberships) {
      const creator = await this.prisma.creator.findUnique({
        where: { patreonCampaignId: membership.campaignId },
        select: { id: true },
      });
      // Only a claimed campaign can carry a Membership; an unclaimed one has no tenant to
      // attach to and is skipped rather than half-created.
      if (!creator) continue;

      const patreonTierId = membership.patreonTierIds[0];
      const tier = patreonTierId
        ? await this.prisma.tier.findUnique({
            where: { creatorId_patreonTierId: { creatorId: creator.id, patreonTierId } },
            select: { id: true },
          })
        : null;

      const state = {
        currentTierId: tier?.id ?? null,
        amountCents: membership.amountCents,
        isActivePatron: membership.isActivePatron,
        lastSyncedAt: new Date(),
      };
      await this.prisma.membership.upsert({
        where: { userId_creatorId: { userId, creatorId: creator.id } },
        create: { userId, creatorId: creator.id, ...state },
        update: state,
      });
      syncedCreatorIds.push(creator.id);
    }

    // Patreon reports current memberships only, so a lapsed one simply stops appearing. Without
    // this the sync could grant access but never revoke it.
    await this.prisma.membership.updateMany({
      where: { userId, creatorId: { notIn: syncedCreatorIds } },
      data: { isActivePatron: false, currentTierId: null, lastSyncedAt: new Date() },
    });
  }
}
```

`apps/api/src/memberships/memberships.module.ts`:

```ts
import { Global, Module } from '@nestjs/common';
import { MembershipSyncService } from './membership-sync.service';

@Global()
@Module({ providers: [MembershipSyncService], exports: [MembershipSyncService] })
export class MembershipsModule {}
```

- [ ] **Step 4: Delegate from `AuthService`**

In `apps/api/src/auth/auth.service.ts`, delete the private `syncMemberships` method entirely, inject `MembershipSyncService`, and replace the call site:

```ts
    await this.memberships.applyIdentity(user.id, identity.memberships);
```

Register `MembershipsModule` in `AppModule` before `AuthModule`.

- [ ] **Step 5: Run the tests**

Run: `cd apps/api && pnpm test -- "membership-sync|auth-flow"`
Expected: PASS. The existing `auth-flow` membership tests must still pass unchanged — that is the proof the extraction preserved behaviour.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(api): extract MembershipSyncService shared by every sync path"
```

---

## Task 2: Webhook signature verification

**Files:**

- Modify: `apps/api/src/config/config.schema.ts`, `.env.example`, `.github/workflows/ci.yml`
- Create: `apps/api/src/webhooks/webhook-signature.service.ts`
- Test: `apps/api/test/webhook-signature.e2e-spec.ts`

**Interfaces:**

- Consumes: `ConfigService`.
- Produces: `WebhookSignatureService.verify(rawBody: Buffer, signature: string | undefined): boolean`. New config key `PATREON_WEBHOOK_SECRET`.

- [ ] **Step 1: Add the config key**

In `apps/api/src/config/config.schema.ts`, alongside the other Patreon values:

```ts
  PATREON_WEBHOOK_SECRET: z.string().min(1),
```

Add `PATREON_WEBHOOK_SECRET=replace-me` to `.env.example` and your local `.env`, add `PATREON_WEBHOOK_SECRET: test-webhook-secret` to the `env:` block in `.github/workflows/ci.yml`, and add it to `apps/api/test/support/env.ts`'s defaults so existing suites keep booting.

- [ ] **Step 2: Write the failing test**

`apps/api/test/webhook-signature.e2e-spec.ts`:

```ts
import { createHmac } from 'node:crypto';
import { ConfigService } from '../src/config/config.module';
import { WebhookSignatureService } from '../src/webhooks/webhook-signature.service';
import { applyTestConfigDefaults } from './support/env';

describe('WebhookSignatureService', () => {
  const secret = 'test-webhook-secret';
  let service: WebhookSignatureService;

  beforeAll(() => {
    process.env.DATABASE_URL = 'postgresql://planner:planner@localhost:5432/planner';
    process.env.REDIS_URL = 'redis://localhost:6379';
    applyTestConfigDefaults();
    process.env.PATREON_WEBHOOK_SECRET = secret;
    service = new WebhookSignatureService(new ConfigService());
  });

  const sign = (body: Buffer) => createHmac('md5', secret).update(body).digest('hex');

  it('accepts a correctly signed body', () => {
    const body = Buffer.from('{"data":{"id":"1"}}');
    expect(service.verify(body, sign(body))).toBe(true);
  });

  it('rejects a body that was altered after signing', () => {
    const body = Buffer.from('{"data":{"id":"1"}}');
    const signature = sign(body);
    expect(service.verify(Buffer.from('{"data":{"id":"2"}}'), signature)).toBe(false);
  });

  it('rejects a missing signature', () => {
    expect(service.verify(Buffer.from('{}'), undefined)).toBe(false);
  });

  it('rejects a signature of the wrong length without throwing', () => {
    // timingSafeEqual throws on a length mismatch, so this must be guarded.
    expect(service.verify(Buffer.from('{}'), 'abc')).toBe(false);
  });

  it('rejects a signature that is not hex', () => {
    expect(service.verify(Buffer.from('{}'), 'z'.repeat(32))).toBe(false);
  });

  it('is sensitive to whitespace, so a re-serialized body cannot pass', () => {
    const body = Buffer.from('{"a":1}');
    expect(service.verify(Buffer.from('{ "a": 1 }'), sign(body))).toBe(false);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd apps/api && pnpm test -- webhook-signature`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement it**

`apps/api/src/webhooks/webhook-signature.service.ts`:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '../config/config.module';

// Patreon's documented scheme. MD5 is theirs, not ours: an attacker who learns the secret can
// forge events, so the secret is the whole of the security here. What we control is comparing
// in constant time and verifying the raw bytes rather than a re-serialized body.
const ALGORITHM = 'md5';
const SIGNATURE_LENGTH = 32;

@Injectable()
export class WebhookSignatureService {
  constructor(private readonly config: ConfigService) {}

  verify(rawBody: Buffer, signature: string | undefined): boolean {
    if (!signature || signature.length !== SIGNATURE_LENGTH) return false;
    const expected = createHmac(ALGORITHM, this.config.get('PATREON_WEBHOOK_SECRET'))
      .update(rawBody)
      .digest('hex');
    // Both are fixed-length hex here, but compare defensively — a non-hex signature of the
    // right length would otherwise reach timingSafeEqual with a shorter decoded buffer.
    const provided = Buffer.from(signature, 'utf8');
    const computed = Buffer.from(expected, 'utf8');
    return provided.length === computed.length && timingSafeEqual(provided, computed);
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `cd apps/api && pnpm test -- webhook-signature`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(api): constant-time patreon webhook signature verification"
```

---

## Task 3: The webhook endpoint

**Files:**

- Create: `apps/api/src/webhooks/webhooks.controller.ts`, `webhooks.service.ts`, `webhooks.module.ts`
- Modify: `apps/api/src/app.setup.ts` (prefix exclusion), `apps/api/src/app.module.ts` (CSRF exclusion), `apps/api/src/main.ts` and `test/support/auth-app.ts` (raw body)
- Test: `apps/api/test/webhook.int-spec.ts`

**Interfaces:**

- Consumes: `WebhookSignatureService`, `MembershipSyncService`, `PrismaService`.
- Produces: `POST /webhooks/patreon` → `204` on an accepted event, `401` on a bad signature, `204` on an event type or campaign we do not track (accepting silently, so Patreon does not retry forever).

- [ ] **Step 1: Enable raw body capture**

In `apps/api/src/main.ts`:

```ts
  const app = await NestFactory.create(AppModule, { rawBody: true });
```

In `apps/api/test/support/auth-app.ts`:

```ts
  const app = moduleRef.createNestApplication({ rawBody: true });
```

Without the raw bytes the signature can only be checked against a re-serialized body, which will not match — key ordering and whitespace both differ.

- [ ] **Step 2: Exclude the webhook from CSRF and the API prefix**

In `apps/api/src/app.module.ts`:

```ts
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(CsrfMiddleware)
      // Patreon cannot carry our double-submit token; the HMAC signature is what authenticates
      // this route. Without the exclusion every event would be rejected 403.
      .exclude({ path: 'webhooks/(.*)', method: RequestMethod.ALL })
      .forRoutes('*');
  }
```

In `apps/api/src/app.setup.ts`, add `'webhooks/patreon'` to the `setGlobalPrefix` exclusion list — design §8 places it at the root.

- [ ] **Step 3: Write the failing test**

`apps/api/test/webhook.int-spec.ts`:

```ts
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { AuthTestContext, startAuthApp } from './support/auth-app';

describe('POST /webhooks/patreon (integration)', () => {
  let ctx: AuthTestContext;
  let creatorId: string;
  let tierId: string;
  let userId: string;

  beforeAll(async () => {
    ctx = await startAuthApp();
    const owner = await ctx.prisma.user.create({ data: { patreonUserId: 'hook-owner' } });
    const creator = await ctx.prisma.creator.create({
      data: {
        patreonCampaignId: 'hook-campaign',
        ownerUserId: owner.id,
        displayName: 'Hook Co',
        slug: 'hook-co',
        tiers: {
          create: [{ patreonTierId: 'h-tier', title: 'Gold', amountCents: 1000, order: 0 }],
        },
        policy: { create: {} },
      },
      include: { tiers: true },
    });
    creatorId = creator.id;
    tierId = creator.tiers[0].id;
    const patron = await ctx.prisma.user.create({ data: { patreonUserId: 'hook-patron' } });
    userId = patron.id;
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
  });

  function event(trigger: string, body: object) {
    const raw = JSON.stringify(body);
    const signature = createHmac('md5', process.env.PATREON_WEBHOOK_SECRET as string)
      .update(Buffer.from(raw))
      .digest('hex');
    return request(ctx.app.getHttpServer())
      .post('/webhooks/patreon')
      .set('X-Patreon-Event', trigger)
      .set('X-Patreon-Signature', signature)
      .set('Content-Type', 'application/json')
      .send(raw);
  }

  const pledge = (opts: { status: string; cents: number; tiers?: string[] }) => ({
    data: {
      attributes: {
        patron_status: opts.status,
        currently_entitled_amount_cents: opts.cents,
      },
      relationships: {
        user: { data: { id: 'hook-patron' } },
        campaign: { data: { id: 'hook-campaign' } },
        currently_entitled_tiers: { data: (opts.tiers ?? []).map((id) => ({ id })) },
      },
    },
  });

  it('rejects an unsigned request', async () => {
    await request(ctx.app.getHttpServer())
      .post('/webhooks/patreon')
      .set('X-Patreon-Event', 'members:pledge:create')
      .send(pledge({ status: 'active_patron', cents: 1000 }))
      .expect(401);
  });

  it('rejects a request signed with the wrong secret', async () => {
    const raw = JSON.stringify(pledge({ status: 'active_patron', cents: 1000 }));
    const signature = createHmac('md5', 'not-the-secret').update(Buffer.from(raw)).digest('hex');
    await request(ctx.app.getHttpServer())
      .post('/webhooks/patreon')
      .set('X-Patreon-Event', 'members:pledge:create')
      .set('X-Patreon-Signature', signature)
      .set('Content-Type', 'application/json')
      .send(raw)
      .expect(401);
  });

  it('is exempt from CSRF, which would otherwise 403 every event', async () => {
    // No pp_csrf cookie and no x-csrf-token header anywhere in this suite.
    await event('members:pledge:create', pledge({ status: 'active_patron', cents: 1000 }))
      .expect(204);
  });

  it('creates a membership from a pledge:create', async () => {
    await event('members:pledge:create', {
      ...pledge({ status: 'active_patron', cents: 1000, tiers: ['h-tier'] }),
    }).expect(204);

    const membership = await ctx.prisma.membership.findUniqueOrThrow({
      where: { userId_creatorId: { userId, creatorId } },
    });
    expect(membership.isActivePatron).toBe(true);
    expect(membership.amountCents).toBe(1000);
    expect(membership.currentTierId).toBe(tierId);
  });

  it('applies a pledge:update', async () => {
    await event('members:pledge:update', pledge({ status: 'active_patron', cents: 2500 })).expect(
      204,
    );
    const membership = await ctx.prisma.membership.findUniqueOrThrow({
      where: { userId_creatorId: { userId, creatorId } },
    });
    expect(membership.amountCents).toBe(2500);
  });

  it('deactivates on a pledge:delete', async () => {
    await event('members:pledge:delete', pledge({ status: 'former_patron', cents: 0 })).expect(204);
    const membership = await ctx.prisma.membership.findUniqueOrThrow({
      where: { userId_creatorId: { userId, creatorId } },
    });
    expect(membership.isActivePatron).toBe(false);
    expect(membership.currentTierId).toBeNull();
  });

  it('is idempotent under a replayed event', async () => {
    const send = () =>
      event('members:pledge:update', pledge({ status: 'active_patron', cents: 700 }));
    await send().expect(204);
    await send().expect(204);
    const memberships = await ctx.prisma.membership.findMany({ where: { userId, creatorId } });
    expect(memberships).toHaveLength(1);
    expect(memberships[0].amountCents).toBe(700);
  });

  it('accepts an event for an unclaimed campaign without creating anything', async () => {
    const before = await ctx.prisma.membership.count();
    await event('members:pledge:create', {
      data: {
        attributes: { patron_status: 'active_patron', currently_entitled_amount_cents: 100 },
        relationships: {
          user: { data: { id: 'hook-patron' } },
          campaign: { data: { id: 'nobody-claimed-this' } },
          currently_entitled_tiers: { data: [] },
        },
      },
      // 204 rather than 404: Patreon retries failures, and this will never start succeeding.
    }).expect(204);
    expect(await ctx.prisma.membership.count()).toBe(before);
  });

  it('accepts an event for a user we have never seen', async () => {
    await event('members:pledge:create', {
      data: {
        attributes: { patron_status: 'active_patron', currently_entitled_amount_cents: 100 },
        relationships: {
          user: { data: { id: 'never-logged-in' } },
          campaign: { data: { id: 'hook-campaign' } },
          currently_entitled_tiers: { data: [] },
        },
      },
    }).expect(204);
    // Nothing to attach to until they log in; login re-sync will pick it up.
    expect(
      await ctx.prisma.user.count({ where: { patreonUserId: 'never-logged-in' } }),
    ).toBe(0);
  });

  it('ignores an event type it does not handle', async () => {
    await event('posts:publish', { data: { id: 'post-1' } }).expect(204);
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `cd apps/api && pnpm test -- webhook.int`
Expected: FAIL — 404 on `/webhooks/patreon`.

- [ ] **Step 5: Implement the service**

`apps/api/src/webhooks/webhooks.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { MembershipSyncService } from '../memberships/membership-sync.service';
import { PrismaService } from '../prisma/prisma.service';

interface PledgePayload {
  data?: {
    attributes?: { patron_status?: string; currently_entitled_amount_cents?: number };
    relationships?: {
      user?: { data?: { id?: string } };
      campaign?: { data?: { id?: string } };
      currently_entitled_tiers?: { data?: Array<{ id: string }> };
    };
  };
}

const HANDLED = new Set([
  'members:pledge:create',
  'members:pledge:update',
  'members:pledge:delete',
]);

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly memberships: MembershipSyncService,
    private readonly prisma: PrismaService,
  ) {}

  async handle(trigger: string | undefined, payload: PledgePayload): Promise<void> {
    if (!trigger || !HANDLED.has(trigger)) return;

    const patreonUserId = payload.data?.relationships?.user?.data?.id;
    const campaignId = payload.data?.relationships?.campaign?.data?.id;
    if (!patreonUserId || !campaignId) {
      this.logger.warn(`Discarding ${trigger} with no user or campaign reference`);
      return;
    }

    const user = await this.prisma.user.findUnique({
      where: { patreonUserId },
      select: { id: true },
    });
    // A patron who has never logged in has no User row to attach to. Login re-sync will pick
    // them up; inventing a shell user here would create an account nobody can sign into.
    if (!user) return;

    const isDelete = trigger === 'members:pledge:delete';
    const attributes = payload.data?.attributes;

    // applyIdentity reconciles against the full picture, so passing an empty list for a delete
    // deactivates exactly the memberships that are gone.
    await this.memberships.applyIdentity(
      user.id,
      isDelete
        ? []
        : [
            {
              campaignId,
              patreonTierIds: (
                payload.data?.relationships?.currently_entitled_tiers?.data ?? []
              ).map((tier) => tier.id),
              amountCents: attributes?.currently_entitled_amount_cents ?? 0,
              isActivePatron: attributes?.patron_status === 'active_patron',
            },
          ],
    );
  }
}
```

**Note the sharp edge:** `applyIdentity` deactivates everything not in the list, so passing a single-campaign list from a webhook would deactivate that user's memberships to *other* creators. Constrain the reconciliation to the campaign the event names — see Step 6.

- [ ] **Step 6: Scope the reconciliation to one campaign**

Add an optional second argument to `MembershipSyncService.applyIdentity`:

```ts
  async applyIdentity(
    userId: string,
    memberships: PatreonMembership[],
    options: { onlyCampaignIds?: string[] } = {},
  ): Promise<void> {
```

and constrain the deactivation query:

```ts
    // A webhook speaks for one campaign only. Deactivating everything absent from its payload
    // would revoke this user's access to every other creator they support.
    const scope = options.onlyCampaignIds
      ? await this.prisma.creator.findMany({
          where: { patreonCampaignId: { in: options.onlyCampaignIds } },
          select: { id: true },
        })
      : null;

    await this.prisma.membership.updateMany({
      where: {
        userId,
        creatorId: scope
          ? { in: scope.map((c) => c.id), notIn: syncedCreatorIds }
          : { notIn: syncedCreatorIds },
      },
      data: { isActivePatron: false, currentTierId: null, lastSyncedAt: new Date() },
    });
```

The webhook passes `{ onlyCampaignIds: [campaignId] }`; login and the staleness job pass nothing and keep full reconciliation.

Add a test to `membership-sync.int-spec.ts` proving a scoped call leaves other creators alone.

- [ ] **Step 7: Implement the controller and module**

`apps/api/src/webhooks/webhooks.controller.ts`:

```ts
import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { WebhookSignatureService } from './webhook-signature.service';
import { WebhooksService } from './webhooks.service';

@Controller('webhooks')
export class WebhooksController {
  constructor(
    private readonly signatures: WebhookSignatureService,
    private readonly webhooks: WebhooksService,
  ) {}

  @Post('patreon')
  @HttpCode(204)
  async patreon(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-patreon-event') trigger: string | undefined,
    @Headers('x-patreon-signature') signature: string | undefined,
    @Body() body: unknown,
  ): Promise<void> {
    if (!req.rawBody || !this.signatures.verify(req.rawBody, signature)) {
      // Generic: a caller must not learn whether the secret, the body or the header was wrong.
      throw new UnauthorizedException();
    }
    await this.webhooks.handle(trigger, body as never);
  }
}
```

`apps/api/src/webhooks/webhooks.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { WebhookSignatureService } from './webhook-signature.service';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

@Module({
  controllers: [WebhooksController],
  providers: [WebhookSignatureService, WebhooksService],
})
export class WebhooksModule {}
```

Register `WebhooksModule` in `AppModule`.

- [ ] **Step 8: Run the tests**

Run: `cd apps/api && pnpm test -- "webhook.int|membership-sync"`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(api): patreon webhook endpoint applying pledge events to memberships"
```

---

## Task 4: BullMQ queue and the staleness job

**Files:**

- Modify: `apps/api/package.json` (add `bullmq`)
- Create: `apps/api/src/jobs/jobs.module.ts`, `apps/api/src/jobs/membership-refresh.job.ts`
- Modify: `apps/api/src/config/config.schema.ts` (TTL and toggle)
- Test: `apps/api/test/membership-refresh.int-spec.ts`

**Interfaces:**

- Consumes: `RedisService` (connection URL), `PatreonTokenService`, `PATREON_CLIENT`, `MembershipSyncService`, `PrismaService`.
- Produces: `MembershipRefreshJob.runOnce(): Promise<number>` returning how many users were refreshed, plus a BullMQ `Queue`/`Worker` pair that calls it on a repeatable schedule.

Design §4 names this the fallback for webhooks that never arrive. Keeping `runOnce()` separately callable is what makes it testable without waiting on a scheduler.

- [ ] **Step 1: Add the dependency and config**

`cd apps/api && pnpm add bullmq@5.28.1`

In `config.schema.ts`:

```ts
  MEMBERSHIP_TTL_HOURS: z.coerce.number().int().positive().default(24),
  // Off in tests, where the scheduler would race the assertions.
  JOBS_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
```

Add `JOBS_ENABLED=false` to `test/support/env.ts`'s defaults and to the CI `env:` block.

- [ ] **Step 2: Write the failing test**

`apps/api/test/membership-refresh.int-spec.ts`:

```ts
import { MembershipRefreshJob } from '../src/jobs/membership-refresh.job';
import { AuthTestContext, pickCookie, startAuthApp } from './support/auth-app';
import request from 'supertest';

describe('MembershipRefreshJob (integration)', () => {
  let ctx: AuthTestContext;
  let job: MembershipRefreshJob;
  let creatorId: string;

  beforeAll(async () => {
    ctx = await startAuthApp();
    job = ctx.app.get(MembershipRefreshJob);
    const owner = await ctx.prisma.user.create({ data: { patreonUserId: 'refresh-owner' } });
    const creator = await ctx.prisma.creator.create({
      data: {
        patreonCampaignId: 'refresh-campaign',
        ownerUserId: owner.id,
        displayName: 'Refresh Co',
        slug: 'refresh-co',
        tiers: {
          create: [{ patreonTierId: 'r-tier', title: 'Gold', amountCents: 1000, order: 0 }],
        },
        policy: { create: {} },
      },
    });
    creatorId = creator.id;
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
  });

  async function loginAs(patreonUserId: string): Promise<string> {
    ctx.patreon.identity = { ...ctx.patreon.identity, patreonUserId, memberships: [] };
    const start = await request(ctx.app.getHttpServer()).get('/auth/patreon/login').expect(302);
    const state = new URL(start.headers.location).searchParams.get('state') as string;
    await request(ctx.app.getHttpServer())
      .get(`/auth/patreon/callback?code=auth-code&state=${state}`)
      .set('Cookie', pickCookie(start, 'pp_oauth_state'))
      .expect(302);
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { patreonUserId } });
    return user.id;
  }

  it('leaves a freshly synced membership alone', async () => {
    const userId = await loginAs('refresh-fresh');
    await ctx.prisma.membership.create({
      data: { userId, creatorId, amountCents: 100, isActivePatron: true },
    });
    expect(await job.runOnce()).toBe(0);
  });

  it('re-syncs a membership past the ttl and picks up a revocation', async () => {
    const userId = await loginAs('refresh-stale');
    await ctx.prisma.membership.create({
      data: {
        userId,
        creatorId,
        amountCents: 1000,
        isActivePatron: true,
        lastSyncedAt: new Date(Date.now() - 72 * 60 * 60 * 1000),
      },
    });
    // Patreon now reports no memberships — the webhook for this was never delivered.
    ctx.patreon.identity = { ...ctx.patreon.identity, memberships: [] };

    expect(await job.runOnce()).toBe(1);

    const membership = await ctx.prisma.membership.findUniqueOrThrow({
      where: { userId_creatorId: { userId, creatorId } },
    });
    expect(membership.isActivePatron).toBe(false);
  });

  it('does not stop on one user whose Patreon call fails', async () => {
    const brokenId = await loginAs('refresh-broken');
    await ctx.prisma.user.update({
      where: { id: brokenId },
      // No stored token, so getAccessToken throws for this user only.
      data: { accessTokenEncrypted: null, refreshTokenEncrypted: null },
    });
    await ctx.prisma.membership.create({
      data: {
        userId: brokenId,
        creatorId,
        amountCents: 1,
        isActivePatron: true,
        lastSyncedAt: new Date(Date.now() - 72 * 60 * 60 * 1000),
      },
    });
    const okId = await loginAs('refresh-ok');
    await ctx.prisma.membership.create({
      data: {
        userId: okId,
        creatorId,
        amountCents: 1,
        isActivePatron: true,
        lastSyncedAt: new Date(Date.now() - 72 * 60 * 60 * 1000),
      },
    });

    // One failure must not abandon the rest of the batch.
    expect(await job.runOnce()).toBe(1);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd apps/api && pnpm test -- membership-refresh`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the job**

`apps/api/src/jobs/membership-refresh.job.ts`:

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '../config/config.module';
import { MembershipSyncService } from '../memberships/membership-sync.service';
import { PATREON_CLIENT, PatreonClient } from '../patreon/patreon.client';
import { PatreonTokenService } from '../patreon/patreon-token.service';
import { PrismaService } from '../prisma/prisma.service';

const BATCH_SIZE = 50;

@Injectable()
export class MembershipRefreshJob {
  private readonly logger = new Logger(MembershipRefreshJob.name);

  constructor(
    @Inject(PATREON_CLIENT) private readonly patreon: PatreonClient,
    private readonly tokens: PatreonTokenService,
    private readonly memberships: MembershipSyncService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /** Refreshes users whose membership data has aged out. Returns how many succeeded. */
  async runOnce(): Promise<number> {
    const cutoff = new Date(
      Date.now() - this.config.get('MEMBERSHIP_TTL_HOURS') * 60 * 60 * 1000,
    );
    const stale = await this.prisma.membership.findMany({
      where: { lastSyncedAt: { lt: cutoff } },
      select: { userId: true },
      distinct: ['userId'],
      take: BATCH_SIZE,
    });

    let refreshed = 0;
    for (const { userId } of stale) {
      try {
        const identity = await this.patreon.fetchIdentity(
          await this.tokens.getAccessToken(userId),
        );
        await this.memberships.applyIdentity(userId, identity.memberships);
        refreshed += 1;
      } catch (error) {
        // One user's revoked token or Patreon hiccup must not abandon the batch; theirs stays
        // stale and is retried on the next run.
        this.logger.warn(`Membership refresh failed for user ${userId}: ${(error as Error).message}`);
      }
    }
    if (refreshed > 0) this.logger.log(`Refreshed memberships for ${refreshed} user(s)`);
    return refreshed;
  }
}
```

- [ ] **Step 5: Wire the queue**

`apps/api/src/jobs/jobs.module.ts`:

```ts
import { Global, Module, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { ConfigService } from '../config/config.module';
import { MembershipRefreshJob } from './membership-refresh.job';

const QUEUE = 'membership-refresh';

@Global()
@Module({ providers: [MembershipRefreshJob], exports: [MembershipRefreshJob] })
export class JobsModule implements OnModuleInit, OnApplicationShutdown {
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    private readonly config: ConfigService,
    private readonly job: MembershipRefreshJob,
  ) {}

  async onModuleInit(): Promise<void> {
    // Off in tests, where a scheduler firing mid-assertion is pure flake.
    if (!this.config.get('JOBS_ENABLED')) return;

    const connection = { url: this.config.get('REDIS_URL') };
    this.queue = new Queue(QUEUE, { connection });
    this.worker = new Worker(QUEUE, async () => this.job.runOnce(), { connection });
    // A fixed jobId means every API instance schedules the same repeatable job rather than N
    // copies of it.
    await this.queue.add(
      'tick',
      {},
      { repeat: { every: 15 * 60 * 1000 }, jobId: 'membership-refresh-tick' },
    );
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
```

Register `JobsModule` in `AppModule`.

- [ ] **Step 6: Run the tests**

Run: `cd apps/api && pnpm test -- membership-refresh`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(api): bullmq queue and ttl-based membership refresh job"
```

---

## Task 5: Tier re-sync, documentation and verification

**Files:**

- Modify: `apps/api/src/jobs/membership-refresh.job.ts` (tier re-sync), `README.md`
- Test: `apps/api/test/tier-resync.int-spec.ts`

**Interfaces:**

- Produces: `MembershipRefreshJob.resyncTiers(): Promise<number>` — for each claimed creator, re-reads the owner's campaigns and upserts tiers. Never deletes.

- [ ] **Step 1: Write the failing test**

`apps/api/test/tier-resync.int-spec.ts`:

```ts
import { MembershipRefreshJob } from '../src/jobs/membership-refresh.job';
import { AuthTestContext, pickCookie, startAuthApp } from './support/auth-app';
import request from 'supertest';

describe('Tier re-sync (integration)', () => {
  let ctx: AuthTestContext;
  let job: MembershipRefreshJob;
  let creatorId: string;

  beforeAll(async () => {
    ctx = await startAuthApp();
    job = ctx.app.get(MembershipRefreshJob);

    // The owner must have a stored token, so log them in rather than inserting a bare row.
    ctx.patreon.identity = { ...ctx.patreon.identity, patreonUserId: 'tier-owner', memberships: [] };
    const start = await request(ctx.app.getHttpServer()).get('/auth/patreon/login').expect(302);
    const state = new URL(start.headers.location).searchParams.get('state') as string;
    await request(ctx.app.getHttpServer())
      .get(`/auth/patreon/callback?code=auth-code&state=${state}`)
      .set('Cookie', pickCookie(start, 'pp_oauth_state'))
      .expect(302);
    const owner = await ctx.prisma.user.findUniqueOrThrow({
      where: { patreonUserId: 'tier-owner' },
    });

    const creator = await ctx.prisma.creator.create({
      data: {
        patreonCampaignId: 'tier-campaign',
        ownerUserId: owner.id,
        displayName: 'Tier Co',
        slug: 'tier-co',
        tiers: {
          create: [{ patreonTierId: 't-lo', title: 'Bronze', amountCents: 300, order: 0 }],
        },
        policy: { create: {} },
      },
    });
    creatorId = creator.id;
  }, 240_000);

  afterAll(async () => {
    await ctx.teardown();
  });

  it('imports a tier added on Patreon after the claim', async () => {
    ctx.patreon.campaigns = [
      {
        campaignId: 'tier-campaign',
        displayName: 'Tier Co',
        tiers: [
          { patreonTierId: 't-lo', title: 'Bronze', amountCents: 300, order: 0 },
          { patreonTierId: 't-hi', title: 'Platinum', amountCents: 5000, order: 1 },
        ],
      },
    ];

    expect(await job.resyncTiers()).toBe(1);

    const tiers = await ctx.prisma.tier.findMany({
      where: { creatorId },
      orderBy: { amountCents: 'asc' },
    });
    expect(tiers.map((t) => t.patreonTierId)).toEqual(['t-lo', 't-hi']);
  });

  it('updates a tier whose price changed', async () => {
    ctx.patreon.campaigns = [
      {
        campaignId: 'tier-campaign',
        displayName: 'Tier Co',
        tiers: [{ patreonTierId: 't-lo', title: 'Bronze', amountCents: 400, order: 0 }],
      },
    ];
    await job.resyncTiers();
    const tier = await ctx.prisma.tier.findFirstOrThrow({
      where: { creatorId, patreonTierId: 't-lo' },
    });
    expect(tier.amountCents).toBe(400);
  });

  it('keeps a tier that disappeared from Patreon rather than deleting it', async () => {
    ctx.patreon.campaigns = [
      { campaignId: 'tier-campaign', displayName: 'Tier Co', tiers: [] },
    ];
    await job.resyncTiers();
    // Deleting would fail against a policy gate (Restrict) or silently widen it.
    expect(await ctx.prisma.tier.count({ where: { creatorId } })).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && pnpm test -- tier-resync`
Expected: FAIL — `resyncTiers` is not a function.

- [ ] **Step 3: Implement `resyncTiers`**

Add to `MembershipRefreshJob`:

```ts
  /**
   * Re-reads each claimed creator's tiers from Patreon using the owner's token. Upsert-only:
   * Plan 03 made policy gate tiers onDelete: Restrict so a re-sync could not silently widen a
   * gate, so a tier removed on Patreon lingers here instead — visible, and harmless to gates.
   */
  async resyncTiers(): Promise<number> {
    const creators = await this.prisma.creator.findMany({
      select: { id: true, patreonCampaignId: true, ownerUserId: true },
      take: BATCH_SIZE,
    });

    let updated = 0;
    for (const creator of creators) {
      try {
        const campaigns = await this.patreon.fetchOwnedCampaigns(
          await this.tokens.getAccessToken(creator.ownerUserId),
        );
        const campaign = campaigns.find((c) => c.campaignId === creator.patreonCampaignId);
        if (!campaign) continue;

        for (const tier of campaign.tiers) {
          await this.prisma.tier.upsert({
            where: {
              creatorId_patreonTierId: {
                creatorId: creator.id,
                patreonTierId: tier.patreonTierId,
              },
            },
            create: { creatorId: creator.id, ...tier },
            update: { title: tier.title, amountCents: tier.amountCents, order: tier.order },
          });
        }
        updated += 1;
      } catch (error) {
        this.logger.warn(
          `Tier re-sync failed for creator ${creator.id}: ${(error as Error).message}`,
        );
      }
    }
    return updated;
  }
```

Call it from the worker alongside `runOnce()`.

- [ ] **Step 4: Document the webhook in the README**

Add to the endpoints list:

```
- `POST /webhooks/patreon` — Patreon events; authenticated by HMAC signature, exempt from CSRF
```

and a short "Webhooks" section explaining that `PATREON_WEBHOOK_SECRET` must match the value configured in the Patreon developer portal, that the endpoint must be reachable publicly for events to arrive, and that missing webhooks degrade to the TTL refresh rather than breaking access.

- [ ] **Step 5: Full verification**

```bash
pnpm -r typecheck && pnpm -r test && pnpm format:check
docker build -f apps/api/Dockerfile -t patreonplanner-api .
```

Then run the image and confirm it still answers `/readyz`, and that an unsigned `POST /webhooks/patreon` returns 401 rather than 403 — proving the CSRF exemption is in the built image and not just the test harness.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(api): tier re-sync and webhook documentation"
```

---

## Self-Review

**Spec coverage (design §4 "Keeping tier status fresh", §8 webhooks, §9 signature verification):**

- `members:pledge:create/update/delete` → `Membership` → Task 3. ✅
- Signatures verified with constant-time comparison → Task 2. ✅
- Fallback: re-sync on login → already in Plan 02, now sharing one service (Task 1). ✅
- Fallback: TTL (`lastSyncedAt`) refresh via background job → Task 4. ✅
- `POST /webhooks/patreon` at the root → Task 3. ✅
- BullMQ on Redis → Task 4, with one job; the others belong to the plans that own them. ✅
- Tier drift after claiming → Task 5 (not named in the design, but a real gap Plan 03's review surfaced). ✅

**Placeholder scan:** no TBD/TODO; every code step is compilable content.

**Type consistency:** `MembershipSyncService.applyIdentity` gains its `options` argument in Task 3 Step 6 and is called with it only by the webhook; Task 1's signature is a strict prefix, so Task 1's tests keep compiling. `PatreonMembership` is the existing Plan 02 type, unchanged. `MembershipRefreshJob.runOnce`/`resyncTiers` are defined in Tasks 4-5 and consumed by `JobsModule`. `FakePatreonClient.campaigns` already exists from Plan 03. ✅

**Known risks:**

1. **MD5.** Patreon's choice, documented in Task 2 rather than hidden. The secret is the entire security boundary; if Patreon ever offers SHA-256, switch.
2. **The `applyIdentity` scoping trap.** A webhook speaks for one campaign; unscoped reconciliation would revoke that user's access to every other creator. Task 3 Step 6 exists solely to prevent it, and it is the single most dangerous line in this plan.
3. **Jobs run in the API process.** Two instances both schedule the repeatable job; the fixed `jobId` de-duplicates it, but a separate worker process is the real answer once there is more than one job.
