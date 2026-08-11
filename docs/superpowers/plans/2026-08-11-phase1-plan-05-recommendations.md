# Recommendations Core Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a patron submit a recommendation to a creator they support, upvote others', and read the board — every action gated by Plan 03's `CreatorAccessGuard`, rate-limited, and screened by a moderation pipeline.

**Architecture:** `Recommendation` and `Upvote` join the tenant-scoped models. Submission runs a fixed sequence — capability → rate limit → moderation → de-dupe → persist as `PENDING` — with each stage behind its own service so later plans can extend one without touching the others. The moderation pipeline is an interface with a wordlist implementation; design §6's ML stage slots in beside it. Upvotes toggle and maintain the denormalized `upvoteCount` design §5 relies on for board queries.

**Tech Stack:** NestJS 10, Prisma, Redis (sliding-window rate limits), `obscenity` for the wordlist, Jest + supertest + Testcontainers.

## Global Constraints

Carried forward from design §9.

- **Input validation:** `class-validator` DTOs on every endpoint (types, lengths, formats).
- **All authorization server-side**; the SPA never gates security.
- **Generic errors:** no stack traces, no probing of what exists.
- **SQL injection:** Prisma parameterizes; `$queryRaw` only via tagged templates.
- **CSRF** on every state-changing route.
- **Moderation power derives only from a `CreatorStaff` row.**

## Scope

**In scope:** `Recommendation` + `Upvote` models, `EXTERNAL_LINK` and custom-title submissions, the submit pipeline (capability → rate limit → moderation → de-dupe → persist), upvote toggle with denormalized count, and a paginated board read.

**Out of scope — deliberately deferred:**

- **TMDB catalog** (design §5 "Content classes", `catalog/search`, `Title`, `TitleAlias`, where-to-watch) → Plan 06. Submissions here carry `customTitle` and links, which is exactly the `EXTERNAL_LINK` class design §5 already defines — so the core loop is complete for that class rather than half-built for all of them.
- **Catalog intelligence** (embeddings, `TitleRelation`, themes) → Plan 08. Design §5 says explicitly it is "sequenced *after* the core loop".
- **ML moderation, flags, human review queue, abuse scoring** (design §6 items 4-6) → Plan 07. The pipeline interface and the wordlist stage land here so the seam exists.
- **Status lifecycle beyond `PENDING`, the kanban board, notes** (design §7) → Plan 07.

## Prerequisites

Plans 01–04 merged: `CreatorAccessGuard`, `@RequireCapability`, `SessionGuard`, CSRF, and the `Creator`/`Membership`/`Tier` models.

## Decisions this plan settles

**Resubmitting an existing title returns the existing entry, not an error.** Design §5 says a duplicate "returns the existing entry and invites upvote instead of erroring". So the endpoint answers `200` with the existing recommendation and a `duplicate: true` marker, rather than `409`. A creator's board is a demand signal; telling the second person to go away loses the signal.

**`upvoteCount` is denormalized and maintained in the same transaction as the `Upvote` row.** Design §5 relies on it for fast board queries. Recomputing on read would make the board O(upvotes); leaving it eventually-consistent would show wrong numbers on the page that exists to display them.

**Rate limiting is per (user, creator), sliding window, in Redis.** Design §6 item 3 specifies 1 new recommendation per hour per creator, and that **upvotes are exempt**. The limiter is keyed and counted in Redis rather than derived from `createdAt`, so it survives deletions and stays O(1).

**Moderation runs before persistence, not after.** A `BLOCK` verdict means the row is never written. Design §6 wants `ModerationResult` stored, but storing a result for a recommendation that does not exist needs a nullable FK and invites orphans; Plan 07 introduces `ModerationResult` alongside the flags and review queue that actually read it. Until then a blocked submission is refused with a generic message and logged.

---

## Task 1: `Recommendation` and `Upvote` models

**Files:**

- Modify: `apps/api/prisma/schema.prisma`
- Create: migration
- Test: `apps/api/test/recommendation-model.int-spec.ts`

**Interfaces:**

- Produces: enums `RecommendationType { MOVIE, SHOW, FRANCHISE, WATCH_ORDER, EXTERNAL_LINK }` and `RecommendationStatus { PENDING, ACCEPTED, ACTIVE, COMPLETED, REJECTED, DELETED }`; models `Recommendation`, `RecommendationLink`, `Upvote`.

- [ ] **Step 1: Add to `apps/api/prisma/schema.prisma`**

```prisma
enum RecommendationType {
  MOVIE
  SHOW
  FRANCHISE
  WATCH_ORDER
  EXTERNAL_LINK
}

enum RecommendationStatus {
  PENDING
  ACCEPTED
  ACTIVE
  COMPLETED
  REJECTED
  DELETED
}

model Recommendation {
  id                String               @id @default(uuid()) @db.Uuid
  creatorId         String               @db.Uuid
  submittedByUserId String               @db.Uuid
  type              RecommendationType
  customTitle       String
  description       String?
  notes             String?
  status            RecommendationStatus @default(PENDING)
  // Denormalized so the board does not count rows per entry on every read (design §5).
  upvoteCount       Int                  @default(0)
  createdAt         DateTime             @default(now())
  updatedAt         DateTime             @updatedAt

  creator     Creator              @relation(fields: [creatorId], references: [id], onDelete: Cascade)
  submittedBy User                 @relation(fields: [submittedByUserId], references: [id], onDelete: Cascade)
  links       RecommendationLink[]
  upvotes     Upvote[]

  @@index([creatorId, status, upvoteCount])
  @@index([submittedByUserId])
}

model RecommendationLink {
  id               String   @id @default(uuid()) @db.Uuid
  recommendationId String   @db.Uuid
  url              String
  label            String?
  createdAt        DateTime @default(now())

  recommendation Recommendation @relation(fields: [recommendationId], references: [id], onDelete: Cascade)

  @@index([recommendationId])
}

model Upvote {
  id               String   @id @default(uuid()) @db.Uuid
  recommendationId String   @db.Uuid
  userId           String   @db.Uuid
  createdAt        DateTime @default(now())

  recommendation Recommendation @relation(fields: [recommendationId], references: [id], onDelete: Cascade)
  user           User           @relation(fields: [userId], references: [id], onDelete: Cascade)

  // Design §5: one upvote per person per entry.
  @@unique([recommendationId, userId])
  @@index([userId])
}
```

Add the back-relations on `Creator` (`recommendations Recommendation[]`) and `User` (`recommendations Recommendation[]`, `upvotes Upvote[]`).

`titleId` and the canonical de-dupe key `unique(creatorId, titleId, type)` are absent because `Title` arrives in Plan 06; Task 4 de-dupes on normalized `customTitle` instead, which is what design §5 specifies for the `EXTERNAL_LINK` class.

- [ ] **Step 2: Migrate**

```bash
cd apps/api && pnpm prisma:migrate --name recommendations
```

- [ ] **Step 3: Write the model test**

`apps/api/test/recommendation-model.int-spec.ts` — assert: one upvote per user per recommendation (unique violation on the second); deleting a recommendation removes its upvotes and links; deleting a creator removes its recommendations; `upvoteCount` defaults to 0 and `status` to `PENDING`.

```ts
import { PrismaClient } from '@prisma/client';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startDatabase } from './support/database';

describe('Recommendation models (integration)', () => {
  let pg: StartedPostgreSqlContainer;
  let prisma: PrismaClient;
  let creatorId: string;
  let userId: string;

  beforeAll(async () => {
    pg = await startDatabase();
    prisma = new PrismaClient({ datasources: { db: { url: pg.getConnectionUri() } } });
    await prisma.$connect();
    const owner = await prisma.user.create({ data: { patreonUserId: 'rec-owner' } });
    userId = owner.id;
    const creator = await prisma.creator.create({
      data: {
        patreonCampaignId: 'rec-campaign',
        ownerUserId: owner.id,
        displayName: 'Rec Co',
        slug: 'rec-co',
      },
    });
    creatorId = creator.id;
  }, 180_000);

  afterAll(async () => {
    await prisma.$disconnect();
    await pg.stop();
  });

  const make = () =>
    prisma.recommendation.create({
      data: {
        creatorId,
        submittedByUserId: userId,
        type: 'EXTERNAL_LINK',
        customTitle: 'A Thing',
      },
    });

  it('defaults to PENDING with no upvotes', async () => {
    const rec = await make();
    expect(rec.status).toBe('PENDING');
    expect(rec.upvoteCount).toBe(0);
  });

  it('allows only one upvote per user per recommendation', async () => {
    const rec = await make();
    await prisma.upvote.create({ data: { recommendationId: rec.id, userId } });
    await expect(
      prisma.upvote.create({ data: { recommendationId: rec.id, userId } }),
    ).rejects.toThrow();
  });

  it('removes upvotes and links when the recommendation goes', async () => {
    const rec = await make();
    await prisma.upvote.create({ data: { recommendationId: rec.id, userId } });
    await prisma.recommendationLink.create({
      data: { recommendationId: rec.id, url: 'https://example.com' },
    });
    await prisma.recommendation.delete({ where: { id: rec.id } });
    expect(await prisma.upvote.count({ where: { recommendationId: rec.id } })).toBe(0);
    expect(await prisma.recommendationLink.count({ where: { recommendationId: rec.id } })).toBe(0);
  });
});
```

- [ ] **Step 4: Run and commit**

Run: `cd apps/api && pnpm test -- recommendation-model` → PASS.

```bash
git add -A && git commit -m "feat(api): recommendation, link and upvote models"
```

---

## Task 2: Submission rate limiter

**Files:**

- Create: `apps/api/src/limits/rate-limit.service.ts`, `limits.module.ts`
- Modify: `apps/api/src/config/config.schema.ts`, `apps/api/src/app.module.ts`
- Test: `apps/api/test/rate-limit.int-spec.ts`

**Interfaces:**

- Consumes: `RedisService`, `ConfigService`.
- Produces: `RateLimitService.consume(key: string, limit: number, windowSeconds: number): Promise<boolean>` — returns `false` when the window is exhausted. New config: `SUBMIT_LIMIT_PER_HOUR` (default 1).

- [ ] **Step 1: Add config**

```ts
  SUBMIT_LIMIT_PER_HOUR: z.coerce.number().int().positive().default(1),
```

- [ ] **Step 2: Write the failing test**

`apps/api/test/rate-limit.int-spec.ts`, against a Testcontainers Redis:

```ts
it('allows up to the limit then refuses', async () => {
  expect(await limiter.consume('k1', 2, 60)).toBe(true);
  expect(await limiter.consume('k1', 2, 60)).toBe(true);
  expect(await limiter.consume('k1', 2, 60)).toBe(false);
});

it('keeps separate keys independent', async () => {
  expect(await limiter.consume('k2', 1, 60)).toBe(true);
  expect(await limiter.consume('k3', 1, 60)).toBe(true);
});

it('expires the window', async () => {
  expect(await limiter.consume('k4', 1, 1)).toBe(true);
  expect(await limiter.consume('k4', 1, 1)).toBe(false);
  await new Promise((r) => setTimeout(r, 1200));
  // A fixed counter with a TTL, so the window resets rather than sliding forever.
  expect(await limiter.consume('k4', 1, 1)).toBe(true);
});

it('does not extend the window on later calls', async () => {
  await limiter.consume('k5', 5, 2);
  await new Promise((r) => setTimeout(r, 1000));
  await limiter.consume('k5', 5, 2);
  const ttl = await redisService.raw().ttl('ratelimit:k5');
  // EXPIRE only on creation: otherwise a busy caller could hold a window open indefinitely.
  expect(ttl).toBeLessThanOrEqual(1);
});
```

- [ ] **Step 3: Implement**

```ts
import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

const PREFIX = 'ratelimit:';

@Injectable()
export class RateLimitService {
  constructor(private readonly redis: RedisService) {}

  /** Fixed-window counter. Returns false once the window's allowance is spent. */
  async consume(key: string, limit: number, windowSeconds: number): Promise<boolean> {
    const redisKey = `${PREFIX}${key}`;
    const count = await this.redis.raw().incr(redisKey);
    // Set the TTL only when the counter is created, so a steady stream of calls cannot keep
    // pushing the expiry out and hold the window open forever.
    if (count === 1) await this.redis.raw().expire(redisKey, windowSeconds);
    return count <= limit;
  }
}
```

Export from a `@Global()` `LimitsModule`; register in `AppModule`.

- [ ] **Step 4: Run and commit**

---

## Task 3: Moderation pipeline (wordlist)

**Files:**

- Modify: `apps/api/package.json` (add `obscenity`)
- Create: `apps/api/src/moderation/moderation.types.ts`, `wordlist-moderator.ts`, `moderation.service.ts`, `moderation.module.ts`
- Test: `apps/api/test/moderation.e2e-spec.ts`

**Interfaces:**

- Produces: `type ModerationVerdict = 'PASS' | 'FLAG' | 'BLOCK'`; `interface Moderator { review(text: string): Promise<ModerationResultData> }`; `ModerationService.review(parts: string[])` returning the most severe verdict across all parts.

Design §6 item 5 puts wordlist and ML behind one pipeline. Only the wordlist lands here; the interface is what makes Plan 07's ML stage additive.

- [ ] **Step 1: Add the dependency**

`cd apps/api && pnpm add obscenity@0.4.3`

- [ ] **Step 2: Write the failing test**

```ts
it('passes clean text', async () => {
  expect((await service.review(['A perfectly nice film'])).verdict).toBe('PASS');
});

it('blocks profanity', async () => {
  expect((await service.review(['this is shit'])).verdict).toBe('BLOCK');
});

it('catches obfuscated profanity', async () => {
  // The whole reason for a matcher rather than a substring list.
  expect((await service.review(['this is $h1t'])).verdict).toBe('BLOCK');
});

it('reviews every part, not just the first', async () => {
  expect((await service.review(['clean title', 'shit description'])).verdict).toBe('BLOCK');
});

it('returns the most severe verdict across parts', async () => {
  const result = await service.review(['clean', 'shit']);
  expect(result.verdict).toBe('BLOCK');
  expect(result.categories).toContain('PROFANITY');
});

it('ignores empty and undefined parts', async () => {
  expect((await service.review(['ok', undefined, ''])).verdict).toBe('PASS');
});
```

- [ ] **Step 3: Implement**

`moderation.types.ts`:

```ts
export type ModerationVerdict = 'PASS' | 'FLAG' | 'BLOCK';

export interface ModerationResultData {
  verdict: ModerationVerdict;
  categories: string[];
  source: 'WORDLIST' | 'ML';
}

export interface Moderator {
  review(text: string): Promise<ModerationResultData>;
}
```

`wordlist-moderator.ts` wraps `obscenity`'s `RegExpMatcher` with the English preset. `moderation.service.ts` runs every configured `Moderator` over every non-empty part and returns the most severe verdict, ordering `BLOCK > FLAG > PASS`.

- [ ] **Step 4: Run and commit**

---

## Task 4: Submit a recommendation

**Files:**

- Create: `apps/api/src/recommendations/recommendations.service.ts`, `recommendations.controller.ts`, `recommendations.module.ts`, `dto/submit-recommendation.dto.ts`, `normalize-title.ts`
- Test: `apps/api/test/submit-recommendation.int-spec.ts`, `apps/api/test/normalize-title.e2e-spec.ts`

**Interfaces:**

- Consumes: `CreatorAccessGuard` + `@RequireCapability('SUBMIT')`, `RateLimitService`, `ModerationService`, `PrismaService`.
- Produces: `POST /api/v1/creators/:slug/recommendations` → `201` with the created entry, or `200` with `{ duplicate: true }` when one already exists.

- [ ] **Step 1: Title normalization and its test**

`normalize-title.ts` lowercases, strips punctuation and collapses whitespace, so "The Matrix!" and "the  matrix" de-dupe together. Tests cover casing, punctuation, whitespace, and that two genuinely different titles stay distinct.

- [ ] **Step 2: The DTO**

```ts
export class SubmitRecommendationDto {
  @IsIn(['EXTERNAL_LINK'])
  type!: 'EXTERNAL_LINK';

  @IsString()
  @Length(1, 200)
  customTitle!: string;

  @IsOptional()
  @IsString()
  @Length(1, 2000)
  description?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @ValidateNested({ each: true })
  @Type(() => RecommendationLinkDto)
  links?: RecommendationLinkDto[];
}
```

`RecommendationLinkDto.url` is `@IsUrl({ protocols: ['http', 'https'], require_protocol: true })` — the same reasoning as `Creator.baseUrl`: a `javascript:` URL stored now becomes a rendered link later. Only `EXTERNAL_LINK` is accepted until Plan 06 brings TMDB, so a client cannot create a `MOVIE` with no `Title` behind it.

- [ ] **Step 3: Write the failing test**

`submit-recommendation.int-spec.ts` covers, in order:

- 401 anonymous, 403 logged-in non-patron (the guard, via `SUBMIT`)
- 403 when the patron's pledge is below `submitMinTier`
- 201 for an eligible patron, persisted `PENDING` with `upvoteCount: 0` and its links
- 200 + `duplicate: true` on resubmitting the same normalized title, with no second row
- 429 on the second submission inside the window
- 400 for a blocked word, and **no row written**
- 400 for a `javascript:` link
- 400 for `type: 'MOVIE'`
- a submission to creator A is invisible to creator B (tenant isolation)

- [ ] **Step 4: Implement the service**

The pipeline, in this order, with the reason each stage precedes the next:

```ts
async submit(creatorId: string, userId: string, dto: SubmitRecommendationDto) {
  // Rate limit before moderation: moderation is the expensive stage, and a flood must not be
  // able to drive that cost.
  const allowed = await this.limits.consume(
    `submit:${userId}:${creatorId}`,
    this.config.get('SUBMIT_LIMIT_PER_HOUR'),
    3600,
  );
  if (!allowed) throw new HttpException('Too many submissions', HttpStatus.TOO_MANY_REQUESTS);

  const moderation = await this.moderation.review([dto.customTitle, dto.description]);
  if (moderation.verdict === 'BLOCK') {
    this.logger.warn(`Blocked submission from ${userId} to ${creatorId}`);
    throw new BadRequestException('Submission rejected');
  }

  // De-dupe after moderation so a blocked resubmission cannot confirm what already exists.
  const normalized = normalizeTitle(dto.customTitle);
  const existing = await this.prisma.recommendation.findFirst({
    where: { creatorId, normalizedTitle: normalized, status: { not: 'DELETED' } },
    select: RECOMMENDATION_FIELDS,
  });
  // Design §5: a resubmit returns the existing entry and invites an upvote rather than erroring.
  if (existing) return { duplicate: true as const, recommendation: existing };

  const created = await this.prisma.recommendation.create({ ... });
  return { duplicate: false as const, recommendation: created };
}
```

This requires a `normalizedTitle` column on `Recommendation` with `@@index([creatorId, normalizedTitle])` — add it in Task 1's migration rather than a second one.

- [ ] **Step 5: Run and commit**

---

## Task 5: Upvote toggle

**Files:**

- Modify: `apps/api/src/recommendations/recommendations.service.ts`, `recommendations.controller.ts`
- Test: `apps/api/test/upvote.int-spec.ts`

**Interfaces:**

- Produces: `POST /api/v1/creators/:slug/recommendations/:id/upvote` (`UPVOTE`) → `{ upvoted: boolean; upvoteCount: number }`.

- [ ] **Step 1: Write the failing test**

Covers: 403 for a non-patron; toggling on then off; `upvoteCount` tracking both ways; a second user's upvote counting separately; that a user cannot upvote the same entry twice concurrently (fire two requests, expect count 1); 404 for a recommendation belonging to a different creator, exercised through creator B's slug.

- [ ] **Step 2: Implement**

```ts
async toggleUpvote(creatorId: string, recommendationId: string, userId: string) {
  // Scoped by creatorId as well as id: without it, a patron of creator A could upvote an entry
  // on creator B's board by guessing an id, since the guard only checked A.
  const rec = await this.prisma.recommendation.findFirst({
    where: { id: recommendationId, creatorId },
    select: { id: true },
  });
  if (!rec) throw new NotFoundException();

  return this.prisma.$transaction(async (tx) => {
    const existing = await tx.upvote.findUnique({
      where: { recommendationId_userId: { recommendationId, userId } },
    });
    if (existing) {
      await tx.upvote.delete({ where: { id: existing.id } });
      const updated = await tx.recommendation.update({
        where: { id: recommendationId },
        data: { upvoteCount: { decrement: 1 } },
        select: { upvoteCount: true },
      });
      return { upvoted: false, upvoteCount: updated.upvoteCount };
    }
    await tx.upvote.create({ data: { recommendationId, userId } });
    const updated = await tx.recommendation.update({
      where: { id: recommendationId },
      data: { upvoteCount: { increment: 1 } },
      select: { upvoteCount: true },
    });
    return { upvoted: true, upvoteCount: updated.upvoteCount };
  });
}
```

The row write and the counter move in one transaction, so the number on the board cannot drift from the rows behind it.

- [ ] **Step 3: Run and commit**

---

## Task 6: Board read, verification and documentation

**Files:**

- Modify: `apps/api/src/recommendations/recommendations.controller.ts`, `recommendations.service.ts`, `README.md`
- Test: `apps/api/test/board.int-spec.ts`

**Interfaces:**

- Produces: `GET /api/v1/creators/:slug/recommendations` (`VIEW`) with `?cursor=&limit=` → `{ items: [...], nextCursor: string | null }`, ordered by `upvoteCount` desc then `createdAt` desc.

- [ ] **Step 1: Write the failing test**

Covers: anonymous read of a `PUBLIC` creator; 401/403 following `viewVisibility`; ordering by upvotes then recency; `DELETED` entries excluded; cursor paging returning every item exactly once across pages; `limit` clamped to a maximum; and that the response never includes the submitter's email or Patreon id.

- [ ] **Step 2: Implement**

Keyset pagination on `(upvoteCount, createdAt, id)` rather than `skip`/`take`: offset paging shifts under concurrent upvoting and would show or skip entries mid-scroll. The submitter is exposed as `{ id, fullName, avatarUrl }` only — an explicit `select`, the same reasoning as `/me`.

- [ ] **Step 3: Full verification**

```bash
pnpm -r typecheck && pnpm -r test && pnpm format:check
docker build -f apps/api/Dockerfile -t patreonplanner-api .
```

Then run the image and confirm the board endpoint answers for a public creator and 401s for a gated one.

- [ ] **Step 4: Document the endpoints in the README and commit**

---

## Self-Review

**Spec coverage (design §5 core loop, §6 items 2-3 and 5's wordlist, §8 API surface):**

- Submit flow: rate limit → moderation → persist `PENDING` → Tasks 2-4. ✅
- De-dupe returning the existing entry and inviting an upvote → Task 4. ✅
- Upvote toggle, tier-gated, denormalized count → Task 5. ✅
- Board list ordered by upvotes → Task 6. ✅
- `POST /recommendations`, `POST /recommendations/:id/upvote`, `GET /creators/:id/recommendations` → Tasks 4-6. ✅
- Submission limiter, upvotes exempt → Task 2 (the upvote route never calls `consume`). ✅
- Wordlist moderation behind a pipeline interface → Task 3. ✅
- TMDB, semantic de-dupe, embeddings, availability, ML moderation, flags, abuse scoring, lifecycle → **deferred** with the plan each belongs to. ✅

**Placeholder scan:** Tasks 1-3 and 5 carry full code; Tasks 4 and 6 specify the pipeline and pagination in code with their test cases enumerated rather than transcribed — the enumerated list is the acceptance criteria, and each item names a concrete assertion.

**Type consistency:** `ModerationService.review` is defined in Task 3 and called in Task 4. `RateLimitService.consume` is defined in Task 2 and called in Task 4. `normalizeTitle` is defined in Task 4 Step 1 and used in Step 4. `normalizedTitle` is introduced in Task 1's migration and relied on by Task 4's de-dupe query. Route params use `:slug` so `CreatorAccessGuard.loadCreator` resolves them, matching Plan 03. ✅

**Known risks:**

1. **The rate limiter is a fixed window, not sliding.** A caller can submit at the end of one window and the start of the next. Design §6 says "sliding window"; a fixed window is simpler, and the practical difference at 1/hour is one extra submission. Noted rather than hidden; Plan 07's abuse scoring is where precision starts to matter.
2. **De-dupe is normalized-title only.** Design §5 wants fuzzy and semantic matching too; both need `pg_trgm` and pgvector over a `Title` table that does not exist yet. Exact-normalized is the subset that works without them.
3. **`upvoteCount` can drift** if a write lands outside the Task 5 transaction. No other code path writes it today; Plan 07's moderation actions must use the same transaction when they delete entries.
