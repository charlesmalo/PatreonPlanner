# Staff Invite & Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a creator hand moderation power to someone else — and take it back — without anyone writing rows into the database by hand.

**Architecture:** `MANAGE_STAFF` becomes a fourth capability in the same pure `can()` resolver, and `Viewer` gains the `staffRole` that resolver has needed since Plan 03 left a note saying so. Invitations are opaque single-use tokens stored as SHA-256 hashes, exactly as sessions are — the creator shares the link out of band, because there is no notification system and inventing one here would be a second plan wearing this one's clothes.

**Tech Stack:** NestJS 10, Prisma 5.20, Postgres, React 18 (all existing; no new dependencies).

## Global Constraints

- **Moderation power still derives only from a `CreatorStaff` row** (design §3). This plan changes who can *create* those rows, never what they mean.
- **A creator always has an owner.** Every path that removes staff must refuse to remove the last `OWNER`, or the board becomes unadministrable and no endpoint can fix it.
- **An invite token is a credential.** Stored hashed, compared in constant time, single-use, expiring — the same rules the session token already follows.
- **Consent is required.** Accepting an invite is an authenticated action by the invitee; nobody is made a moderator without doing something.
- **Generic errors to the caller** (design §9). An invalid, expired, used and unknown token all answer the same way, or the endpoint becomes a token oracle.

## Scope

**In scope:** the `MANAGE_STAFF` capability and `staffRole` on `Viewer`, a `StaffInvite` model, creating and revoking invites, accepting one, listing staff, removing staff, and the SPA for all of it.

**Out of scope — deliberately deferred, with the reason:**

- **Emailing the invite** → there is no notification or email infrastructure, and design §3's `Notification` model is itself deferred. The endpoint returns the link; the creator sends it however they already talk to their moderators.
- **Transferring ownership** → a different operation with different stakes (it removes the actor's own power irreversibly), and nothing in design §7 asks for it. The owner is set at claim time.
- **More than two roles** → `StaffRole` is `OWNER | MOD` and design §7 describes exactly those two. A third would need its own capability rows.
- **Per-role capability granularity** → every `MOD` gets the whole `MODERATE` capability. Splitting it (redact but not delete, say) is a product decision nobody has made.

## Decisions this plan settles

**`MANAGE_STAFF` is a capability, not an ad-hoc owner check.** `can()` is the one place authorization lives, and adding a fifth `if (creator.ownerUserId === userId)` scattered through controllers is how the rules drift. Plan 03's comment in `capability.ts` predicted this and asked for `staffRole`; this is where that debt is paid.

**Only an `OWNER` manages staff.** A `MOD` who could appoint mods could appoint an accomplice, and a `MOD` who could remove staff could remove the owner. Both are privilege escalation dressed as convenience.

**Invites are single-use tokens, and the plaintext is returned exactly once.** The row stores only a SHA-256 hash, so a database read cannot recover a live invite. This is the session-token pattern, and the reasoning is identical.

**Accepting is idempotent for the already-staffed.** Someone who is already a `MOD` and follows an invite again gets a success and the invite is consumed. Erroring would be technically truer and practically annoying.

**Removal takes a userId, not a staff-row id.** The caller knows who they want to remove; making them look up a join-row id first is an API that leaks its own schema. The composite unique `(creatorId, userId)` makes it exact.

---

## Task 1: The capability

**Files:**

- Modify: `apps/api/src/access/capability.ts`, `apps/api/src/access/creator-access.guard.ts`
- Test: `apps/api/test/capability.e2e-spec.ts` (extend)

**Interfaces:**

- `Capability` gains `'MANAGE_STAFF'`.
- `Viewer.staffRole: 'OWNER' | 'MOD' | null` replaces `isStaff`.

- [ ] **Step 1: Write the failing test**

```ts
it('lets an owner manage staff', () => {
  expect(can('MANAGE_STAFF', { ...viewer, staffRole: 'OWNER' }, policy)).toBe(true);
});

it('refuses a mod', () => {
  // A mod who could appoint mods could appoint an accomplice; one who could remove staff could
  // remove the owner. Both are privilege escalation dressed as convenience.
  expect(can('MANAGE_STAFF', { ...viewer, staffRole: 'MOD' }, policy)).toBe(false);
});

it('refuses a patron however much they pledge', () => {
  expect(can('MANAGE_STAFF', { ...patron, staffRole: null }, policy)).toBe(false);
});

it('refuses an unauthenticated viewer', () => {
  expect(can('MANAGE_STAFF', anonymous, policy)).toBe(false);
});

it('still gives a mod MODERATE', () => {
  expect(can('MODERATE', { ...viewer, staffRole: 'MOD' }, policy)).toBe(true);
});

it('still lets any staff bypass the patron gates', () => {
  expect(can('SUBMIT', { ...anonymousButStaff, staffRole: 'MOD' }, policy)).toBe(true);
});
```

- [ ] **Step 2: Implement**

`isStaff` becomes `staffRole !== null` internally; every existing behaviour is preserved. The guard
selects `role` alongside the staff row it already loads.

- [ ] **Step 3: Run the whole suite** — this touches the resolver every guard uses, so a regression
here is a regression everywhere. Commit.

---

## Task 2: The StaffInvite model

**Files:**

- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260818000000_staff_invite/migration.sql`

```prisma
model StaffInvite {
  id            String    @id @default(uuid()) @db.Uuid
  creatorId     String    @db.Uuid
  // SHA-256 of the opaque token. The plaintext is returned once and never stored, so a database
  // read cannot recover a live invite — the same rule the session token follows.
  tokenHash     String    @unique
  role          StaffRole
  invitedByUserId String  @db.Uuid
  expiresAt     DateTime
  // Set when consumed. Single-use: an invite that could be replayed is a standing credential.
  acceptedAt    DateTime?
  acceptedByUserId String? @db.Uuid
  revokedAt     DateTime?
  createdAt     DateTime  @default(now())

  creator    Creator @relation(fields: [creatorId], references: [id], onDelete: Cascade)
  invitedBy  User    @relation("InviteAuthor", fields: [invitedByUserId], references: [id], onDelete: Cascade)
  acceptedBy User?   @relation("InviteAcceptor", fields: [acceptedByUserId], references: [id])

  @@index([creatorId])
  @@index([expiresAt])
}
```

A check constraint the schema cannot express:

```sql
-- An invite cannot appoint an owner: ownership is set at claim time and transferring it is a
-- different operation with different stakes.
ALTER TABLE "StaffInvite" ADD CONSTRAINT "StaffInvite_role_is_mod" CHECK ("role" = 'MOD');
```

- [ ] **Steps: add the model, hand-write the migration, `migrate deploy`, `migrate reset --force`, commit**

---

## Task 3: Creating, listing and revoking invites

**Files:**

- Create: `apps/api/src/staff/staff.service.ts`, `apps/api/src/staff/staff.controller.ts`, `apps/api/src/staff/staff.module.ts`
- Test: `apps/api/test/staff.int-spec.ts`

**Interfaces:**

- `POST /creators/:slug/staff/invites` → `{ token, expiresAt }`, `MANAGE_STAFF`
- `GET /creators/:slug/staff` → `{ members: [...], invites: [...] }`, `MANAGE_STAFF`
- `DELETE /creators/:slug/staff/invites/:id` → 204, `MANAGE_STAFF`

- [ ] **Step 1: Write the failing test**

```ts
it('returns the token exactly once and stores only its hash', async () => {
  const res = await owner.post(`/creators/${slug}/staff/invites`).expect(201);
  expect(res.body.token).toMatch(/^[A-Za-z0-9_-]{32,}$/);
  const row = await prisma.staffInvite.findFirstOrThrow();
  expect(row.tokenHash).not.toBe(res.body.token);
  expect(row.tokenHash).toBe(sha256(res.body.token));
});

it('never returns the token again', async () => {
  await owner.post(`/creators/${slug}/staff/invites`).expect(201);
  const list = await owner.get(`/creators/${slug}/staff`).expect(200);
  expect(JSON.stringify(list.body)).not.toMatch(/token/i);
});

it('refuses a mod', async () => {
  await mod.post(`/creators/${slug}/staff/invites`).expect(403);
});

it('refuses a patron and an anonymous visitor', async () => { ... });

it('lists members with their roles and pending invites', async () => { ... });

it('omits accepted, revoked and expired invites from the pending list', async () => { ... });

it('revokes an invite', async () => { ... });

it('refuses to revoke an invite belonging to another creator', async () => { ... });

it('caps how many invites can be outstanding', async () => {
  // An unbounded generator is an unbounded set of live credentials.
  for (let i = 0; i < MAX_PENDING_INVITES; i += 1) await owner.post(...).expect(201);
  await owner.post(...).expect(409);
});
```

- [ ] **Step 2: Run, watch fail, implement, commit**

---

## Task 4: Accepting an invite

**Files:**

- Modify: `apps/api/src/staff/staff.service.ts`, `apps/api/src/staff/staff.controller.ts`
- Test: `apps/api/test/staff.int-spec.ts` (extend)

**Interfaces:**

- `POST /staff/invites/accept` with `{ token }` → `{ creator: { slug, displayName }, role }`

Mounted outside `creators/:slug` on purpose: the invitee does not know which creator the token is
for until they redeem it, and requiring them to name it first would make the token less useful than
the link it arrived in.

- [ ] **Step 1: Write the failing test**

```ts
it('makes the accepter a moderator', async () => {
  const { token } = (await owner.post(`/creators/${slug}/staff/invites`)).body;
  const res = await stranger.post('/staff/invites/accept').send({ token }).expect(201);
  expect(res.body).toMatchObject({ role: 'MOD', creator: { slug } });
  expect(await staffRoleOf(strangerId)).toBe('MOD');
});

it('consumes the invite', async () => {
  const { token } = (await owner.post(`/creators/${slug}/staff/invites`)).body;
  await stranger.post('/staff/invites/accept').send({ token }).expect(201);
  await otherStranger.post('/staff/invites/accept').send({ token }).expect(404);
});

it('answers the same for invalid, expired, revoked and unknown tokens', async () => {
  // Anything else makes the endpoint a token oracle.
  const responses = await Promise.all([...]);
  expect(new Set(responses.map((r) => r.status))).toEqual(new Set([404]));
  expect(new Set(responses.map((r) => r.body.message))).toHaveProperty('size', 1);
});

it('refuses an anonymous accepter', async () => {
  // Consent means an authenticated action; there is nobody to appoint otherwise.
  await anon.post('/staff/invites/accept').send({ token }).expect(403); // CSRF first
});

it('is idempotent for someone who is already staff', async () => {
  await stranger.post('/staff/invites/accept').send({ token: first }).expect(201);
  await stranger.post('/staff/invites/accept').send({ token: second }).expect(201);
  expect(await prisma.creatorStaff.count({ where: { userId: strangerId } })).toBe(1);
});

it('does not demote an owner who accepts a mod invite', async () => {
  // The composite unique makes this an update, and an unguarded one would strip the creator of
  // their own board.
  await owner.post('/staff/invites/accept').send({ token }).expect(201);
  expect(await staffRoleOf(ownerId)).toBe('OWNER');
});

it('rejects a malformed token without touching the database', async () => { ... });
```

- [ ] **Step 2: Run, watch fail, implement, commit**

---

## Task 5: Removing staff

**Files:**

- Modify: `apps/api/src/staff/staff.service.ts`, `apps/api/src/staff/staff.controller.ts`
- Test: `apps/api/test/staff.int-spec.ts` (extend)

**Interfaces:**

- `DELETE /creators/:slug/staff/:userId` → 204, `MANAGE_STAFF`

- [ ] **Step 1: Write the failing test**

```ts
it('removes a moderator', async () => {
  await owner.delete(`/creators/${slug}/staff/${modId}`).expect(204);
  expect(await staffRoleOf(modId)).toBeNull();
});

it('refuses to remove the last owner', async () => {
  // Otherwise the board is unadministrable and no endpoint can fix it.
  await owner.delete(`/creators/${slug}/staff/${ownerId}`).expect(409);
  expect(await staffRoleOf(ownerId)).toBe('OWNER');
});

it('refuses a mod removing anyone', async () => {
  await mod.delete(`/creators/${slug}/staff/${otherModId}`).expect(403);
});

it('refuses to remove someone from another creator board', async () => {
  await owner.delete(`/creators/${slug}/staff/${foreignModId}`).expect(404);
});

it('404s a user who is not staff', async () => { ... });

it('revokes the removed moderator power immediately', async () => {
  // The capability is read per request from the row, so removal must take effect at once.
  await mod.get(`/creators/${slug}/review-queue`).expect(200);
  await owner.delete(`/creators/${slug}/staff/${modId}`).expect(204);
  await mod.get(`/creators/${slug}/review-queue`).expect(403);
});
```

The last one is the assertion that matters: it proves removal is not merely a row change.

- [ ] **Step 2: Run, watch fail, implement, commit**

---

## Task 6: The SPA

**Files:**

- Create: `apps/web/src/routes/StaffPage.tsx`, `apps/web/src/routes/AcceptInvite.tsx`
- Modify: `apps/web/src/App.tsx`, `apps/web/src/routes/CreatorBoard.tsx`, `apps/web/src/api/hooks.ts`, `apps/web/src/api/types.ts`
- Test: `apps/web/src/routes/StaffPage.test.tsx`, `apps/web/src/routes/AcceptInvite.test.tsx`

- [ ] **Step 1: Write the failing tests**

Staff page (`/c/:slug/staff`): lists members with roles; a "Invite a moderator" control produces a
copyable link shown once with a warning that it will not be shown again; removing asks nothing but
does refuse the owner (the control is absent, and the API refuses anyway); a 403 renders "only the
creator can manage moderators"; names render as text.

Accept page (`/invite/:token`): signed out shows a sign-in prompt that returns here; signed in shows
the creator's name and an accept button; success links to the board; a used or unknown token shows
one generic message.

- [ ] **Step 2: Implement, run, commit**

---

## Task 7: End-to-end and verification

**Files:**

- Modify: `e2e/tests/journey.spec.ts`, `README.md`

- [ ] **Step 1: Add the journey**

An owner invites, a second identity accepts the link and can then work the review queue, and after
the owner removes them the queue refuses.

- [ ] **Step 2: Full verification**

```bash
pnpm -r typecheck && pnpm -r test && pnpm format:check
docker-compose -f docker-compose.e2e.yml up -d --build && pnpm --filter e2e e2e
```

- [ ] **Step 3: Document staff management in the README, commit**

---

## Self-Review

**Spec coverage (design §7 "Creator admin — Staff", §3, §4):**

- "invite/assign/remove mods (creates verified `CreatorStaff` rows)" → Tasks 3–5. ✅
- Moderation power derives only from a `CreatorStaff` row → unchanged; this plan only changes who writes them. ✅
- `StaffRole` reaching the capability resolver, as `capability.ts` has asked for since Plan 03 → Task 1. ✅
- Emailing invites, ownership transfer, more roles, finer capabilities → **deferred**, each with its reason in Scope. ✅

**Known risks:**

1. **The invite link is a bearer credential in whatever channel the creator uses.** Anyone who sees it can become a moderator of that board until it is used or expires. Single-use and expiry bound it; nothing else does, because there is no second factor to bind it to.
2. **Removal does not revoke the removed moderator's sessions.** They lose `MODERATE` on the next request because the capability is resolved per request — but any long-lived page they still have open keeps rendering staff controls until it refetches. The server refuses, so this is cosmetic.
3. **Nothing audits staff changes.** `ModerationAction` is per recommendation, so an appointment has nowhere to go. Who invited whom is recoverable from `StaffInvite.invitedByUserId`, but a removal leaves no trace at all — worth fixing when there is an audit surface that is not entry-scoped.
4. **An owner can invite themselves a second account.** Nothing about that is prevented, and nothing about it is worse than the owner simply acting.
