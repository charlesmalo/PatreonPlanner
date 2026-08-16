# Theme Merging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a creator fold one theme into another, so the duplicates TMDB seeds ("sci-fi" and "science fiction") collapse into the one name they actually use.

**Architecture:** Merging is only half a feature unless the seeder is taught about it. Today a theme owns exactly one TMDB label via `Theme.sourceKey`, so deleting the loser frees its label and the very next enrichment pass re-creates the theme the creator just merged away. This plan moves that mapping into a `ThemeSource` table keyed by `(creatorId, sourceKey)`, letting one theme own many labels — which is what a merged theme *is*. Merge then moves the loser's labels and title assignments onto the winner and deletes the loser, in one transaction that locks both theme rows first — a transaction alone buys atomicity, not isolation, which cost three data-loss races found in review.

**Tech Stack:** NestJS 10, Prisma 5.20, Postgres 16, Jest + Testcontainers.

## Global Constraints

- Free tooling only — no paid APIs or hosted services (standing user constraint).
- Hand-written migrations under `apps/api/prisma/migrations/`, never `prisma migrate dev` autogeneration.
- Every creator-scoped query filters on `creatorId`; a theme id alone says nothing about which board owns it.
- Capability for theme curation is `MODERATE`, matching the existing rename and delete.

## Decisions this plan settles

1. **`Theme.sourceKey` becomes the `ThemeSource` table.** A merged theme legitimately answers to several TMDB labels. Keeping one nullable column and deleting the loser row loses that, and the loss is silent until the next enrichment pass resurrects the theme.
2. **The loser is deleted, not tombstoned.** The alternative — keeping the row with a `mergedIntoId` pointer — puts a `WHERE mergedIntoId IS NULL` on every theme query forever, and the day someone forgets it a merged theme reappears on a public board. Moving the labels to the winner keeps the correction in one place: the seeder.
3. **API only, no web UI.** Rename and delete are already API-only; adding a themes admin screen is its own piece of work and is not what makes merging correct.
4. **`ThemeSource.creatorId` is stored, not joined.** It duplicates `Theme.creatorId`, which is a real denormalisation risk, but the seeder's hot path is a point lookup by `(creatorId, sourceKey)` on every label of every title for every creator holding it, and making that a join to save a column is the wrong trade. The merge endpoint verifies both themes belong to the same creator before moving anything, which is the only writer that could make the two disagree.

## Scope

**In:** `ThemeSource` model + migration + backfill; seeder reworked onto it; `POST /creators/:slug/themes/:id/merge`.

**Out, with reasons:**
- *Merging more than two themes in one call.* Two at a time composes; a batch endpoint is a convenience with its own partial-failure semantics.
- *Undo.* Restoring the loser means remembering which assignments came from where, which is a history feature the schema has nowhere to put yet.
- *Automatic duplicate detection* (clustering "sci-fi" with "science fiction"). Deferred with theme clustering generally — it needs the embedding work to be load-bearing first, and a wrong automatic merge is destructive.

## File Structure

- `apps/api/prisma/schema.prisma` — add `ThemeSource`, drop `Theme.sourceKey`.
- `apps/api/prisma/migrations/20260823000000_theme_source/migration.sql` — create, backfill, drop column.
- `apps/api/src/intelligence/themes.service.ts` — `resolveTheme` reads and writes `ThemeSource`; new `merge()`.
- `apps/api/src/intelligence/dto/merge-theme.dto.ts` — `{ intoId: uuid }`.
- `apps/api/src/intelligence/themes.controller.ts` — the endpoint.
- `apps/api/test/themes.int-spec.ts` — extended.

---

### Task 1: Move the TMDB label mapping into `ThemeSource`

Behaviour-preserving on its own: seeding must do exactly what it does today, with the mapping stored somewhere a merge can move it.

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260823000000_theme_source/migration.sql`
- Modify: `apps/api/src/intelligence/themes.service.ts`
- Test: `apps/api/test/themes.int-spec.ts`

**Interfaces:**
- Produces: `ThemeSource { creatorId: string; sourceKey: string; themeId: string }`, PK `(creatorId, sourceKey)`.
- `ThemesService.seedFor(titleId, creatorId, labels)` — unchanged signature.

- [ ] **Step 1: Write the failing test**

```ts
it('records the TMDB label a theme was seeded from', async () => {
  await service.seedFor(title.id, creator.id, ['Animation']);
  const rows = await prisma.themeSource.findMany({ where: { creatorId: creator.id } });
  expect(rows).toHaveLength(1);
  expect(rows[0].sourceKey).toBe('animation');
});

it('remembers a label it had to resolve by slug collision', async () => {
  // The creator renamed "Animation" to "Anime", so the TMDB label "anime" collides on slug and
  // resolves to the existing theme. Recording that mapping is what stops the collision recurring
  // on every future pass.
  await service.seedFor(title.id, creator.id, ['Animation']);
  const theme = await prisma.theme.findFirstOrThrow({ where: { creatorId: creator.id } });
  await prisma.theme.update({ where: { id: theme.id }, data: { name: 'Anime', slug: 'anime' } });

  await service.seedFor(other.id, creator.id, ['Anime']);

  const keys = await prisma.themeSource.findMany({ where: { themeId: theme.id } });
  expect(keys.map((k) => k.sourceKey).sort()).toEqual(['anime', 'animation']);
});
```

- [ ] **Step 2: Run and verify it fails**

Run: `pnpm --filter @app/api test -- themes`
Expected: FAIL — `prisma.themeSource` is undefined.

- [ ] **Step 3: Schema**

```prisma
model ThemeSource {
  creatorId String @db.Uuid
  sourceKey String
  themeId   String @db.Uuid

  creator Creator @relation(fields: [creatorId], references: [id], onDelete: Cascade)
  theme   Theme   @relation(fields: [themeId], references: [id], onDelete: Cascade)

  @@id([creatorId, sourceKey])
  @@index([themeId])
}
```

Drop `sourceKey` and `@@unique([creatorId, sourceKey])` from `Theme`; add `sources ThemeSource[]` to `Theme` and `themeSources ThemeSource[]` to `Creator`.

- [ ] **Step 4: Migration**

```sql
CREATE TABLE "ThemeSource" (
    "creatorId" UUID NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "themeId" UUID NOT NULL,
    CONSTRAINT "ThemeSource_pkey" PRIMARY KEY ("creatorId", "sourceKey")
);

-- Backfill before the column goes away. The old unique index treated NULLs as distinct, so
-- themes a creator invented by hand have no label and simply get no row.
INSERT INTO "ThemeSource" ("creatorId", "sourceKey", "themeId")
SELECT "creatorId", "sourceKey", "id" FROM "Theme" WHERE "sourceKey" IS NOT NULL;

ALTER TABLE "ThemeSource" ADD CONSTRAINT "ThemeSource_creatorId_fkey"
    FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ThemeSource" ADD CONSTRAINT "ThemeSource_themeId_fkey"
    FOREIGN KEY ("themeId") REFERENCES "Theme"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "ThemeSource_themeId_idx" ON "ThemeSource"("themeId");

DROP INDEX "Theme_creatorId_sourceKey_key";
ALTER TABLE "Theme" DROP COLUMN "sourceKey";
```

- [ ] **Step 5: Rework `resolveTheme`**

```ts
private async resolveTheme(creatorId: string, label: string): Promise<string | null> {
  const sourceKey = themeSlug(label);
  if (sourceKey.length === 0) return null;

  const known = await this.prisma.themeSource.findUnique({
    where: { creatorId_sourceKey: { creatorId, sourceKey } },
    select: { themeId: true },
  });
  if (known) return known.themeId;

  const themeId = await this.themeForNewLabel(creatorId, label, sourceKey);
  if (!themeId) return null;

  // Recorded so the next pass is a point lookup rather than a collision to re-resolve, and so a
  // merge has something to move.
  await this.prisma.themeSource.upsert({
    where: { creatorId_sourceKey: { creatorId, sourceKey } },
    create: { creatorId, sourceKey, themeId },
    update: {},
  });
  return themeId;
}

/**
 * `Theme` is unique on slug per creator. A creator who renamed "Animation" to "Anime" owns the
 * `anime` slug, so the TMDB label "anime" collides. Their theme already means this label, so
 * attach to it rather than failing the title — a P2002 escaping here used to cost every
 * remaining label and every remaining creator their themes, permanently, because `enrichedAt`
 * is stamped regardless.
 */
private async themeForNewLabel(creatorId: string, label: string, slug: string) {
  try {
    const theme = await this.prisma.theme.create({
      data: { creatorId, name: label.trim(), slug },
      select: { id: true },
    });
    return theme.id;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const existing = await this.prisma.theme.findFirst({
        where: { creatorId, slug },
        select: { id: true },
      });
      return existing?.id ?? null;
    }
    throw error;
  }
}
```

- [ ] **Step 6: Run the whole theme suite**

Run: `pnpm --filter @app/api test -- themes`
Expected: PASS, including the pre-existing "does not resurrect a renamed theme" tests.

- [ ] **Step 7: Commit**

```bash
git add apps/api/prisma apps/api/src/intelligence apps/api/test
git commit -m "refactor(themes): store TMDB label mappings in ThemeSource"
```

---

### Task 2: The merge endpoint

**Files:**
- Create: `apps/api/src/intelligence/dto/merge-theme.dto.ts`
- Modify: `apps/api/src/intelligence/themes.service.ts`, `apps/api/src/intelligence/themes.controller.ts`
- Test: `apps/api/test/themes.int-spec.ts`

**Interfaces:**
- Consumes: `ThemeSource` from Task 1.
- Produces: `ThemesService.merge(creatorId: string, id: string, intoId: string): Promise<{ id: string; name: string }>`.

- [ ] **Step 1: Write the failing tests**

```ts
it('moves the losing theme\'s titles onto the winner', async () => {
  await service.merge(creator.id, scifi.id, scienceFiction.id);
  const links = await prisma.titleTheme.findMany({ where: { themeId: scienceFiction.id } });
  expect(links.map((l) => l.titleId).sort()).toEqual([titleA.id, titleB.id].sort());
});

it('does not resurrect the merged-away theme on the next enrichment pass', async () => {
  // The whole point. "sci-fi" was seeded from a TMDB label; if that label is left unclaimed the
  // next pass re-creates the theme the creator just folded away.
  await service.merge(creator.id, scifi.id, scienceFiction.id);
  await service.seedFor(titleC.id, creator.id, ['Sci-Fi']);

  const themes = await prisma.theme.findMany({ where: { creatorId: creator.id } });
  expect(themes).toHaveLength(1);
  expect(themes[0].id).toBe(scienceFiction.id);
  expect(await prisma.titleTheme.findMany({ where: { titleId: titleC.id } })).toHaveLength(1);
});

it('survives a title that carried both themes', async () => {
  await prisma.titleTheme.create({ data: { titleId: titleA.id, themeId: scienceFiction.id } });
  await service.merge(creator.id, scifi.id, scienceFiction.id);
  expect(await prisma.titleTheme.count({ where: { titleId: titleA.id } })).toBe(1);
});

it('refuses to merge a theme into itself', async () => {
  await expect(service.merge(creator.id, scifi.id, scifi.id)).rejects.toThrow(BadRequestException);
});

it('refuses a target on another creator\'s board', async () => {
  await expect(service.merge(creator.id, scifi.id, otherBoardTheme.id)).rejects.toThrow(
    NotFoundException,
  );
});

it('rejects a patron', async () => {
  await request(app.getHttpServer())
    .post(`/api/v1/creators/${creator.slug}/themes/${scifi.id}/merge`)
    .set('Cookie', patronCookie)
    .send({ intoId: scienceFiction.id })
    .expect(403);
});
```

- [ ] **Step 2: Run and verify they fail**

Run: `pnpm --filter @app/api test -- themes`
Expected: FAIL — `service.merge is not a function`.

- [ ] **Step 3: DTO**

```ts
import { IsUUID } from 'class-validator';

export class MergeThemeDto {
  @IsUUID()
  intoId!: string;
}
```

- [ ] **Step 4: Service**

```ts
async merge(creatorId: string, id: string, intoId: string): Promise<{ id: string; name: string }> {
  // Not a no-op to wave through: it means the caller confused the two ids, and silently
  // succeeding would have them believe a merge happened.
  if (id === intoId) throw new BadRequestException('A theme cannot be merged into itself');

  const [source, target] = await Promise.all([
    this.prisma.theme.findFirst({ where: { id, creatorId }, select: { id: true } }),
    this.prisma.theme.findFirst({ where: { id: intoId, creatorId }, select: { id: true, name: true } }),
  ]);
  // 404 rather than 403 for a theme on someone else's board: the id is not this caller's to
  // know about either way.
  if (!source || !target) throw new NotFoundException();

  await this.prisma.$transaction(async (tx) => {
    const links = await tx.titleTheme.findMany({ where: { themeId: id }, select: { titleId: true } });
    if (links.length > 0) {
      // skipDuplicates: a title tagged with both themes already satisfies the winner.
      await tx.titleTheme.createMany({
        data: links.map((link) => ({ titleId: link.titleId, themeId: intoId })),
        skipDuplicates: true,
      });
    }
    // Before the delete, which would cascade them away.
    await tx.themeSource.updateMany({ where: { themeId: id }, data: { themeId: intoId } });
    await tx.theme.delete({ where: { id } });
  });

  return target;
}
```

- [ ] **Step 5: Controller**

```ts
@Post(':id/merge')
@RequireCapability('MODERATE')
@UseGuards(CreatorAccessGuard, SessionGuard)
async merge(
  @CurrentCreator() creator: ResolvedCreator,
  @Param('id', ParseUUIDPipe) id: string,
  @Body() dto: MergeThemeDto,
) {
  return this.themes.merge(creator.id, id, dto.intoId);
}
```

Inject `ThemesService` into the controller's constructor.

- [ ] **Step 6: Run tests**

Run: `pnpm --filter @app/api test -- themes`
Expected: PASS.

- [ ] **Step 7: Mutation-check the tests**

Confirm each test fails when the behaviour it names is removed: drop the `themeSource.updateMany` (resurrection test must fail), drop `skipDuplicates` (both-themes test must fail), drop the self-merge guard, drop the `creatorId` filter on the target lookup. A test that stays green with its feature deleted is not a test.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src apps/api/test
git commit -m "feat(themes): merge one theme into another"
```

---

## Found in review (fixed)

The plan sold "inside one transaction" as what makes merge correct. A transaction buys atomicity, not isolation, and Prisma's default is read committed — so the plan was wrong about its own central claim. Three data-loss races followed from it, all reproduced against a real Postgres before fixing and all now pinned by tests that fail when the fix is reverted:

1. **Two merges chaining through the same theme** (X into Y, then Y into Z) both returned 200 while the second, working from a snapshot taken before the first one's writes landed, cascaded them away — the title left with no theme and the label mapping gone, which re-arms the exact resurrection this feature exists to prevent. Measured at **8 rounds in 10**. Fixed by locking both theme rows `FOR UPDATE` in id order — by id rather than by role, so X-into-Y and Y-into-X cannot deadlock — with the existence checks moved inside the transaction.
2. **A merge landing mid-enrichment.** `seedFor` resolves every label before writing any assignment, so a merge committing in that window either aborted the title with a foreign key violation — costing it every other label, permanently, since `enrichedAt` is stamped regardless — or had its rows quietly cascaded away. The same lock closes the second case (the seeder's insert needs a key-share lock on the row the merge holds); the first is handled by resolving once more, since the mapping now points at the winner.
3. **An unhandled P2002 on the label mapping.** Prisma compiles an upsert with an empty update to a select followed by an insert, not to `ON CONFLICT` — confirmed from its query log — so two enrichment passes reaching that line together left one holding a P2002 that cost the title all of its labels. Now an explicit create whose P2002 defers to whoever recorded the label first.

Also fixed: the e2e seed helper wrote `Theme.sourceKey` in raw SQL, which no compiler checks and which the migration would have broken in CI — the plan's File Structure never considered `e2e/`. And the merge copied every assignment through the application, which is a round trip per title inside a transaction with a five-second timeout; it is now one `INSERT … SELECT … ON CONFLICT DO NOTHING`.

## Known risks

- **The migration is not rolling-deploy safe.** The backfill and the `DROP COLUMN` are one atomic step, so the moment it commits, any old instance still running 500s on every read of `Theme` — Prisma names columns explicitly, so `sourceKey` is in every select. The correct shape is expand/contract: ship `ThemeSource` and dual-write, deploy, drop the column in a later migration. It is left as one migration deliberately, because nothing is deployed yet and there is no production data; **this becomes a real hazard the first time this app runs more than one instance,** and the split has to happen before then.
- **`ThemeSource.creatorId` can disagree with `Theme.creatorId`** if a future writer moves a theme between creators. Nothing does today; merge verifies both sides and its `updateMany` is scoped by creator as well as theme, but the constraint is not expressible in the schema.
- **The backfill is one-way.** Rolling back past this migration loses which label each theme came from, and the next enrichment pass would rebuild the mapping by colliding on slug — recoverable, but noisy.
- **Merge is destructive and has no undo.** A creator who merges the wrong pair re-creates the theme by hand and loses the assignments. Flagged in §3 as out of scope; worth an "are you sure" when the admin UI is built.
- **A merge can now lose a lock race and 404.** If the losing theme is folded away by another merge while this one waits, the caller gets a 404 rather than a 200. That is the correct answer — the theme is genuinely gone — but the admin UI should say so in those words rather than "not found".
