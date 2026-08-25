# Link Review UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give staff a place to publish, discard or prefer a link candidate, and tell a patron their own submitted link is waiting rather than lost.

**Architecture:** Plan 09 shipped the model and the endpoints; nothing renders them. The board already sends `candidateLinks` to exactly the people entitled to see them — staff, and a candidate's own submitter — so the UI decides *what to draw*, never *who may see it*. The API stays the only gate.

**Tech Stack:** React 18 + Vite + Tailwind, the project's own `api` client, Vitest + RTL. No new dependencies, and no React Query — this codebase does not use it.

## Global Constraints

- **Free tier only.** No paid API, service, or dependency. Anything with a bill needs the user to reopen the decision first.
- **The SPA never gates security.** Capabilities and permissions are rendering hints computed by the same resolver the guard uses. Every control this plan adds is also refused server-side, and there is already a test proving it.
- **No button that cannot work.** `StaffPage.test.tsx` holds this line for the owner row; this plan extends it to `EDIT_ENTRIES`.
- **A submitter-chosen URL opens with `rel="noopener noreferrer"` and passes `isSafeHttpUrl`,** exactly as the published list already does. A candidate is *less* trusted than a published link, never more.

---

## The problem, stated plainly

A creator's only way to act on a candidate today is a direct `PATCH /creators/:slug/links/:id`. Candidates therefore accumulate invisibly: the mechanism that holds a patron's link back has no matching mechanism for letting it through, so in practice every submitted link is silently discarded by inaction.

## Decisions this plan settles

- **Candidates render on the card, not on a separate queue.** The decision needs the entry's title and its existing links to be sensible — "is this the right Netflix page for *this* show" is unanswerable in a list of bare URLs.
- **The patron sees a state, not a control.** Their own candidate renders as "waiting for review" with no buttons. It exists to stop them resubmitting, not to invite them to act.
- **`EDIT_ENTRIES` is the gate,** matching `links.controller.ts`. A mod with only `HANDLE_REPORTS` sees candidates (the API sends them to all staff) but gets no controls.

## Scope

**In:** `permissions` on the capabilities response; `id`/`isPreferred`/`candidateLinks` in the web types; a `LinkCandidates` component; publish, discard and prefer wired to the existing endpoints; the waiting state for a submitter.

**Out, with reasons:**
- *A bulk "publish all" control.* Reviewing is the point. A control that approves unread URLs re-opens the hole Plan 09 closed.
- *Editing a candidate's label or URL before publishing.* A different operation — it changes what the submitter claimed — and it needs its own audit story.
- *Preferring from the patron-facing card.* Preferring locks the entry against further candidates; that belongs with the creator's own controls, not beside a patron's pending link.

## File Structure

- `apps/api/src/creators/creators.controller.ts` — capabilities gains `permissions`.
- `apps/api/test/creator-access.int-spec.ts` (where the endpoint is already exercised; `capability.e2e-spec.ts` is the pure resolver) — that it is the viewer's real set, and empty for a non-staff reader.
- `apps/web/src/api/types.ts` — `RecommendationLink.id`/`isPreferred`, `Recommendation.candidateLinks`, `Capabilities.permissions`.
- `apps/web/src/components/LinkCandidates.tsx` — the whole surface. New file, so the card does not grow again.
- `apps/web/src/components/LinkCandidates.test.tsx`
- `apps/web/src/components/RecommendationCard.tsx` — renders `<LinkCandidates />`, nothing more.
- No new hooks: this codebase has no React Query, and mutations follow `PickButton.tsx` — local state, optimistic with rollback, `api.patch`/`api.del`.

---

### Task 1: Capabilities carry the viewer's permissions

**Files:**
- Modify: `apps/api/src/creators/creators.controller.ts`
- Modify: `apps/web/src/api/types.ts`
- Test: `apps/api/test/creator-access.int-spec.ts` (where the endpoint is already exercised; `capability.e2e-spec.ts` is the pure resolver)

**Interfaces:**
- Consumes: `Viewer` (`{ userId, staffRole, permissions }`) from `../access/capability`, `can()` from `../access/capability`.
- Produces: `GET /creators/:slug/capabilities` → the five booleans **plus** `permissions: StaffPermissionValue[]`.

- [x] **Step 1: Write the failing tests**

```ts
it('tells a moderator which permissions they actually hold', async () => {
  const res = await capabilities(modWithMoveOnly).expect(200);
  expect(res.body.permissions).toEqual(['MOVE_ENTRIES']);
});

it('gives an owner the full set rather than an empty row', async () => {
  // An owner's powers come from the role short-circuiting the check, so their stored
  // permissions column is empty. Returning it raw would hide every control from the one
  // person who may use all of them.
  const res = await capabilities(owner).expect(200);
  expect(res.body.permissions).toEqual(expect.arrayContaining(['EDIT_ENTRIES']));
});

it('gives a patron an empty set, not a missing key', async () => {
  // A client doing `permissions.includes(...)` on undefined throws, and the card that
  // crashes is the patron's, not the moderator's.
  const res = await capabilities(patron).expect(200);
  expect(res.body.permissions).toEqual([]);
});
```

- [x] **Step 2: Run to verify they fail**

Run: `cd apps/api && pnpm test -- creator-access`
Expected: FAIL — `permissions` is `undefined`.

- [x] **Step 3: Implement**

```ts
return {
  view: can('VIEW', viewer, policy),
  upvote: can('UPVOTE', viewer, policy),
  submit: can('SUBMIT', viewer, policy),
  moderate: can('MODERATE', viewer, policy),
  administer: can('ADMINISTER', viewer, policy),
  // An owner holds everything by role — their stored column is empty, and returning it raw
  // would hide every control from the one person entitled to all of them. Same short-circuit
  // `hasPermission` applies, expressed once more here because the SPA cannot call it.
  permissions:
    viewer.staffRole === 'OWNER' ? [...ALL_STAFF_PERMISSIONS] : viewer.permissions,
};
```

- [x] **Step 4: Run to verify they pass**

Run: `cd apps/api && pnpm test -- creator-access`

- [x] **Step 5: Mutation-check**

Replace the OWNER branch with `viewer.permissions`. The owner test must fail. `Viewer.permissions` is already non-optional and empty for a non-staff viewer, so the patron
test guards the *contract* rather than a `??`. Confirm it by deleting the `permissions` key
entirely: it must fail.

- [x] **Step 6: Add the web types**

```ts
export interface Capabilities {
  view: boolean;
  upvote: boolean;
  submit: boolean;
  moderate: boolean;
  administer: boolean;
  /** A rendering hint. The API refuses regardless of what this says. */
  permissions: StaffPermission[];
}

export interface RecommendationLink {
  id: string;
  url: string;
  label: string | null;
  isPreferred: boolean;
}
```

Check `narrowCapabilities` in `view-mode.ts`: view-as-patron must empty `permissions`, for the same reason it clears `moderate`. Add a test that it does.

- [x] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(api): capabilities say which permissions a viewer holds"
```

---

### Task 2: Candidates on the card

**Files:**
- Create: `apps/web/src/components/LinkCandidates.tsx`
- Create: `apps/web/src/components/LinkCandidates.test.tsx`
- Modify: `apps/web/src/components/RecommendationCard.tsx`
- Modify: `apps/web/src/api/types.ts`

**Interfaces:**
- Consumes: `Recommendation.candidateLinks`, `Capabilities.permissions`, `isSafeHttpUrl`.
- Produces: `<LinkCandidates slug candidates capabilities />`. No hooks — see above.

- [x] **Step 1: Write the failing tests**

```tsx
const candidate = { id: 'l1', url: 'https://example.test/a', label: null, isPreferred: false };
const staff = { ...caps, moderate: true, permissions: ['EDIT_ENTRIES'] as StaffPermission[] };

it('renders nothing when there are no candidates', () => {
  const { container } = render(<LinkCandidates slug="c" candidates={[]} capabilities={staff} />);
  expect(container).toBeEmptyDOMElement();
});

it('offers publish and discard to staff who may edit entries', async () => {
  render(<LinkCandidates slug="c" candidates={[candidate]} capabilities={staff} />);
  expect(screen.getByRole('button', { name: /publish/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /discard/i })).toBeInTheDocument();
});

it('offers no controls to a moderator without EDIT_ENTRIES', () => {
  // They are sent candidates — every staff member is — but the endpoint refuses them, and a
  // button that cannot work is a lie.
  const reports = { ...staff, permissions: ['HANDLE_REPORTS'] as StaffPermission[] };
  render(<LinkCandidates slug="c" candidates={[candidate]} capabilities={reports} />);
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});

it('tells a submitter their link is waiting, with no controls', () => {
  render(<LinkCandidates slug="c" candidates={[candidate]} capabilities={caps} />);
  expect(screen.getByText(/waiting for review/i)).toBeInTheDocument();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});

it('renders a candidate URL as text, never as a link', () => {
  // A published link is a creator's endorsement; a candidate is an unreviewed stranger's URL.
  // Making it clickable hands out exactly the reach Plan 09 withheld.
  render(<LinkCandidates slug="c" candidates={[candidate]} capabilities={caps} />);
  expect(screen.getByText('https://example.test/a')).toBeInTheDocument();
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
});

it('renders a javascript: candidate as inert text', () => {
  const nasty = { ...candidate, url: 'javascript:alert(1)' };
  render(<LinkCandidates slug="c" candidates={[nasty]} capabilities={staff} />);
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
});
```

- [x] **Step 2: Run to verify they fail**

Run: `cd apps/web && pnpm vitest run LinkCandidates`
Expected: FAIL — module not found.

- [x] **Step 3: Implement**

```tsx
export function LinkCandidates({ slug, candidates, capabilities }: Props) {
  if (candidates.length === 0) return null;

  const mayDecide = capabilities.permissions.includes('EDIT_ENTRIES');

  return (
    <section className="mt-2 rounded border border-dashed border-slate-300 p-2 dark:border-slate-600">
      <h4 className="text-xs font-medium text-slate-500 dark:text-slate-400">
        {mayDecide ? 'Suggested links, waiting for review' : 'Your link is waiting for review'}
      </h4>
      <ul className="mt-1 space-y-1">
        {candidates.map((link) => (
          <li key={link.id} className="flex flex-wrap items-center gap-2">
            {/* Text, never an anchor. An unreviewed URL does not get the creator's reach. */}
            <span className="break-all text-sm text-slate-600 dark:text-slate-300">
              {link.label ? `${link.label} — ${link.url}` : link.url}
            </span>
            {mayDecide ? (
              <>
                <button onClick={() => publish(link)}>Publish</button>
                <button onClick={() => discard(link)}>Discard</button>
              </>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
```

- [x] **Step 4: Run to verify they pass**

Run: `cd apps/web && pnpm vitest run LinkCandidates`

- [x] **Step 5: Mutation-check**

Change `mayDecide` to `capabilities.moderate`; the `HANDLE_REPORTS` test must fail. Render the URL inside an `<a href>`; the two "never a link" tests must fail. Delete the `candidates.length === 0` guard; the empty test must fail.

- [x] **Step 6: Wire it into the card and run everything**

```tsx
<LinkCandidates
  slug={slug}
  candidates={recommendation.candidateLinks ?? []}
  capabilities={capabilities}
/>
```

The `?? []` matches the defensive pattern already on `themes` and `notes`, and for the same stated reason: a card is rendered from both the board projection and a submit response.

Run: `pnpm -r typecheck && cd apps/web && pnpm vitest run && cd ../api && pnpm test`

- [x] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(web): staff decide a link candidate where the entry is"
```

---

## What was found while building it

- **`narrowCapabilities` blanked the whole board** when a capabilities payload had no
  `permissions` key — it runs inside render, so the throw took the page rather than a control.
  Guarded, with a test for the older shape.
- **The publish path needed its own scheme check.** A mutation removing `isSafeHttpUrl` from the
  just-published row survived the first pass: every test rendered a `javascript:` candidate but
  none *published* one, which is precisely where the URL becomes an `href`.
- **`isSafeHttpUrl` moved to its own module.** It lived on `RecommendationCard`, which now
  imports `LinkCandidates` — leaving it there made the two import each other.

## Known risks

- **A busy entry could collect many candidates**, and the card grows with them. No cap yet; the review surface will need one if boards get loud.
- **Publishing is one click with no undo.** Discard is destructive and immediate — the API deletes rather than soft-deletes. A misclick loses the URL, and the submitter is not told either way.
- **Nothing notifies staff that candidates are waiting.** Plan 09 ruled per-candidate notifications out for good reason, but the consequence stands: candidates are found by browsing, not by being told.
