# Submission Lifecycle & Moderation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give creators and their moderators the power to act on a board — move entries through the lifecycle, redact or remove bad content, and work a review queue fed by community flags — with every action written to an audit log.

**Architecture:** A pure `nextStatus()` transition map decides what moves are legal, mirroring `can()`: the rules worth exhaustive testing are the ones with no database behind them. Every mutation that changes an entry writes a `ModerationAction` **inside the same transaction**, so the audit log cannot disagree with the row it describes. The review queue is a second read model over the same table with its own ordering and its own visibility rules — staff see rejected and deleted entries, patrons never do.

**Tech Stack:** NestJS 10, Prisma 5.20, Postgres, React 18 + Vite (existing stack; no new dependencies).

## Global Constraints

- **`MODERATE` comes only from a `CreatorStaff` row** (design §3). No pledge amount reaches it; `can()` already enforces this and must not be weakened.
- **Every lifecycle and moderation mutation is audited.** `ModerationAction` rows are written in the same transaction as the change. An audit log with gaps is worse than none, because it is trusted.
- **Fail closed on visibility.** A status not explicitly listed as patron-visible is staff-only. New statuses must be added deliberately, not inherited.
- **The SPA never gates security** (design §4). Staff controls render from `capabilities.moderate`; the API refuses regardless.
- **No `dangerouslySetInnerHTML`.** Flag notes and redaction text are attacker-chosen.
- **Generic errors to the caller, specific in the log** (design §9).

## Scope

**In scope:** the status lifecycle with a legal-transition map, the `ModerationAction` audit log, `hidePendingFromPublic`, community flags with a one-per-user cap, the staff review queue, staff edit/redact, soft delete and restore, and the SPA surfaces for all of it.

**Out of scope — deliberately deferred, with the reason:**

- **`ModerationResult` persistence** (design §6.5) → the wordlist has exactly two outcomes today: `PASS`, which needs no row, and `BLOCK`, which rejects at the door and so has no recommendation to attach a row to. The model earns its place when the ML stage introduces `FLAG`; storing PASS rows now is a table that only grows.
- **`AbuseRecord` / abuse score** (design §6.4) → needs upheld flags *and* moderation blocks *and* rate-limit strikes to feed it. This plan produces the first of those three; building the scorer against one input would fix its shape prematurely.
- **`Notification`** (design §3) → in-app notifications need a delivery surface and a read model of their own. Flags surface in the review queue, which is what makes them actionable.
- **`CreatorNote`** (design §7) → editorial commentary and scheduling timelines, not moderation. Wants the timeline UI to be worth anything.
- **Kanban drag-and-drop and bulk actions** (design §7) → the transitions must exist and be trustworthy before a UI moves things in bulk. This plan ships explicit per-entry controls.
- **Coarse per-IP token bucket** (design §6.2) → belongs with the edge/WAF work, and the per-user submission limiter already covers the abuse path this plan touches.

## Decisions this plan settles

**Status changes go through a transition map, not a free-form write.** `POST /recommendations/:id/status` with `{ status }` consults `isLegalTransition(from, to)` and answers `409` when the move is not in the graph. The alternative — trusting whatever a staff member's client sends — makes `COMPLETED → PENDING` as valid as any other move and leaves the lifecycle diagram in design §7 as decoration. Restoration is explicit: `DELETED` and `REJECTED` return to `PENDING`, not to whatever they were before, because the previous status is not recoverable from the row.

**`hidePendingFromPublic` hides pending entries from everyone except staff and the entry's own submitter.** Hiding a patron's submission from the patron who wrote it makes the submit form look broken — they get a success response and then an empty board. Design §7 wants the pending queue off the public board; it does not want submitters to doubt whether their submission landed.

**One flag per user per entry, enforced by a unique index.** Flag count is a moderation priority signal (design §6.6: "multiple flags raise priority"). If one angry user can file fifty, the signal measures persistence rather than consensus. A repeat flag returns the existing flag rather than erroring, matching how resubmission behaves.

**The review queue is its own endpoint, not a board filter.** It orders by open flag count then age, includes `REJECTED` and `DELETED` so the bin is reachable, and returns the submitter's identity — none of which belongs on the patron board's read model. Overloading `GET /recommendations` with a `?queue=true` would mean one query serving two different visibility rules, which is how a leak gets written.

**Redaction overwrites, never appends.** A staff edit replaces `customTitle`/`description` and the before-state lives only in the audit log's snapshot. Keeping the original in the row for display would defeat the point of redacting it.

---

## Task 1: The transition map

**Files:**

- Create: `apps/api/src/moderation/transitions.ts`
- Test: `apps/api/src/moderation/transitions.spec.ts`

**Interfaces:**

- Produces: `isLegalTransition(from: RecommendationStatus, to: RecommendationStatus): boolean`, `PATRON_VISIBLE_STATUSES: RecommendationStatus[]`.

Pure, like `can()`. No Prisma import in this file.

- [ ] **Step 1: Write the failing test**

```ts
import { isLegalTransition, PATRON_VISIBLE_STATUSES } from './transitions';

describe('isLegalTransition', () => {
  it('walks the lifecycle forward', () => {
    expect(isLegalTransition('PENDING', 'ACCEPTED')).toBe(true);
    expect(isLegalTransition('ACCEPTED', 'ACTIVE')).toBe(true);
    expect(isLegalTransition('ACTIVE', 'COMPLETED')).toBe(true);
  });

  it('refuses to skip stages', () => {
    expect(isLegalTransition('PENDING', 'ACTIVE')).toBe(false);
    expect(isLegalTransition('PENDING', 'COMPLETED')).toBe(false);
  });

  it('refuses to walk backwards', () => {
    expect(isLegalTransition('COMPLETED', 'ACTIVE')).toBe(false);
    expect(isLegalTransition('ACTIVE', 'ACCEPTED')).toBe(false);
  });

  it('allows rejection from any live status', () => {
    for (const from of ['PENDING', 'ACCEPTED', 'ACTIVE', 'COMPLETED'] as const) {
      expect(isLegalTransition(from, 'REJECTED')).toBe(true);
    }
  });

  it('allows soft deletion from any status', () => {
    for (const from of ['PENDING', 'ACCEPTED', 'ACTIVE', 'COMPLETED', 'REJECTED'] as const) {
      expect(isLegalTransition(from, 'DELETED')).toBe(true);
    }
  });

  it('restores rejected and deleted entries to PENDING only', () => {
    expect(isLegalTransition('DELETED', 'PENDING')).toBe(true);
    expect(isLegalTransition('REJECTED', 'PENDING')).toBe(true);
    expect(isLegalTransition('DELETED', 'ACTIVE')).toBe(false);
  });

  it('rejects a no-op transition', () => {
    // Not an error the client should have to distinguish, but it must not write an audit row
    // claiming something changed.
    expect(isLegalTransition('ACTIVE', 'ACTIVE')).toBe(false);
  });

  it('keeps rejected and deleted entries off the patron board', () => {
    expect(PATRON_VISIBLE_STATUSES).toEqual(['PENDING', 'ACCEPTED', 'ACTIVE', 'COMPLETED']);
  });
});
```

- [ ] **Step 2: Run it, watch it fail**

`pnpm --filter @app/api test -- transitions`

- [ ] **Step 3: Implement**

```ts
import type { RecommendationStatus } from '@prisma/client';

/**
 * Design §7's lifecycle diagram as data. Anything not listed is illegal — the map is a
 * whitelist so a new status is invisible until someone decides where it connects.
 */
const TRANSITIONS: Record<RecommendationStatus, RecommendationStatus[]> = {
  PENDING: ['ACCEPTED', 'REJECTED', 'DELETED'],
  ACCEPTED: ['ACTIVE', 'REJECTED', 'DELETED'],
  ACTIVE: ['COMPLETED', 'REJECTED', 'DELETED'],
  COMPLETED: ['REJECTED', 'DELETED'],
  // Restoration lands on PENDING rather than the previous status: the row does not record where
  // it came from, and inventing a destination would be a guess written to an audit log.
  REJECTED: ['PENDING', 'DELETED'],
  DELETED: ['PENDING'],
};

export function isLegalTransition(from: RecommendationStatus, to: RecommendationStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Fail closed: a status is staff-only until it is named here. */
export const PATRON_VISIBLE_STATUSES: RecommendationStatus[] = [
  'PENDING',
  'ACCEPTED',
  'ACTIVE',
  'COMPLETED',
];
```

- [ ] **Step 4: Run, then commit**

```bash
git add apps/api/src/moderation/transitions.ts apps/api/src/moderation/transitions.spec.ts
git commit -m "feat(api): lifecycle transition map"
```

---

## Task 2: Flag and ModerationAction models

**Files:**

- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260813000000_moderation_lifecycle/migration.sql`

**Interfaces:**

- Produces: models `Flag`, `ModerationAction`; enums `FlagStatus`, `FlagReason`, `ModerationActionType`; back-relations on `Recommendation` and `User`.

- [ ] **Step 1: Add the enums and models**

```prisma
enum FlagStatus {
  OPEN
  RESOLVED
  DISMISSED
}

enum FlagReason {
  SPAM
  HARASSMENT
  SEXUAL_CONTENT
  OFF_TOPIC
  DUPLICATE
  OTHER
}

enum ModerationActionType {
  EDIT
  DELETE
  RESTORE
  STATUS_CHANGE
  FLAG_RESOLVED
  FLAG_DISMISSED
}

model Flag {
  id               String     @id @default(uuid()) @db.Uuid
  recommendationId String     @db.Uuid
  flaggedByUserId  String     @db.Uuid
  reason           FlagReason
  note             String?
  status           FlagStatus @default(OPEN)
  resolvedByUserId String?    @db.Uuid
  resolvedAt       DateTime?
  createdAt        DateTime   @default(now())
  updatedAt        DateTime   @updatedAt

  recommendation Recommendation @relation(fields: [recommendationId], references: [id], onDelete: Cascade)
  flaggedBy      User           @relation("FlagAuthor", fields: [flaggedByUserId], references: [id], onDelete: Cascade)
  resolvedBy     User?          @relation("FlagResolver", fields: [resolvedByUserId], references: [id])

  // One flag per person per entry: flag count is a priority signal (design §6.6), and without
  // this it measures one user's persistence rather than several users' agreement.
  @@unique([recommendationId, flaggedByUserId])
  @@index([recommendationId])
  @@index([flaggedByUserId])
  @@index([resolvedByUserId])
}

model ModerationAction {
  id               String               @id @default(uuid()) @db.Uuid
  recommendationId String               @db.Uuid
  actorUserId      String               @db.Uuid
  action           ModerationActionType
  note             String?
  // Before/after snapshots of the fields the action touched (design §3). Json rather than
  // columns: the shape differs per action type, and an audit row is never queried by field.
  before           Json?
  after            Json?
  createdAt        DateTime             @default(now())

  recommendation Recommendation @relation(fields: [recommendationId], references: [id], onDelete: Cascade)
  // No cascade from the actor: deleting a moderator's account must not erase the record of what
  // they did. This is the one relation in the schema where the audit outlives the user.
  actor          User           @relation("ModerationActor", fields: [actorUserId], references: [id], onDelete: Restrict)

  @@index([recommendationId, createdAt(sort: Desc)])
  @@index([actorUserId])
}
```

Add to `Recommendation`: `flags Flag[]` and `moderationActions ModerationAction[]`.
Add to `User`: `flagsRaised Flag[] @relation("FlagAuthor")`, `flagsResolved Flag[] @relation("FlagResolver")`, `moderationActions ModerationAction[] @relation("ModerationActor")`.

- [ ] **Step 2: Generate the migration**

```bash
cd apps/api && pnpm prisma migrate dev --name moderation_lifecycle
```

- [ ] **Step 3: Add the review-queue index by hand**

The queue orders by open-flag count then age. Prisma cannot express a partial index, and the
existing board index leads with `upvoteCount`, which the queue does not sort on. Append to the
generated `migration.sql`:

```sql
-- Serves the review queue: staff read one creator's entries oldest-first, including the
-- statuses the board index's consumers never ask for.
CREATE INDEX "Recommendation_creatorId_createdAt_idx"
  ON "Recommendation" ("creatorId", "createdAt" ASC);

-- Open flags are the queue's driver and a small fraction of all flags.
CREATE INDEX "Flag_open_idx" ON "Flag" ("recommendationId") WHERE "status" = 'OPEN';
```

Re-apply with `pnpm prisma migrate reset --force` so the hand edit is exercised, not just the
generated part.

- [ ] **Step 4: Commit**

```bash
git add apps/api/prisma
git commit -m "feat(api): flag and moderation-action models"
```

---

## Task 3: Status transitions, audited

**Files:**

- Create: `apps/api/src/moderation/moderation-actions.service.ts`, `apps/api/src/moderation/dto/change-status.dto.ts`
- Modify: `apps/api/src/recommendations/recommendations.controller.ts`, `apps/api/src/recommendations/recommendations.module.ts`
- Test: `apps/api/test/lifecycle.e2e-spec.ts`

**Interfaces:**

- Consumes: `isLegalTransition` (Task 1), `CreatorAccessGuard`, `RequireCapability` (Plan 03).
- Produces: `ModerationActionsService.changeStatus(creatorId, recommendationId, actorUserId, to, note?)` → `{ id, status }`; endpoint `POST /creators/:slug/recommendations/:id/status`.

- [ ] **Step 1: Write the failing test**

```ts
it('moves a pending entry to accepted and audits it', async () => {
  const res = await staff.post(`/creators/${slug}/recommendations/${rec.id}/status`)
    .send({ status: 'ACCEPTED' })
    .expect(200);
  expect(res.body.status).toBe('ACCEPTED');

  const actions = await prisma.moderationAction.findMany({ where: { recommendationId: rec.id } });
  expect(actions).toHaveLength(1);
  expect(actions[0]).toMatchObject({ action: 'STATUS_CHANGE', actorUserId: staffUser.id });
  expect(actions[0].before).toEqual({ status: 'PENDING' });
  expect(actions[0].after).toEqual({ status: 'ACCEPTED' });
});

it('refuses an illegal transition with 409 and writes no audit row', async () => {
  await staff.post(`/creators/${slug}/recommendations/${rec.id}/status`)
    .send({ status: 'COMPLETED' })
    .expect(409);
  expect(await prisma.moderationAction.count({ where: { recommendationId: rec.id } })).toBe(0);
  const after = await prisma.recommendation.findUniqueOrThrow({ where: { id: rec.id } });
  expect(after.status).toBe('PENDING');
});

it('refuses a patron, however much they pledge', async () => {
  await patron.post(`/creators/${slug}/recommendations/${rec.id}/status`)
    .send({ status: 'ACCEPTED' })
    .expect(403);
});

it('refuses an entry belonging to another creator', async () => {
  // The guard proved access to *this* creator; the id is not scoped by it.
  await staff.post(`/creators/${slug}/recommendations/${otherCreatorRec.id}/status`)
    .send({ status: 'ACCEPTED' })
    .expect(404);
});

it('rejects an unknown status before touching the database', async () => {
  await staff.post(`/creators/${slug}/recommendations/${rec.id}/status`)
    .send({ status: 'BANANA' })
    .expect(400);
});
```

- [ ] **Step 2: Run it, watch it fail**

- [ ] **Step 3: Implement the DTO**

```ts
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { RecommendationStatus } from '@prisma/client';

export class ChangeStatusDto {
  @IsEnum(RecommendationStatus)
  status!: RecommendationStatus;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
```

- [ ] **Step 4: Implement the service**

```ts
async changeStatus(
  creatorId: string,
  recommendationId: string,
  actorUserId: string,
  to: RecommendationStatus,
  note?: string,
) {
  // Scoped by creatorId: the guard proved access to this creator, not to this id.
  const current = await this.prisma.recommendation.findFirst({
    where: { id: recommendationId, creatorId },
    select: { id: true, status: true },
  });
  if (!current) throw new NotFoundException();
  if (!isLegalTransition(current.status, to)) {
    throw new ConflictException(`Cannot move from ${current.status} to ${to}`);
  }

  // One transaction: an audit log that can be missing the row for a change that happened is
  // not an audit log, and a status write outside it is exactly how that gap appears.
  return this.prisma.$transaction(async (tx) => {
    const updated = await tx.recommendation.update({
      where: { id: recommendationId },
      data: { status: to },
      select: { id: true, status: true },
    });
    await tx.moderationAction.create({
      data: {
        recommendationId,
        actorUserId,
        action:
          to === 'DELETED'
            ? 'DELETE'
            : current.status === 'DELETED' || current.status === 'REJECTED'
              ? 'RESTORE'
              : 'STATUS_CHANGE',
        note: note ?? null,
        before: { status: current.status },
        after: { status: to },
      },
    });
    return updated;
  });
}
```

- [ ] **Step 5: Wire the endpoint**

```ts
@Post(':id/status')
@RequireCapability('MODERATE')
@UseGuards(CreatorAccessGuard, SessionGuard)
changeStatus(
  @CurrentCreator() creator: ResolvedCreator,
  @CurrentUser() user: CurrentUserPayload,
  @Param('id', ParseUUIDPipe) id: string,
  @Body() dto: ChangeStatusDto,
) {
  return this.moderationActions.changeStatus(creator.id, id, user.id, dto.status, dto.note);
}
```

- [ ] **Step 6: Run and commit**

---

## Task 4: Board visibility — hidePendingFromPublic and staff view

**Files:**

- Modify: `apps/api/src/recommendations/recommendations.service.ts`
- Test: `apps/api/test/board-visibility.e2e-spec.ts`

**Interfaces:**

- Consumes: `PATRON_VISIBLE_STATUSES` (Task 1).
- Produces: `list()` gains `viewer: { userId: string | null; isStaff: boolean }` in place of the bare `viewerUserId`.

- [ ] **Step 1: Write the failing test**

```ts
it('hides rejected and deleted entries from patrons', async () => {
  const res = await patron.get(`/creators/${slug}/recommendations`).expect(200);
  expect(res.body.items.map((i) => i.id)).not.toContain(rejected.id);
  expect(res.body.items.map((i) => i.id)).not.toContain(deleted.id);
});

it('shows rejected and deleted entries to staff', async () => {
  const res = await staff.get(`/creators/${slug}/recommendations`).expect(200);
  expect(res.body.items.map((i) => i.id)).toEqual(
    expect.arrayContaining([rejected.id, deleted.id]),
  );
});

it('hides pending entries from other patrons when the toggle is on', async () => {
  await setPolicy({ hidePendingFromPublic: true });
  const res = await otherPatron.get(`/creators/${slug}/recommendations`).expect(200);
  expect(res.body.items.map((i) => i.id)).not.toContain(pendingFromPatron.id);
});

it('still shows a patron their own pending entry when the toggle is on', async () => {
  // Otherwise the submit form returns success and the board comes back empty, which reads as
  // a bug to the person who just used it.
  await setPolicy({ hidePendingFromPublic: true });
  const res = await patron.get(`/creators/${slug}/recommendations`).expect(200);
  expect(res.body.items.map((i) => i.id)).toContain(pendingFromPatron.id);
});

it('shows pending entries to everyone when the toggle is off', async () => {
  await setPolicy({ hidePendingFromPublic: false });
  const res = await otherPatron.get(`/creators/${slug}/recommendations`).expect(200);
  expect(res.body.items.map((i) => i.id)).toContain(pendingFromPatron.id);
});

it('hides pending entries from an anonymous visitor when the toggle is on', async () => {
  // The "own submission" carve-out keys on user id; anonymous has none and must not match all.
  await setPolicy({ hidePendingFromPublic: true });
  const res = await anon.get(`/creators/${slug}/recommendations`).expect(200);
  expect(res.body.items.map((i) => i.id)).not.toContain(pendingFromPatron.id);
});
```

- [ ] **Step 2: Run it, watch it fail**

- [ ] **Step 3: Implement the visibility clause**

```ts
/**
 * Staff read the whole board including the bin; patrons read only the visible statuses, minus
 * pending entries when the creator hides them — except their own, which they must still see.
 */
private visibilityWhere(
  policy: { hidePendingFromPublic: boolean },
  viewer: { userId: string | null; isStaff: boolean },
): Prisma.RecommendationWhereInput {
  if (viewer.isStaff) return {};
  if (!policy.hidePendingFromPublic) return { status: { in: PATRON_VISIBLE_STATUSES } };
  return {
    OR: [
      { status: { in: PATRON_VISIBLE_STATUSES.filter((s) => s !== 'PENDING') } },
      // Anonymous has no id, and `submittedByUserId: null` matches nothing — which is the
      // behaviour we want, not a filter that falls open.
      ...(viewer.userId ? [{ status: 'PENDING' as const, submittedByUserId: viewer.userId }] : []),
    ],
  };
}
```

Thread it into `list()`'s `where`, and pass the viewer through from the controller (which already
has `@CurrentViewer()`). The upvote path keeps its own stricter check — a patron must not be able
to upvote an entry they cannot see, and `HIDDEN_STATUSES` there is already correct.

- [ ] **Step 4: Run and commit**

---

## Task 5: Community flags

**Files:**

- Create: `apps/api/src/moderation/flags.service.ts`, `apps/api/src/moderation/dto/create-flag.dto.ts`
- Modify: `apps/api/src/recommendations/recommendations.controller.ts`
- Test: `apps/api/test/flags.e2e-spec.ts`

**Interfaces:**

- Produces: `FlagsService.raise(creatorId, recommendationId, userId, reason, note?)` → `{ id, status, duplicate }`; endpoint `POST /creators/:slug/recommendations/:id/flags`.

Flagging requires `VIEW`, not `SUBMIT`: anyone who can read the board can report what is on it,
and gating reports behind a pledge tier means the cheapest accounts see the worst content with no
recourse.

- [ ] **Step 1: Write the failing test**

```ts
it('lets any viewer flag an entry', async () => {
  const res = await patron.post(`/creators/${slug}/recommendations/${rec.id}/flags`)
    .send({ reason: 'SPAM', note: 'link farm' })
    .expect(201);
  expect(res.body).toMatchObject({ status: 'OPEN', duplicate: false });
});

it('returns the existing flag rather than erroring on a repeat', async () => {
  await patron.post(`/creators/${slug}/recommendations/${rec.id}/flags`)
    .send({ reason: 'SPAM' }).expect(201);
  const res = await patron.post(`/creators/${slug}/recommendations/${rec.id}/flags`)
    .send({ reason: 'HARASSMENT' }).expect(200);
  expect(res.body.duplicate).toBe(true);
  expect(await prisma.flag.count({ where: { recommendationId: rec.id } })).toBe(1);
});

it('refuses an anonymous flag', async () => {
  await anon.post(`/creators/${slug}/recommendations/${rec.id}/flags`)
    .send({ reason: 'SPAM' }).expect(401);
});

it('refuses a flag on another creator entry', async () => {
  await patron.post(`/creators/${slug}/recommendations/${otherCreatorRec.id}/flags`)
    .send({ reason: 'SPAM' }).expect(404);
});

it('runs the note through moderation', async () => {
  // The note is attacker-chosen text shown to a moderator. Design §6.5 puts every user string
  // through the pipeline, and the review queue is not an exemption.
  await patron.post(`/creators/${slug}/recommendations/${rec.id}/flags`)
    .send({ reason: 'OTHER', note: 'this is shit' }).expect(400);
});
```

- [ ] **Step 2: Run it, watch it fail**

- [ ] **Step 3: Implement**

The service scopes the recommendation by `creatorId`, reviews the note via `ModerationService`,
then upserts on `(recommendationId, flaggedByUserId)` catching `P2002` for the concurrent case,
exactly as `submit()` does.

- [ ] **Step 4: Wire the endpoint with `@RequireCapability('VIEW')` plus `SessionGuard`, run and commit**

---

## Task 6: The review queue, redaction and flag resolution

**Files:**

- Create: `apps/api/src/moderation/review-queue.service.ts`, `apps/api/src/moderation/moderation.controller.ts`, `apps/api/src/moderation/dto/redact.dto.ts`, `apps/api/src/moderation/dto/resolve-flag.dto.ts`
- Test: `apps/api/test/review-queue.e2e-spec.ts`

**Interfaces:**

- Produces:
  - `GET /creators/:slug/review-queue` → `{ items: Array<{ id, customTitle, description, status, openFlagCount, flags: [{ reason, note, flaggedBy }], submittedBy, createdAt }>, nextCursor }`
  - `PATCH /creators/:slug/recommendations/:id` → redact `{ customTitle?, description? }`
  - `PATCH /creators/:slug/flags/:flagId` → `{ status: 'RESOLVED' | 'DISMISSED' }`

All three require `MODERATE`.

- [ ] **Step 1: Write the failing test**

```ts
it('orders flagged entries ahead of unflagged ones', async () => {
  const res = await staff.get(`/creators/${slug}/review-queue`).expect(200);
  expect(res.body.items[0].id).toBe(flaggedTwice.id);
  expect(res.body.items[0].openFlagCount).toBe(2);
  expect(res.body.items[1].id).toBe(flaggedOnce.id);
});

it('includes rejected and deleted entries so the bin is reachable', async () => {
  const res = await staff.get(`/creators/${slug}/review-queue`).expect(200);
  expect(res.body.items.map((i) => i.id)).toEqual(expect.arrayContaining([deleted.id]));
});

it('refuses a patron', async () => {
  await patron.get(`/creators/${slug}/review-queue`).expect(403);
});

it('redacts text and keeps the original only in the audit log', async () => {
  await staff.patch(`/creators/${slug}/recommendations/${rec.id}`)
    .send({ description: '[removed]' }).expect(200);

  const row = await prisma.recommendation.findUniqueOrThrow({ where: { id: rec.id } });
  expect(row.description).toBe('[removed]');
  const action = await prisma.moderationAction.findFirstOrThrow({
    where: { recommendationId: rec.id, action: 'EDIT' },
  });
  expect(action.before).toMatchObject({ description: 'original text' });
});

it('resolves a flag and records who resolved it', async () => {
  await staff.patch(`/creators/${slug}/flags/${flag.id}`)
    .send({ status: 'RESOLVED' }).expect(200);
  const row = await prisma.flag.findUniqueOrThrow({ where: { id: flag.id } });
  expect(row).toMatchObject({ status: 'RESOLVED', resolvedByUserId: staffUser.id });
  expect(row.resolvedAt).not.toBeNull();
});

it('refuses to resolve a flag belonging to another creator board', async () => {
  await staff.patch(`/creators/${slug}/flags/${otherCreatorFlag.id}`)
    .send({ status: 'RESOLVED' }).expect(404);
});

it('runs redacted text through moderation', async () => {
  await staff.patch(`/creators/${slug}/recommendations/${rec.id}`)
    .send({ customTitle: 'this is shit' }).expect(400);
});
```

- [ ] **Step 2: Run, watch fail, implement**

The queue counts open flags with `_count: { select: { flags: { where: { status: 'OPEN' } } } }`
and sorts in SQL by that count descending then `createdAt` ascending. Redaction reads the row,
writes the new values and the `EDIT` action with a `before` snapshot of exactly the fields the
request changed — in one transaction, like every other mutation here.

Flag resolution scopes by joining through `recommendation.creatorId`, since a flag id alone says
nothing about which board it belongs to.

- [ ] **Step 3: Run and commit**

---

## Task 7: The moderation dashboard

**Files:**

- Create: `apps/web/src/routes/ReviewQueue.tsx`, `apps/web/src/components/StatusControl.tsx`, `apps/web/src/components/FlagButton.tsx`
- Modify: `apps/web/src/routes/CreatorBoard.tsx`, `apps/web/src/components/RecommendationCard.tsx`, `apps/web/src/api/hooks.ts`, `apps/web/src/App.tsx`
- Test: `apps/web/src/routes/ReviewQueue.test.tsx`, `apps/web/src/components/StatusControl.test.tsx`, `apps/web/src/components/FlagButton.test.tsx`

**Interfaces:**

- Produces: route `/c/:slug/review`; `useReviewQueue(slug)`; status control and flag control on cards.

- [ ] **Step 1: Write the failing tests**

Board grouping: entries render under **Suggestions**, **Accepted**, **Now Playing** and
**Completed** headings by status (design §7); an empty column does not render a heading.

`StatusControl`: renders only when `capabilities.moderate`; offers exactly the legal next
statuses for the entry's current status; posting moves the card to the new column; a 409 shows
"That move is not allowed" and leaves the card where it was.

`FlagButton`: renders for any signed-in viewer; hidden when signed out; opens a reason picker
with a labelled note field; on success shows "Reported — thanks"; a `duplicate: true` response
shows "You already reported this" rather than a second confirmation.

`ReviewQueue`: shows flag reasons and notes per entry; shows a "no items to review" empty state;
a 403 renders "you do not moderate this board" rather than crashing; the redact form posts the
PATCH and updates the text in place.

- [ ] **Step 2: Implement, then run and commit**

---

## Task 8: End-to-end journeys and verification

**Files:**

- Modify: `e2e/tests/journey.spec.ts`, `e2e/stub/patreon-stub.mjs` (a staff identity), `README.md`

- [ ] **Step 1: Add the journeys**

1. A patron submits; a moderator signs in, accepts it, and the patron sees it under **Accepted**.
2. A patron flags an entry; the moderator finds it in the review queue and dismisses the flag.
3. A moderator redacts a description; the patron's board shows the redacted text.
4. A moderator deletes an entry; it disappears from the patron board and remains in the queue.
5. With `hidePendingFromPublic` on, a second patron does not see the first patron's pending entry
   while the submitter still does.

- [ ] **Step 2: Full verification**

```bash
pnpm -r typecheck && pnpm -r test && pnpm format:check
docker compose -f docker-compose.e2e.yml up -d --build && pnpm --filter e2e e2e
```

- [ ] **Step 3: Document the lifecycle in the README, then commit**

---

## Self-Review

**Spec coverage (design §6.5–6.6, §7):**

- Lifecycle `PENDING→ACCEPTED→ACTIVE→COMPLETED`, `REJECTED`, soft `DELETED` → Task 1, 3. ✅
- "Only `CreatorStaff` change status; every transition audited" → Task 3, `MODERATE` + transactional audit. ✅
- `hidePendingFromPublic` toggle → Task 4. ✅
- Patron board columns Suggestions/Accepted/Now Playing/Completed → Task 7. ✅
- Community flags → creator + mod review queue → Task 5, 6. ✅
- "resolve/dismiss, edit/redact text, delete, reject, restore — all written to `ModerationAction`" → Tasks 3, 6. ✅
- "multiple flags raise priority" → Task 6's ordering by open flag count. ✅
- `ModerationResult`, `AbuseRecord`, `Notification`, `CreatorNote`, kanban drag, bulk actions, per-IP bucket → **deferred**, each with its reason in Scope. ✅

**Known risks:**

1. **`hidePendingFromPublic` still lets an upvote confirm a hidden entry exists.** The upvote path
   filters on `HIDDEN_STATUSES`, which does not include `PENDING`, so a patron holding an id can
   upvote an entry the board would not show them. It leaks existence, not content. Closing it
   means threading the policy into the upvote path too — worth doing, but it is a distinct change
   from the read model and belongs with the abuse work that also touches that path.
2. **No auto-hide on flag threshold** (design §6.6 calls it optional). A brigade can keep content
   visible until a human acts. Auto-hide without an abuse score is trivially weaponised into a
   censorship tool, which is why it waits for `AbuseRecord`.
3. **Restoration always lands on `PENDING`.** A completed entry that is deleted and restored
   re-enters the queue rather than returning to completed. Recording the prior status on the row
   would fix it and is a one-column change, but inventing a "previous status" from an audit log
   scan is the kind of cleverness that goes wrong quietly.
4. **The review queue's flag-count sort is computed per query.** Fine at Phase 1 volumes; a
   denormalised `openFlagCount` on the row is the answer if a board ever has tens of thousands of
   flagged entries, and it carries the same drift risk `upvoteCount` already carries.
