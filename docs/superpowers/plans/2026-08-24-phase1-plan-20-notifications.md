# In-App Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tell a patron when something happens to the entry they submitted, and tell staff when something on their board needs looking at — without email, push, or any paid service.

**Architecture:** A `Notification` row per user per event, written **in the same transaction as the event that caused it**, carrying a denormalised payload rather than a foreign key. Design §12 puts email and push out of Phase 1, so the SPA polls a small unread count and renders the list from `type` + `payload`.

**Tech Stack:** NestJS 10, Prisma 5.20, Postgres 16, React 18 + Vite, Jest + Testcontainers, Vitest + React Testing Library.

## Global Constraints

- Free tooling only — no paid APIs or hosted services (standing user constraint). This rules out email and push for Phase 1 regardless of what design §12 says, and it says the same thing.
- Hand-written migrations under `apps/api/prisma/migrations/`.
- Every creator-scoped query filters on `creatorId`; every user-scoped query filters on the session user's id.
- No new dependencies. Polling with the existing fetch layer, not a websocket.

## Decisions this plan settles

1. **The notification is written in the event's transaction.** The same reasoning `ModerationActionsService` already carries for its audit row: a notification for a transition that got rolled back is a lie, and a transition with no notification is a silent one. Emitting after the fact, or from a job, produces both.
2. **The payload is denormalised, not a foreign key.** "Your suggestion *Cowboy Bebop* was accepted" has to keep saying that after the entry is deleted, retitled by a moderator, or moved to a status the reader can no longer see. Joining at read time would either 404 the row or quietly re-render it with facts the reader was never told — and a `Recommendation` join would also have to re-apply board visibility to avoid leaking, which is a lot of machinery to end up with a worse message.
3. **Never notify the actor of their own action.** A moderator moving an entry they submitted themselves gets nothing; a staff member flagging an entry is not told about their own flag.
4. **Staff fan-out is inline, one row each.** A board has an owner and a handful of mods. A job queue for a fan-out of five is machinery with its own failure modes, and it would break decision 1.
5. **Two triggers only:** an entry changing status, and a flag being raised. These are the two the design calls out (§7 lifecycle, §6.6 "notifies creator + verified mods"). Everything else waits until there is a reason.

## Scope

**In:** `Notification` model + migration; `NotificationsService.emit`; the two triggers; `GET /notifications`, `GET /notifications/unread-count`, `POST /notifications/read`; a bell with an unread badge and a list in the SPA.

**Out, with reasons:**
- *Email and push.* Design §12 defers them, and every provider worth using costs money.
- *Staff-invite notifications.* An invite is delivered as a link the inviter sends; the invitee has no account relationship with the board yet, so there is no row to attach a notification to until they accept.
- *Abuse-strike notifications.* The user already learns about a strike synchronously — the submission that earned it fails with the reason. A second asynchronous copy of the same news is noise.
- *Timeline-note notifications.* Notes are read on the entry, and a board that posts scheduling notes weekly would drown the list.
- *Websockets / server-sent events.* Polling an integer is cheap; a persistent connection per reader is not, on free-tier hosting.
- *Preferences and mute.* Nothing to configure until there are more than two triggers.

## File Structure

- `apps/api/prisma/schema.prisma` — `Notification` + `NotificationType` enum.
- `apps/api/prisma/migrations/20260824000000_notification/migration.sql`
- `apps/api/src/notifications/notifications.service.ts` — `emit` (transaction-aware), `list`, `unreadCount`, `markRead`.
- `apps/api/src/notifications/notifications.controller.ts` — the three endpoints.
- `apps/api/src/notifications/notifications.module.ts`
- `apps/api/src/moderation/moderation-actions.service.ts` — emit on transition.
- `apps/api/src/moderation/flags.service.ts` — emit to staff on a raised flag.
- `apps/api/test/notifications.int-spec.ts`
- `apps/web/src/api/types.ts`, `apps/web/src/api/hooks.ts` — `Notification`, `useNotifications`.
- `apps/web/src/components/NotificationBell.tsx` + test.
- `apps/web/src/components/Layout.tsx` — mount the bell.

---

### Task 1: The model and the service

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260824000000_notification/migration.sql`
- Create: `apps/api/src/notifications/notifications.service.ts`, `.module.ts`
- Test: `apps/api/test/notifications.int-spec.ts`

**Interfaces:**
- Produces:
  ```ts
  type NotificationPayload = {
    recommendationId: string;
    title: string;
    creatorSlug: string;
    creatorName: string;
    status?: RecommendationStatus;
    reason?: FlagReason;
  };
  emit(tx: Prisma.TransactionClient, rows: Array<{
    userId: string; creatorId: string; type: NotificationType; payload: NotificationPayload;
  }>): Promise<void>;
  list(userId: string, cursor?: string, limit?: number): Promise<{ items: Notification[]; nextCursor: string | null }>;
  unreadCount(userId: string): Promise<number>;
  markRead(userId: string, ids?: string[]): Promise<number>;
  ```

- [ ] **Step 1: Write the failing test**

```ts
it('stores a notification for the recipient only', async () => {
  await service.emit(prisma, [row({ userId: alice.id })]);
  expect(await service.unreadCount(alice.id)).toBe(1);
  expect(await service.unreadCount(bob.id)).toBe(0);
});

it('never returns another user notifications', async () => {
  await service.emit(prisma, [row({ userId: alice.id })]);
  const { items } = await service.list(bob.id);
  expect(items).toEqual([]);
});

it('marks only the requested rows read, and only the caller own', async () => {
  await service.emit(prisma, [row({ userId: alice.id }), row({ userId: bob.id })]);
  const { items } = await service.list(alice.id);

  expect(await service.markRead(bob.id, [items[0].id])).toBe(0);
  expect(await service.unreadCount(alice.id)).toBe(1);
  expect(await service.markRead(alice.id, [items[0].id])).toBe(1);
  expect(await service.unreadCount(alice.id)).toBe(0);
});
```

- [ ] **Step 2: Run and verify it fails**

Run: `pnpm --filter @app/api test -- notifications`
Expected: FAIL — `prisma.notification` is undefined.

- [ ] **Step 3: Schema**

```prisma
enum NotificationType {
  ENTRY_STATUS_CHANGED
  ENTRY_FLAGGED
}

model Notification {
  id        String           @id @default(uuid()) @db.Uuid
  userId    String           @db.Uuid
  // Kept so a board's notifications go when the board does, and so the SPA can link back.
  creatorId String           @db.Uuid
  type      NotificationType
  // A snapshot, not a join: the message has to keep being true after the entry it describes is
  // deleted, renamed, or moved somewhere this reader can no longer see.
  payload   Json
  readAt    DateTime?
  createdAt DateTime         @default(now())

  user    User    @relation(fields: [userId], references: [id], onDelete: Cascade)
  creator Creator @relation(fields: [creatorId], references: [id], onDelete: Cascade)

  @@index([userId, createdAt(sort: Desc), id(sort: Desc)])
}
```

Add `notifications Notification[]` to `User` and `Creator`.

- [ ] **Step 4: Migration**

```sql
CREATE TYPE "NotificationType" AS ENUM ('ENTRY_STATUS_CHANGED', 'ENTRY_FLAGGED');

CREATE TABLE "Notification" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "creatorId" UUID NOT NULL,
    "type" "NotificationType" NOT NULL,
    "payload" JSONB NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_creatorId_fkey"
    FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The list is keyset-paginated newest first, which is the only way it is ever read.
CREATE INDEX "Notification_userId_createdAt_id_idx"
    ON "Notification"("userId", "createdAt" DESC, "id" DESC);

-- The badge asks for this on every poll, and it is a small fraction of the table.
CREATE INDEX "Notification_unread_idx" ON "Notification"("userId") WHERE "readAt" IS NULL;
```

- [ ] **Step 5: Service**

```ts
export const NOTIFICATION_PAGE_SIZE = 20;

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Takes the caller's transaction rather than reaching for its own client: a notification for a
   * transition that rolled back is a lie, and a transition nobody was told about is a silent one.
   * Emitting outside the event's transaction produces both, depending on which side fails.
   */
  async emit(tx: Prisma.TransactionClient, rows: EmitRow[]): Promise<void> {
    if (rows.length === 0) return;
    await tx.notification.createMany({
      data: rows.map((row) => ({ ...row, payload: row.payload as Prisma.InputJsonValue })),
    });
  }

  /** Keyset rather than offset: the list grows at the head, and offset pages would repeat rows. */
  async list(userId: string, cursor?: string, limit = NOTIFICATION_PAGE_SIZE) {
    const items = await this.prisma.notification.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const page = items.slice(0, limit);
    return { items: page, nextCursor: items.length > limit ? page[page.length - 1].id : null };
  }

  unreadCount(userId: string): Promise<number> {
    return this.prisma.notification.count({ where: { userId, readAt: null } });
  }

  /** Scoped by userId as well as id: an id alone says nothing about whose notification it is. */
  async markRead(userId: string, ids?: string[]): Promise<number> {
    const { count } = await this.prisma.notification.updateMany({
      where: { userId, readAt: null, ...(ids ? { id: { in: ids } } : {}) },
      data: { readAt: new Date() },
    });
    return count;
  }
}
```

- [ ] **Step 6: Run tests** — `pnpm --filter @app/api test -- notifications`, expect PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/prisma apps/api/src/notifications apps/api/test
git commit -m "feat(notifications): notification model and service"
```

---

### Task 2: The triggers

**Files:**
- Modify: `apps/api/src/moderation/moderation-actions.service.ts`, `apps/api/src/moderation/flags.service.ts`
- Test: `apps/api/test/notifications.int-spec.ts`

**Interfaces:** Consumes `NotificationsService.emit` from Task 1.

- [ ] **Step 1: Write the failing tests**

```ts
it('tells the submitter when their entry changes status', async () => {
  await actions.changeStatus(creatorId, rec.id, moderator.id, 'ACCEPTED');
  const { items } = await notifications.list(submitter.id);
  expect(items).toHaveLength(1);
  expect(items[0].type).toBe('ENTRY_STATUS_CHANGED');
  // Denormalised: the message has to survive the entry being deleted.
  expect(items[0].payload).toMatchObject({ title: 'Cowboy Bebop', status: 'ACCEPTED' });
});

it('says nothing when a moderator moves their own entry', async () => {
  const own = await submit(moderator.id);
  await actions.changeStatus(creatorId, own.id, moderator.id, 'ACCEPTED');
  expect(await notifications.unreadCount(moderator.id)).toBe(0);
});

it('writes no notification when the transition is rejected', async () => {
  // Emitted in the transaction, so a conflict leaves nothing behind.
  await expect(actions.changeStatus(creatorId, rec.id, moderator.id, 'COMPLETED')).rejects.toThrow();
  expect(await notifications.unreadCount(submitter.id)).toBe(0);
});

it('tells the owner and every mod when an entry is flagged', async () => {
  await flags.raise(creatorId, rec.id, patron.id, 'SPAM');
  expect(await notifications.unreadCount(owner.id)).toBe(1);
  expect(await notifications.unreadCount(mod.id)).toBe(1);
  expect(await notifications.unreadCount(patron.id)).toBe(0);
});

it('does not tell a moderator about their own flag', async () => {
  await flags.raise(creatorId, rec.id, mod.id, 'SPAM');
  expect(await notifications.unreadCount(mod.id)).toBe(0);
  expect(await notifications.unreadCount(owner.id)).toBe(1);
});

it('does not notify twice for a repeated flag', async () => {
  await flags.raise(creatorId, rec.id, patron.id, 'SPAM');
  await flags.raise(creatorId, rec.id, patron.id, 'SPAM');
  expect(await notifications.unreadCount(owner.id)).toBe(1);
});
```

- [ ] **Step 2: Run and verify they fail** — expect 0 notifications everywhere.

- [ ] **Step 3: Status-change trigger**

In `changeStatus`, widen the initial lookup to carry what the payload needs, then emit inside the existing transaction, after the audit row:

```ts
const current = await this.prisma.recommendation.findFirst({
  where: { id: recommendationId, creatorId },
  select: {
    id: true,
    status: true,
    submittedByUserId: true,
    customTitle: true,
    creator: { select: { slug: true, displayName: true } },
  },
});
```

```ts
// Not the actor: a moderator who moves their own entry already knows.
if (current.submittedByUserId !== actorUserId) {
  await this.notifications.emit(tx, [
    {
      userId: current.submittedByUserId,
      creatorId,
      type: 'ENTRY_STATUS_CHANGED',
      payload: {
        recommendationId,
        title: current.customTitle,
        creatorSlug: current.creator.slug,
        creatorName: current.creator.displayName,
        status: to,
      },
    },
  ]);
}
```

- [ ] **Step 4: Flag trigger**

`raise` currently creates the flag outside a transaction. Wrap the create and the fan-out together, so a duplicate flag — which returns early — cannot leave a second round of notifications behind:

```ts
const staff = await this.prisma.creatorStaff.findMany({
  where: { creatorId, userId: { not: userId } },
  select: { userId: true },
});
const owner = await this.prisma.creator.findUniqueOrThrow({
  where: { id: creatorId },
  select: { ownerUserId: true, slug: true, displayName: true },
});
// The owner is not a CreatorStaff row, and a mod may also be the flagger — dedupe both.
const recipients = [...new Set([owner.ownerUserId, ...staff.map((s) => s.userId)])].filter(
  (id) => id !== userId,
);
```

```ts
const flag = await this.prisma.$transaction(async (tx) => {
  const created = await tx.flag.create({ ... });
  await this.notifications.emit(
    tx,
    recipients.map((id) => ({
      userId: id,
      creatorId,
      type: 'ENTRY_FLAGGED' as const,
      payload: { recommendationId, title: rec.customTitle, creatorSlug: owner.slug, creatorName: owner.displayName, reason },
    })),
  );
  return created;
});
```

The P2002 catch stays where it is and still returns the standing flag with no emission.

- [ ] **Step 5: Run tests** — expect PASS.

- [ ] **Step 6: Mutation-check** — remove the actor check, remove the emit from inside the transaction (emit after it commits instead), and remove the `userId: { not: userId }` filter. Each must produce a failing test.

- [ ] **Step 7: Commit**

```bash
git commit -am "feat(notifications): notify on status change and flags"
```

---

### Task 3: The API and the bell

**Files:**
- Create: `apps/api/src/notifications/notifications.controller.ts`
- Modify: `apps/api/src/app.module.ts`
- Create: `apps/web/src/components/NotificationBell.tsx` + `.test.tsx`
- Modify: `apps/web/src/components/Layout.tsx`, `apps/web/src/api/types.ts`, `apps/web/src/api/hooks.ts`
- Test: `apps/api/test/notifications.int-spec.ts`, `apps/web/src/components/NotificationBell.test.tsx`

- [ ] **Step 1: Write the failing API tests**

```ts
it('requires a session', async () => {
  await request(app).get('/api/v1/notifications').expect(401);
});

it('returns only the caller notifications', async () => {
  const res = await request(app).get('/api/v1/notifications').set('Cookie', aliceCookie).expect(200);
  expect(res.body.items.map((n) => n.id)).toEqual([aliceNotification.id]);
});

it('refuses to mark another user notification read', async () => {
  await request(app)
    .post('/api/v1/notifications/read')
    .set('Cookie', bobCookie).set('x-csrf-token', bobCsrf)
    .send({ ids: [aliceNotification.id] })
    .expect(200);
  expect(await service.unreadCount(alice.id)).toBe(1);
});
```

- [ ] **Step 2: Controller**

```ts
@Controller('notifications')
@UseGuards(SessionGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@CurrentUser() user: CurrentUserPayload, @Query() query: ListNotificationsDto) {
    return this.notifications.list(user.userId, query.cursor);
  }

  @Get('unread-count')
  async unreadCount(@CurrentUser() user: CurrentUserPayload) {
    return { count: await this.notifications.unreadCount(user.userId) };
  }

  @Post('read')
  @HttpCode(HttpStatus.OK)
  async markRead(@CurrentUser() user: CurrentUserPayload, @Body() dto: MarkReadDto) {
    return { updated: await this.notifications.markRead(user.userId, dto.ids) };
  }
}
```

`MarkReadDto`: `@IsOptional() @IsArray() @IsUUID('4', { each: true }) ids?: string[]` — absent means all.

- [ ] **Step 3: Write the failing bell test**

```tsx
it('shows the unread count and marks read when opened', async () => {
  renderWithClient(<NotificationBell />, { notifications: [unread('Cowboy Bebop', 'ACCEPTED')] });

  expect(await screen.findByRole('button', { name: /1 unread notification/i })).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: /notification/i }));

  expect(await screen.findByText(/Cowboy Bebop/)).toBeInTheDocument();
  expect(screen.getByText(/accepted/i)).toBeInTheDocument();
  await waitFor(() => expect(markReadCalls).toHaveLength(1));
});

it('renders nothing for a signed-out reader', () => {
  renderWithClient(<NotificationBell />, { user: null });
  expect(screen.queryByRole('button', { name: /notification/i })).not.toBeInTheDocument();
});
```

- [ ] **Step 4: Bell component** — a button carrying `aria-label` with the count, a list rendered from `type` + `payload`, and a `POST /notifications/read` on open. Poll `unread-count` on an interval; follow the existing `hooks.ts` fetch conventions rather than adding a data library.

- [ ] **Step 5: Mount in `Layout.tsx`** beside the sign-out button, only when `user` is set.

- [ ] **Step 6: Run everything** — `pnpm -r test`, then `pnpm format:check`.

- [ ] **Step 7: Commit**

---

## Known risks

- **Polling interval versus free-tier quota.** Every signed-in reader asks for an integer on a timer. The count query is index-backed and tiny, but the interval is the knob that decides how much traffic the app makes at rest; start conservative (60s) rather than chatty.
- **No cap on rows per user.** A board that flags heavily could give a moderator thousands of notifications. The list is paginated so nothing breaks, but there is no retention policy, and adding one later means deciding what "read and old" is worth keeping.
- **A notification can outlive what it describes.** That is the point of decision 2, but it means a reader can click through to an entry that no longer exists. The link should degrade to the board rather than a 404 page.
- **The flag fan-out is inline.** Correct for a handful of staff; a board with a very large staff list would make the flag request slower in proportion. Nothing enforces a ceiling on staff size.
