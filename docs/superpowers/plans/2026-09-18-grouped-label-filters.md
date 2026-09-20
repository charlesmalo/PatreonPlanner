# Grouped Label Filters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a reader combine filter labels into AND groups that are ORed together — `(A) OR (B AND Y)` — by dragging one chip onto another or choosing from a menu, and split them again at magnets.

**Architecture:** The filter is disjunctive normal form: `string[][]`, an array of groups, each an array of label ids. Today's flat filter is the degenerate case where every group has one member, so nothing an ungrouped reader does changes. The wire format extends the existing one — `themes=a|b,c` — and the Prisma query becomes `OR` across groups, `AND` within, composed **inside** the board's existing `AND` clause.

**Tech Stack:** NestJS + Prisma + class-validator (API), React + Vitest + Testing Library (web), Playwright (e2e).

**Spec:** `docs/superpowers/specs/2026-09-18-grouped-label-filters-design.md`

## Global Constraints

- **Depends on PR #131** (`feat/filter-labels-per-tab`), which is open and unmerged. It introduces multi-select OR, `themes=a,b`, `ThemeFilter` with `selected: string[] / onChange`, and `localThemes` / `rememberThemes`. **Do not start Task 1 until #131 is on `main`.**
- **Free tier only.** No new dependency without the engineer's approval (`01_PROJECT_RULES.md` §2).
- **Verification before any "done" claim:** `(cd apps/api && npx jest --config jest-e2e.json --runInBand)`, `(cd apps/web && npx vitest run)`, `pnpm -r typecheck`, `pnpm format:check`, `pnpm audit:all`. `pnpm -r test` does **not** typecheck.
- **Coverage:** aggregate gates plus a 75% per-file floor (`scripts/audit-coverage-floor.mjs`), enforced inside each package's `coverage` script.
- **Tests must fail for their own reason.** Verify by mutation: break the thing, confirm the test that names it goes red, restore.
- **Docker is `docker-compose`, hyphenated** on this machine. Never pipe a build into `tail` — you get `tail`'s exit code.
- **Two spec decisions are taken from its recommendations** and are reversible: the empty column names the filter (§4), and a group of one is unrepresentable (Open question 2).

---

### Task 1: Parse the label filter expression

**Files:**
- Create: `apps/api/src/recommendations/label-filter.ts`
- Test: `apps/api/test/label-filter.e2e-spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `parseLabelFilter(raw: string | undefined): string[][]`, `MAX_GROUPS = 8`, `MAX_GROUP_MEMBERS = 8`, `MAX_LABELS = 20`. Returns `[]` for absent/empty input. Throws `BadRequestException` on malformed input.

- [ ] **Step 1: Write the failing test**

```ts
import { BadRequestException } from '@nestjs/common';
import { parseLabelFilter } from '../src/recommendations/label-filter';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

describe('parseLabelFilter', () => {
  it('reads nothing as no filter', () => {
    expect(parseLabelFilter(undefined)).toEqual([]);
    expect(parseLabelFilter('')).toEqual([]);
  });

  it('reads a flat list as one group each, which is what it meant before groups existed', () => {
    expect(parseLabelFilter(`${A},${B}`)).toEqual([[A], [B]]);
  });

  it('reads a pipe as AND inside one group', () => {
    expect(parseLabelFilter(`${A}|${B},${C}`)).toEqual([[A, B], [C]]);
  });

  it('keeps the order it was given, so the filter reads as the chips look', () => {
    expect(parseLabelFilter(`${C},${A}|${B}`)).toEqual([[C], [A, B]]);
  });

  it('refuses a label that is not a uuid', () => {
    expect(() => parseLabelFilter('not-a-uuid')).toThrow(BadRequestException);
  });

  it('refuses an empty group, which no interaction can produce', () => {
    // `a|` and `a,,b` mean nothing; a client sending one has a bug, and quietly repairing it
    // makes that bug harder to find.
    expect(() => parseLabelFilter(`${A}|`)).toThrow(BadRequestException);
    expect(() => parseLabelFilter(`${A},,${B}`)).toThrow(BadRequestException);
  });

  it('refuses the same label twice anywhere in the expression', () => {
    // `(A AND B) OR (A)` is redundant — the second term can never add a row the first did not.
    expect(() => parseLabelFilter(`${A}|${B},${A}`)).toThrow(BadRequestException);
  });

  it('refuses more groups than the cap', () => {
    const many = Array.from({ length: 9 }, (_, i) => `${i}1111111-1111-4111-8111-111111111111`);
    expect(() => parseLabelFilter(many.join(','))).toThrow(BadRequestException);
  });

  it('refuses more members in a group than the cap', () => {
    const many = Array.from({ length: 9 }, (_, i) => `${i}2222222-2222-4222-8222-222222222222`);
    expect(() => parseLabelFilter(many.join('|'))).toThrow(BadRequestException);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails for the right reason**

Run: `cd apps/api && npx jest --config jest-e2e.json --runInBand label-filter`
Expected: FAIL — `Cannot find module '../src/recommendations/label-filter'`.

- [ ] **Step 3: Write the parser**

```ts
import { BadRequestException } from '@nestjs/common';

/**
 * The filter a reader has built, as disjunctive normal form: an OR of groups, each an AND of
 * labels. `a|b,c` is `(a AND b) OR (c)`.
 *
 * Parsed here rather than by class-validator because the value is nested — `each: true` reaches
 * one level and this is two. `board-query.ts` already decodes an opaque parameter and throws
 * `BadRequestException` when it will not read; this is the same job on the same request.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MAX_GROUPS = 8;
export const MAX_GROUP_MEMBERS = 8;
/** Every id is checked against the board before the query runs, so the list is bounded. */
export const MAX_LABELS = 20;

export function parseLabelFilter(raw: string | undefined): string[][] {
  if (!raw) return [];

  const groups = raw.split(',').map((group) => group.split('|'));
  const flat = groups.flat();

  if (groups.length > MAX_GROUPS) throw new BadRequestException('Too many label groups');
  if (flat.length > MAX_LABELS) throw new BadRequestException('Too many labels');
  for (const group of groups) {
    if (group.length > MAX_GROUP_MEMBERS) {
      throw new BadRequestException('Too many labels in one group');
    }
    // An empty member is `a|` or `a,,b`: no interaction produces either.
    if (group.some((id) => !UUID.test(id))) throw new BadRequestException('Invalid label');
  }
  if (new Set(flat).size !== flat.length) throw new BadRequestException('Duplicate label');

  return groups;
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd apps/api && npx jest --config jest-e2e.json --runInBand label-filter`
Expected: PASS, 8 tests.

- [ ] **Step 5: Verify by mutation**

Remove the duplicate check (`if (new Set(flat).size !== flat.length) …`), rerun, and confirm **only** "refuses the same label twice" fails. Restore it.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/recommendations/label-filter.ts apps/api/test/label-filter.e2e-spec.ts
git commit -m "feat(api): parse a grouped label filter expression"
```

---

### Task 2: Filter the board by groups

**Files:**
- Modify: `apps/api/src/recommendations/dto/list-recommendations.query.ts`
- Modify: `apps/api/src/recommendations/recommendations.controller.ts`
- Modify: `apps/api/src/recommendations/recommendations.service.ts`
- Test: `apps/api/test/board-nesting.int-spec.ts`

**Interfaces:**
- Consumes: `parseLabelFilter` from Task 1.
- Produces: the board endpoint accepts `?themes=a|b,c`. `RecommendationsService.list` takes `themeGroups?: string[][]` in place of `themeIds?: string[]`.

- [ ] **Step 1: Write the failing tests**

Add to `board-nesting.int-spec.ts`. The fixture already has `themeId` on `filmTitleId` and `otherThemeId` on `showTitleId` (from #131).

```ts
  it('matches every label in a group', async () => {
    // Both labels on the same entry, so an AND group finds it.
    await ctx.prisma.titleTheme.create({ data: { titleId: filmTitleId, themeId: otherThemeId } });
    const res = await board(patron, `&themes=${themeId}|${otherThemeId}`).expect(200);
    expect(res.body.items.map((i: { id: string }) => i.id)).toEqual([filmId]);
  });

  it('finds nothing when a group asks for labels no entry carries together', async () => {
    // The labels sit on different entries. This is the common case on a real board, and it must
    // be an honest empty page rather than an error.
    const res = await board(patron, `&themes=${themeId}|${otherThemeId}`).expect(200);
    expect(res.body.items).toEqual([]);
  });

  it('ORs across groups while ANDing inside them', async () => {
    const res = await board(patron, `&themes=${themeId},${otherThemeId}`).expect(200);
    const ids = res.body.items.map((i: { id: string }) => i.id);
    expect(ids).toContain(filmId);
    expect(ids).toContain(showId);
  });

  it('still applies visibility with a grouped filter', async () => {
    // The filter narrows the existing read model; it must not become a second place the
    // visibility rules live.
    await ctx.prisma.creatorPolicy.update({
      where: { creatorId },
      data: { hidePendingFromPublic: true },
    });
    const res = await board(otherPatron, `&themes=${themeId},${otherThemeId}`).expect(200);
    expect(res.body.items).toHaveLength(0);
  });

  it('refuses a malformed expression with 400, not 404', async () => {
    await board(patron, `&themes=${themeId}|`).expect(400);
  });
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `cd apps/api && npx jest --config jest-e2e.json --runInBand board-nesting`
Expected: FAIL — the pipe is currently read as part of a UUID, so these return 404 or the wrong rows.

- [ ] **Step 3: Take the raw string in the DTO**

Replace the `themes` field. The transform and `@IsUUID(..., { each: true })` from #131 go — Task 1's parser owns validation now, because it is the only place that can see the nesting.

```ts
  /**
   * The label filter, as `a|b,c` — `(a AND b) OR (c)`. Parsed by `parseLabelFilter`, which owns
   * every rule about its shape; a nested value is one level deeper than `each: true` reaches.
   */
  @IsOptional()
  @IsString()
  @Length(1, 1024)
  themes?: string;
```

- [ ] **Step 4: Parse in the controller**

```ts
      parseLabelFilter(query.themes),
```

with `import { parseLabelFilter } from './label-filter';` at the top.

- [ ] **Step 5: Apply the groups in the service**

Rename the parameter and replace both uses.

```ts
    themeGroups?: string[][],
```

```ts
    // Scoped to this creator: a label id from another board must not silently return an empty
    // page, which reads as "no matches here" rather than "that is not your label".
    //
    // Every id is checked, and one bad id refuses the whole filter rather than being dropped:
    // answering a narrower question than the caller asked, without saying so, is how a board
    // quietly lies about what it holds.
    const themeIds = (themeGroups ?? []).flat();
    if (themeIds.length > 0) {
      const found = await this.prisma.theme.findMany({
        where: { id: { in: themeIds }, creatorId: creator.id },
        select: { id: true },
      });
      if (found.length !== new Set(themeIds).size) throw new NotFoundException();
    }
```

```ts
        // OR across groups, AND inside them. Composed into the `AND` below rather than spread
        // beside it: this clause and the visibility filter both want an `OR` key, and spreading
        // let one overwrite the other — page one was correct and every page after it returned
        // rejected, deleted and other patrons' pending entries.
        AND: [
          visibilityWhere(creator, viewer),
          ...(themeGroups && themeGroups.length > 0
            ? [
                {
                  OR: themeGroups.map((group) => ({
                    AND: group.map((themeId) => ({
                      title: { themes: { some: { themeId } } },
                    })),
                  })),
                },
              ]
            : []),
```

Delete the old `...(themeIds … ? { title: … } : {})` spread above the `AND`.

- [ ] **Step 6: Run the API suite**

Run: `cd apps/api && npx jest --config jest-e2e.json --runInBand`
Expected: PASS, including every pre-existing flat-filter test from #131 untouched.

- [ ] **Step 7: Verify by mutation**

Move the new `OR` clause out of the `AND` array and spread it at the top level of `where` instead. Confirm **"still applies visibility with a grouped filter"** fails. Restore.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src
git add apps/api/test/board-nesting.int-spec.ts
git commit -m "feat(api): filter the board by grouped labels"
```

---

### Task 3: The client-side filter model

**Files:**
- Create: `apps/web/src/components/label-groups.ts`
- Test: `apps/web/src/components/label-groups.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `encodeGroups(groups: string[][]): string`, `decodeGroups(raw: string): string[][]`, `toggleLabel(groups: string[][], id: string): string[][]`, `combine(groups: string[][], id: string, intoIndex: number): string[][]`, `splitAt(groups: string[][], groupIndex: number, magnetIndex: number): string[][]`, `removeGroup(groups: string[][], groupIndex: number): string[][]`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import {
  combine,
  decodeGroups,
  encodeGroups,
  removeGroup,
  splitAt,
  toggleLabel,
} from './label-groups';

describe('label groups', () => {
  it('encodes groups as pipes inside commas', () => {
    expect(encodeGroups([['a', 'b'], ['c']])).toBe('a|b,c');
    expect(encodeGroups([])).toBe('');
  });

  it('decodes what it encodes', () => {
    expect(decodeGroups('a|b,c')).toEqual([['a', 'b'], ['c']]);
    expect(decodeGroups('')).toEqual([]);
  });

  it('drops malformed stored values rather than throwing during a render', () => {
    // This value comes from localStorage, which a reader can edit and an old build may have
    // written. A board that cannot paint because its filter is unreadable is worse than one that
    // paints unfiltered.
    // `a||b` reads as `a AND b` — the empty member is dropped, not treated as a group boundary.
    // A stored value this shape means somebody edited it by hand; keeping the labels it names is
    // friendlier than discarding the filter, and no interaction can produce it.
    expect(decodeGroups('a||b')).toEqual([['a', 'b']]);
    expect(decodeGroups(',,')).toEqual([]);
  });

  it('adds a label as its own group', () => {
    expect(toggleLabel([['a']], 'b')).toEqual([['a'], ['b']]);
  });

  it('removes a label from wherever it sits, and drops a group it empties', () => {
    expect(toggleLabel([['a', 'b'], ['c']], 'b')).toEqual([['a'], ['c']]);
    expect(toggleLabel([['a'], ['c']], 'c')).toEqual([['a']]);
  });

  it('combines a label into a group and takes it out of its old one', () => {
    // A label appears at most once across the whole filter: `(A AND B) OR (A)` is redundant.
    expect(combine([['a'], ['b']], 'b', 0)).toEqual([['a', 'b']]);
  });

  it('splits a group at the magnet, leaving what was left of it on the left', () => {
    expect(splitAt([['a', 'b', 'c']], 0, 0)).toEqual([['a'], ['b', 'c']]);
    expect(splitAt([['a', 'b', 'c']], 0, 1)).toEqual([['a', 'b'], ['c']]);
  });

  it('removes a whole group at once', () => {
    expect(removeGroup([['a', 'b'], ['c']], 0)).toEqual([['c']]);
  });

  it('never produces an empty group', () => {
    // A group of one is an ordinary chip; a group of none cannot be rendered at all.
    expect(encodeGroups(removeGroup([['a']], 0))).toBe('');
    expect(splitAt([['a']], 0, 0)).toEqual([['a']]);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd apps/web && npx vitest run src/components/label-groups.test.ts`
Expected: FAIL — cannot resolve `./label-groups`.

- [ ] **Step 3: Write the module**

```ts
/**
 * The filter a reader has built: an OR of groups, each an AND of labels.
 *
 * Pure and separate from the component because every one of these operations has an edge the UI
 * must not be allowed to produce — an empty group, a label in two places, a group of one that
 * should have become an ordinary chip.
 */
export function encodeGroups(groups: string[][]): string {
  return groups.map((group) => group.join('|')).join(',');
}

/**
 * Tolerant on purpose: this value comes from `localStorage`, which a reader can edit and an older
 * build may have written. Anything unreadable is dropped rather than thrown — a board that cannot
 * paint because its filter will not parse is worse than one that paints unfiltered.
 */
export function decodeGroups(raw: string): string[][] {
  return raw
    .split(',')
    .map((group) => group.split('|').filter((id) => id.length > 0))
    .filter((group) => group.length > 0);
}

/** Wherever it currently sits. Dropping the group it empties keeps `[[]]` unrepresentable. */
function without(groups: string[][], id: string): string[][] {
  return groups
    .map((group) => group.filter((member) => member !== id))
    .filter((group) => group.length > 0);
}

export function toggleLabel(groups: string[][], id: string): string[][] {
  return groups.some((group) => group.includes(id))
    ? without(groups, id)
    : [...groups, [id]];
}

export function combine(groups: string[][], id: string, intoIndex: number): string[][] {
  const target = groups[intoIndex];
  if (!target || target.includes(id)) return groups;
  // Removed first, so a label never appears twice across the filter — which means the target may
  // have shifted index, and `without` rebuilds every array so it is no longer the same object
  // either. It is found by a member that survives: `anchor` cannot be `id`, because a target
  // containing `id` returned above.
  const anchor = target[0];
  const remaining = without(groups, id);
  return remaining.map((group) => (group.includes(anchor) ? [...group, id] : group));
}

/** `magnetIndex` is the gap after that member: 0 splits between members 0 and 1. */
export function splitAt(groups: string[][], groupIndex: number, magnetIndex: number): string[][] {
  const group = groups[groupIndex];
  if (!group || magnetIndex < 0 || magnetIndex >= group.length - 1) return groups;
  return [
    ...groups.slice(0, groupIndex),
    group.slice(0, magnetIndex + 1),
    group.slice(magnetIndex + 1),
    ...groups.slice(groupIndex + 1),
  ];
}

export function removeGroup(groups: string[][], groupIndex: number): string[][] {
  return groups.filter((_, index) => index !== groupIndex);
}
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/web && npx vitest run src/components/label-groups.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Verify by mutation**

Two, because this function has already been wrong once:

1. Drop the `without(groups, id)` call and append to the target directly. Confirm **"combines a
   label into a group and takes it out of its old one"** fails. Restore.
2. Match the target by identity — `group === target` instead of `group.includes(anchor)`. Confirm
   the same test fails, and note *how*: the label is removed and never re-added, so the filter
   silently loses it. `without` rebuilds every array, so an identity check can never match. This
   is the bug the plan shipped with and the review caught before any code was written.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/label-groups.ts apps/web/src/components/label-groups.test.ts
git commit -m "feat(web): the grouped label filter model"
```

---

### Task 4: Render groups, with magnets and one ✕

**Files:**
- Modify: `apps/web/src/components/ThemeFilter.tsx`
- Modify: `apps/web/src/components/ThemeFilter.test.tsx`

**Interfaces:**
- Consumes: `splitAt`, `removeGroup`, `toggleLabel` from Task 3.
- Produces: `ThemeFilter` takes `selected: string[][]` and `onChange: (groups: string[][]) => void` in place of #131's `string[]`.

- [ ] **Step 1: Write the failing tests**

```ts
  it('joins a group with a magnet between each pair', () => {
    render(
      <ThemeFilter themes={themes} selected={[['t1', 't2']]} onChange={vi.fn()} />,
    );
    expect(
      screen.getByRole('button', { name: /split between anime and fantasy/i }),
    ).toBeInTheDocument();
  });

  it('splits a group at the magnet that was clicked', async () => {
    const onChange = vi.fn();
    render(<ThemeFilter themes={themes} selected={[['t1', 't2']]} onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: /split between anime and fantasy/i }));
    expect(onChange).toHaveBeenCalledWith([['t1'], ['t2']]);
  });

  it('gives a group one ✕ for the whole group, not one per label', () => {
    render(<ThemeFilter themes={themes} selected={[['t1', 't2']]} onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: /remove anime and fantasy filter/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^remove anime filter$/i })).not.toBeInTheDocument();
  });

  it('removes the whole group with that ✕', async () => {
    const onChange = vi.fn();
    render(
      <ThemeFilter themes={themes} selected={[['t1', 't2'], ['t3']]} onChange={onChange} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /remove anime and fantasy filter/i }));
    expect(onChange).toHaveBeenCalledWith([['t3']]);
  });

  it('keeps a single ✕ on an ungrouped label', () => {
    render(<ThemeFilter themes={themes} selected={[['t1']]} onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: /remove anime filter/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /split between/i })).not.toBeInTheDocument();
  });

  it('reads the whole expression aloud in words, not symbols', () => {
    render(
      <ThemeFilter themes={themes} selected={[['t1'], ['t2', 't3']]} onChange={vi.fn()} />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      /filtering by anime, or fantasy and documentary/i,
    );
  });
```

Add a third label to the fixture: `{ id: 't3', name: 'Documentary', entryCount: 2 }`.

- [ ] **Step 2: Run them and confirm they fail**

Run: `cd apps/web && npx vitest run src/components/ThemeFilter.test.tsx`
Expected: FAIL — `selected` is still `string[]`, so a `string[][]` renders nothing recognisable.

- [ ] **Step 3: Rewrite the chip list to render groups**

Replace the `<ul>` body. Each group is one `<li>`; its members are joined by magnet buttons; the group carries one ✕.

```tsx
      <ul className="mt-1.5 flex flex-wrap gap-2">
        {selected.map((group, groupIndex) => {
          const names = group.map((id) => byId.get(id)?.name ?? id);
          return (
            <li
              key={group.join('|')}
              className="flex items-center rounded-full border border-sky-500 bg-sky-50 py-0.5 pl-2.5 pr-1 text-xs dark:bg-sky-950"
            >
              {group.map((id, memberIndex) => (
                <span key={id} className="flex items-center">
                  {/* Text, never markup: label names are creator-editable. */}
                  {names[memberIndex]}
                  {memberIndex < group.length - 1 ? (
                    <button
                      type="button"
                      // Named for what it does and to which pair: "magnet" means nothing read aloud.
                      aria-label={`Split between ${names[memberIndex]} and ${names[memberIndex + 1]}`}
                      onClick={() => onChange(splitAt(selected, groupIndex, memberIndex))}
                      className="mx-1 rounded-full px-1 leading-none text-sky-700 hover:bg-sky-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-sky-300 dark:hover:bg-sky-900"
                    >
                      <span aria-hidden="true">●</span>
                    </button>
                  ) : null}
                </span>
              ))}
              <button
                type="button"
                aria-label={`Remove ${names.join(' and ')} filter`}
                onClick={() => onChange(removeGroup(selected, groupIndex))}
                className="ml-1 rounded-full px-1 leading-none text-slate-500 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-slate-400 dark:hover:text-slate-100"
              >
                <span aria-hidden="true">✕</span>
              </button>
            </li>
          );
        })}
      </ul>
```

Above it, keep an unselected-label row that calls `toggleLabel`. Add near the top of the component:

```tsx
  const byId = new Map(themes.map((theme) => [theme.id, theme]));
  const inFilter = new Set(selected.flat());
  const spoken = selected.map((group) => group.map((id) => byId.get(id)?.name ?? id).join(' and '));
```

and change the live region to:

```tsx
        {spoken.length === 0 ? 'No label filters.' : `Filtering by ${spoken.join(', or ')}.`}
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/web && npx vitest run src/components/ThemeFilter.test.tsx`
Expected: PASS.

- [ ] **Step 5: Place focus after each control destroys itself**

Spec §2. A magnet and a ✕ both remove the element that was clicked, so focus falls to `<body>`
and a keyboard reader is dropped at the top of the document — the same trap #131 hit.

Write the failing test first:

```ts
  it('keeps focus in the filter after splitting a group', async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <ThemeFilter themes={themes} selected={[['t1', 't2']]} onChange={onChange} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /split between anime and fantasy/i }));
    rerender(<ThemeFilter themes={themes} selected={[['t1'], ['t2']]} onChange={onChange} />);
    expect(screen.getByRole('button', { name: /remove anime filter/i })).toHaveFocus();
  });

  it('keeps focus in the filter after removing a group', async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <ThemeFilter themes={themes} selected={[['t1', 't2']]} onChange={onChange} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /remove anime and fantasy filter/i }));
    rerender(<ThemeFilter themes={themes} selected={[]} onChange={onChange} />);
    expect(screen.getByRole('button', { name: 'Anime' })).toHaveFocus();
  });
```

Then keep a ref per group id, as #131 does per label, and focus deliberately:

```tsx
  // The control that was clicked is gone by the next render, so focus is placed rather than left.
  // Splitting lands on the left-hand result; removing lands on the first member's toggle, which
  // returns to the label list and is always there.
  const groupRefs = useRef(new Map<string, HTMLButtonElement | null>());
  const toggles = useRef(new Map<string, HTMLButtonElement | null>());

  const afterSplit = (groups: string[][], groupIndex: number, magnetIndex: number) => {
    const next = splitAt(groups, groupIndex, magnetIndex);
    onChange(next);
    queueMicrotask(() => groupRefs.current.get(next[groupIndex].join('|'))?.focus());
  };

  const afterRemove = (groups: string[][], groupIndex: number) => {
    const first = groups[groupIndex][0];
    onChange(removeGroup(groups, groupIndex));
    queueMicrotask(() => toggles.current.get(first)?.focus());
  };
```

Call `afterSplit` / `afterRemove` from the magnet and ✕ handlers instead of calling `onChange`
directly, and attach `ref={(node) => groupRefs.current.set(group.join('|'), node)}` to each
group's ✕ button.

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `cd apps/web && npx vitest run src/components/ThemeFilter.test.tsx`
Expected: PASS.

- [ ] **Step 7: Verify by mutation**

Change `splitAt(selected, groupIndex, memberIndex)` to `splitAt(selected, groupIndex, 0)`. Confirm the second magnet case in **"splits a group at the magnet that was clicked"** fails when extended to a three-member group. Restore.

Then delete the `queueMicrotask` in `afterRemove` and confirm **"keeps focus in the filter after removing a group"** fails. Restore.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/ThemeFilter.tsx apps/web/src/components/ThemeFilter.test.tsx
git commit -m "feat(web): render label groups with magnets and one remove"
```

---

### Task 5: Combine from a menu

**Files:**
- Modify: `apps/web/src/components/ThemeFilter.tsx`
- Modify: `apps/web/src/components/ThemeFilter.test.tsx`

**Interfaces:**
- Consumes: `combine` from Task 3.
- Produces: nothing new.

- [ ] **Step 1: Write the failing tests**

```ts
  it('offers to combine a group with each of the others', async () => {
    render(
      <ThemeFilter themes={themes} selected={[['t1'], ['t2']]} onChange={vi.fn()} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /combine anime with/i }));
    expect(screen.getByRole('menuitem', { name: 'Fantasy' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Anime' })).not.toBeInTheDocument();
  });

  it('combines into the chosen group', async () => {
    const onChange = vi.fn();
    render(<ThemeFilter themes={themes} selected={[['t1'], ['t2']]} onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: /combine anime with/i }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Fantasy' }));
    expect(onChange).toHaveBeenCalledWith([['t2', 't1']]);
  });

  it('offers no combine control when only one group is filtering', () => {
    render(<ThemeFilter themes={themes} selected={[['t1']]} onChange={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /combine/i })).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `cd apps/web && npx vitest run src/components/ThemeFilter.test.tsx`
Expected: FAIL — no combine control exists.

- [ ] **Step 3: Add the menu**

Inside each group's `<li>`, before the ✕, and only when `selected.length > 1`. Follow `StatusControl`'s menu shape — a trigger with `aria-haspopup="menu"` and a `role="menu"` list.

```tsx
              {selected.length > 1 ? (
                <GroupCombineMenu
                  label={names.join(' and ')}
                  options={selected
                    .map((other, index) => ({ index, name: other.map((id) => byId.get(id)?.name ?? id).join(' and ') }))
                    .filter((option) => option.index !== groupIndex)}
                  onChoose={(intoIndex) => onChange(combine(selected, group[0], intoIndex))}
                />
              ) : null}
```

with, at the foot of the file:

```tsx
/**
 * The accessible half of combining. Drag is the shortcut and does nothing from a keyboard or on
 * touch — `drag.ts` says so, and entry grouping already answers it the same way.
 */
function GroupCombineMenu({
  label,
  options,
  onChoose,
}: {
  label: string;
  options: Array<{ index: number; name: string }>;
  onChoose: (intoIndex: number) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Combine ${label} with another label`}
        onClick={() => setOpen((value) => !value)}
        className="ml-1 rounded-full px-1 leading-none text-sky-700 hover:bg-sky-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-sky-300 dark:hover:bg-sky-900"
      >
        <span aria-hidden="true">▾</span>
      </button>
      {open ? (
        <ul
          role="menu"
          className="absolute left-0 top-full z-10 mt-1 rounded border border-slate-300 bg-white dark:border-slate-700 dark:bg-slate-900"
        >
          {options.map((option) => (
            <li key={option.index}>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onChoose(option.index);
                  setOpen(false);
                }}
                className="block w-full whitespace-nowrap px-3 py-1.5 text-left text-xs hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:hover:bg-slate-800"
              >
                {option.name}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </span>
  );
}
```

Import `useState` from `react` if it is not already imported.

- [ ] **Step 4: Run the tests**

Run: `cd apps/web && npx vitest run src/components/ThemeFilter.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/ThemeFilter.tsx apps/web/src/components/ThemeFilter.test.tsx
git commit -m "feat(web): combine label groups from a menu"
```

---

### Task 6: Carry groups through the board and storage

**Files:**
- Modify: `apps/web/src/components/BoardColumn.tsx`
- Modify: `apps/web/src/routes/CreatorBoard.tsx`
- Modify: `apps/web/src/api/use-board.ts`
- Modify: `apps/web/src/api/board-settings.ts`
- Test: `apps/web/src/api/board-settings.test.ts`, `apps/web/src/routes/CreatorBoard.test.tsx`

**Interfaces:**
- Consumes: `encodeGroups`, `decodeGroups` from Task 3.
- Produces: `localThemes(slug): string[][]`, `rememberThemes(slug, groups: string[][]): Promise<void>`. `useBoard`'s third parameter becomes `themeGroups?: string[][]`.

- [ ] **Step 1: Write the failing tests**

```ts
// board-settings.test.ts
    it('remembers groups, not just labels', async () => {
      await rememberThemes('ada-writes', [['t1', 't2'], ['t3']]);
      expect(localThemes('ada-writes')).toEqual([['t1', 't2'], ['t3']]);
    });

    it('reads a value written before groups existed as one group each', async () => {
      // #131 wrote `t1,t2`. That meant `(t1) OR (t2)` then and means the same now.
      window.localStorage.setItem('pp.board.ada-writes.themes', 't1,t2');
      expect(localThemes('ada-writes')).toEqual([['t1'], ['t2']]);
    });
```

```ts
// CreatorBoard.test.tsx
  it('sends a grouped filter as pipes inside commas', async () => {
    const fetchMock = fakeApi({
      'GET /api/v1/creators/ada-writes': creator,
      'GET /api/v1/creators/ada-writes/capabilities': viewOnly,
      'GET /api/v1/creators/ada-writes/recommendations': (url: URL) => ({
        items: byColumn(url, [recommendation()]),
        nextCursor: null,
      }),
      'GET /api/v1/creators/ada-writes/themes': {
        items: [
          { id: 't1', name: 'Anime', entryCount: 1 },
          { id: 't2', name: 'Fantasy', entryCount: 1 },
        ],
      },
    });
    global.fetch = fetchMock;
    renderBoard();

    await userEvent.click(await screen.findByRole('button', { name: 'Anime' }));
    await userEvent.click(screen.getByRole('button', { name: 'Fantasy' }));
    await userEvent.click(screen.getByRole('button', { name: /combine anime with/i }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Fantasy' }));

    await waitFor(() => {
      const urls = fetchMock.mock.calls.map(([input]) => String(input));
      expect(urls.some((u) => u.includes('themes=t2%7Ct1'))).toBe(true);
    });
  });
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `cd apps/web && npx vitest run src/api/board-settings.test.ts src/routes/CreatorBoard.test.tsx`
Expected: FAIL — `localThemes` returns `string[]`.

- [ ] **Step 3: Store and read groups**

In `board-settings.ts`:

```ts
export function localThemes(slug: string): string[][] {
  return decodeGroups(window.localStorage.getItem(themesKey(slug)) ?? '');
}

/** Local only — see `themesKey`. Nothing is sent to the server. */
export async function rememberThemes(slug: string, groups: string[][]): Promise<void> {
  window.localStorage.setItem(themesKey(slug), encodeGroups(groups));
}
```

with `import { decodeGroups, encodeGroups } from '../components/label-groups';`.

`decodeGroups` reads `t1,t2` as `[['t1'], ['t2']]` already, so a value written by #131 keeps its meaning with no migration.

- [ ] **Step 4: Send the encoded expression**

In `use-board.ts`, change the parameter to `themeGroups?: string[][]` and the query line to:

```ts
  if (themeGroups && themeGroups.length > 0) query.set('themes', encodeGroups(themeGroups));
```

Delete the `[...themeIds].sort()` from #131: order is meaningful now, and sorting would reorder a reader's groups.

- [ ] **Step 5: Change the types through the board**

`CreatorBoard.tsx`: `useState<string[][]>(() => localThemes(slug))`.
`BoardColumn.tsx`: `selectedThemes: string[][]` and `onSelectThemes: (groups: string[][]) => void`.

- [ ] **Step 6: Prune labels the board no longer has**

Spec §5. Labels are merged and deleted on the `/themes` page, so a remembered filter can name one
that is gone. `decodeGroups` drops what will not parse; it cannot know what still exists.

Write the failing test first:

```ts
// CreatorBoard.test.tsx
  it('drops a remembered label the board no longer has', async () => {
    // Labels get merged and deleted on the themes page. A filter naming a dead one would send
    // `themes=` with an id the server refuses, and the board would 404 on load — for a choice the
    // reader may not remember making.
    window.localStorage.setItem('pp.board.ada-writes.themes', 'gone|t1');
    const fetchMock = fakeApi({
      'GET /api/v1/creators/ada-writes': creator,
      'GET /api/v1/creators/ada-writes/capabilities': viewOnly,
      'GET /api/v1/creators/ada-writes/recommendations': (url: URL) => ({
        items: byColumn(url, [recommendation()]),
        nextCursor: null,
      }),
      'GET /api/v1/creators/ada-writes/themes': {
        items: [{ id: 't1', name: 'Anime', entryCount: 1 }],
      },
    });
    global.fetch = fetchMock;
    renderBoard();

    await screen.findByRole('button', { name: /remove anime filter/i });
    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(urls.some((u) => u.includes('gone'))).toBe(false);
  });
```

Then prune in `CreatorBoard` once the label list arrives, in an effect keyed on it:

```tsx
  // Silently: a reader returning to a board does not need an error about a label they may not
  // remember choosing. An emptied group goes, and if nothing survives the filter clears.
  useEffect(() => {
    if (themes.length === 0) return;
    const live = new Set(themes.map((theme) => theme.id));
    setThemeIds((current) => {
      const pruned = current
        .map((group) => group.filter((id) => live.has(id)))
        .filter((group) => group.length > 0);
      if (encodeGroups(pruned) === encodeGroups(current)) return current;
      void rememberThemes(slug, pruned);
      return pruned;
    });
  }, [themes, slug]);
```

Import `encodeGroups` from `../components/label-groups`.

The comparison is on the encoded string rather than the array so an unchanged filter returns the
same reference and does not re-render forever.

- [ ] **Step 7: Run the web suite**

Run: `cd apps/web && npx vitest run`
Expected: PASS. Update any #131 test still passing `string[]`.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): carry grouped label filters through the board"
```

---

### Task 7: Say why the column is empty

**Files:**
- Modify: `apps/web/src/components/BoardColumn.tsx`
- Modify: `apps/web/src/components/BoardColumn.test.tsx`

**Interfaces:**
- Consumes: the `themes` and `selectedThemes` props from Task 6.
- Produces: nothing new.

Spec §4, taking its recommendation.

- [ ] **Step 1: Write the failing test**

```ts
    it('names the filter when a group matches nothing', async () => {
      // An AND group is narrow by construction and usually matches nothing, which reads as a
      // broken filter rather than a true answer unless the column says what it asked for.
      stub([]);
      setup({
        themes: [
          { id: 't1', name: 'Anime', entryCount: 1 },
          { id: 't2', name: 'Documentary', entryCount: 1 },
        ],
        selectedThemes: [['t1', 't2']],
      });
      expect(await screen.findByText(/no entries carry both anime and documentary/i)).toBeInTheDocument();
    });
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd apps/web && npx vitest run src/components/BoardColumn.test.tsx`
Expected: FAIL — the column shows its generic empty text.

- [ ] **Step 3: Replace the empty text when a filter is on**

Where `BoardColumn` renders `{emptyText}`:

```tsx
            <p className="text-sm text-slate-500 dark:text-slate-400">{filteredEmptyText()}</p>
```

and above the return:

```tsx
  /**
   * A filtered column that finds nothing has not failed — it has answered. Saying which labels it
   * asked for turns a blank column into that answer, and costs nothing the API has to learn.
   */
  const filteredEmptyText = () => {
    if (selectedThemes.length === 0) return emptyText;
    const names = (ids: string[]) =>
      ids.map((id) => themes.find((theme) => theme.id === id)?.name ?? id);
    const [first] = selectedThemes;
    if (selectedThemes.length === 1 && first.length > 1) {
      const parts = names(first);
      return `No entries carry both ${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}.`;
    }
    return `Nothing here matches ${selectedThemes.map((group) => names(group).join(' and ')).join(', or ')}.`;
  };
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/web && npx vitest run src/components/BoardColumn.test.tsx`
Expected: PASS, and the unfiltered empty-text case still passes untouched.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/BoardColumn.tsx apps/web/src/components/BoardColumn.test.tsx
git commit -m "feat(web): an empty filtered column says what it asked for"
```

---

### Task 8: Drag one chip onto another

**Files:**
- Modify: `apps/web/src/components/ThemeFilter.tsx`
- Modify: `apps/web/src/components/ThemeFilter.test.tsx`

**Interfaces:**
- Consumes: `combine` from Task 3.
- Produces: nothing new.

The shortcut, built last because everything works without it.

- [ ] **Step 1: Write the failing test**

```ts
  it('combines when one group is dropped onto another', async () => {
    const onChange = vi.fn();
    render(<ThemeFilter themes={themes} selected={[['t1'], ['t2']]} onChange={onChange} />);
    const transfer = {
      getData: () => 't1',
      setData: vi.fn(),
      dropEffect: '',
      effectAllowed: '',
    };
    fireEvent.drop(screen.getByText('Fantasy').closest('li')!, { dataTransfer: transfer });
    expect(onChange).toHaveBeenCalledWith([['t2', 't1']]);
  });
```

Import `fireEvent` from `@testing-library/react`.

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd apps/web && npx vitest run src/components/ThemeFilter.test.tsx`
Expected: FAIL — nothing handles a drop.

- [ ] **Step 3: Make each group draggable and a drop target**

On the group `<li>`:

```tsx
              draggable
              onDragStart={(event) => event.dataTransfer.setData(DRAG_LABEL, group[0])}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                const id = event.dataTransfer.getData(DRAG_LABEL);
                if (id && !group.includes(id)) onChange(combine(selected, id, groupIndex));
              }}
```

and at the top of the file:

```tsx
/** Its own type, so a card dragged from the board is not mistaken for a label. */
const DRAG_LABEL = 'application/x-pp-label';
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/web && npx vitest run src/components/ThemeFilter.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/ThemeFilter.tsx apps/web/src/components/ThemeFilter.test.tsx
git commit -m "feat(web): drag a label onto another to combine them"
```

---

### Task 9: Make the demo able to show it

**Files:**
- Modify: `apps/api/scripts/seed-demo.ts`
- Modify: `docs/demo-walkthrough.md`

Spec §6. Without this a playtester combining two labels sees an empty column and concludes the feature is broken.

- [ ] **Step 1: Measure what the seed gives today**

```bash
docker-compose -p patreonplanner-demo -f docker-compose.demo.yml exec -T postgres \
  psql -U planner -d planner -c "
SELECT a.name, b.name, count(*) FROM \"TitleTheme\" ta
JOIN \"TitleTheme\" tb ON tb.\"titleId\"=ta.\"titleId\" AND tb.\"themeId\">ta.\"themeId\"
JOIN \"Theme\" a ON a.id=ta.\"themeId\" JOIN \"Theme\" b ON b.id=tb.\"themeId\"
GROUP BY a.name, b.name ORDER BY 3 DESC;"
```

Record the output in the commit message. At the time of writing: five labels, ten possible pairs, five that never co-occur, largest overlap four between two near-synonyms.

- [ ] **Step 2: Seed a pair that co-occurs on more than one entry**

In `seed-demo.ts`, where themes are attached to titles, add `Thriller` to a second entry that already carries `Anime`, so `Anime AND Thriller` returns two entries rather than one. Leave `Documentary` sharing with nothing, so the empty case is still reachable.

Add a comment saying why, in the style of the `votedBefore` note:

```ts
      // Two labels on two of the same entries, so `Anime AND Thriller` returns something and the
      // grouped filter differs visibly from its absence. Documentary is deliberately left sharing
      // with nothing, so the empty case is reachable too — both outcomes are worth seeing.
```

- [ ] **Step 3: Reseed and confirm both outcomes**

```bash
docker-compose -p patreonplanner-demo -f docker-compose.demo.yml down -v
DEMO_HOST=$(ipconfig getifaddr en0) docker-compose -p patreonplanner-demo \
  -f docker-compose.demo.yml up -d --build --wait
```

Then in the UI: combine Anime with Thriller and confirm entries remain; combine Anime with Documentary and confirm the empty text from Task 7 appears.

- [ ] **Step 4: Add a walkthrough section**

After §4b (entry grouping), matching its voice: combine two labels, read the count, split at the magnet, remove the group. Say plainly that an AND group often matches nothing and that this is an answer rather than a fault.

- [ ] **Step 5: Commit**

```bash
git add apps/api/scripts/seed-demo.ts docs/demo-walkthrough.md
git commit -m "feat(demo): seed a label pair that co-occurs, so grouping shows"
```

---

### Task 10: One e2e journey

**Files:**
- Modify: `e2e/tests/journey.spec.ts`

The half no unit test reaches: the query, the encoding and the rendering together against the real stack.

- [ ] **Step 1: Write the journey**

```ts
test('a reader combines two labels and splits them again', async ({ page }) => {
  await signIn(page, 500);
  await page.goto(`/c/${CREATOR.slug}`);

  const column = page.getByRole('region', { name: /suggestions/i });
  const filter = column.getByRole('group', { name: /filter labels/i });
  await expect(filter).toBeVisible();

  await filter.getByRole('button', { name: 'Anime', exact: true }).click();
  await filter.getByRole('button', { name: 'Thriller', exact: true }).click();
  await filter.getByRole('button', { name: /combine anime with/i }).click();
  await filter.getByRole('menuitem', { name: 'Thriller' }).click();

  // Stored, not merely optimistic: the expression is rebuilt from localStorage on load.
  await page.reload();
  const magnet = column
    .getByRole('group', { name: /filter labels/i })
    .getByRole('button', { name: /split between/i });
  await expect(magnet).toBeVisible();

  await magnet.click();
  await expect(
    column.getByRole('group', { name: /filter labels/i }).getByRole('button', { name: /split between/i }),
  ).toHaveCount(0);
});
```

- [ ] **Step 2: Run it against the real stack**

```bash
docker-compose -p patreonplanner-e2e -f docker-compose.e2e.yml up -d --build --wait
docker-compose -p patreonplanner-e2e -f docker-compose.e2e.yml exec -T web \
  sh -c 'grep -c "Split between" /usr/share/nginx/html/assets/index-*.js'
pnpm --filter @app/e2e exec playwright test --reporter=line -g "combines two labels"
```

The grep confirms the running image carries the change before the result is trusted. Expected: `1`, then PASS.

- [ ] **Step 3: Run the whole e2e suite**

Run: `pnpm --filter @app/e2e exec playwright test --reporter=line`
Expected: every journey passes.

- [ ] **Step 4: Commit**

```bash
git add e2e/tests/journey.spec.ts
git commit -m "test(e2e): combining and splitting label groups"
```

---

## Finishing

- [ ] Run all five verification commands and quote their output.
- [ ] `docker-compose -p patreonplanner-e2e -f docker-compose.e2e.yml down -v`.
- [ ] Update `coding_agent/PROGRESS_TRACKER.md`: mark the plan complete, record what the demo can now show, and note anything the plan predicted wrongly.
- [ ] Open the PR with the mutation results quoted.
