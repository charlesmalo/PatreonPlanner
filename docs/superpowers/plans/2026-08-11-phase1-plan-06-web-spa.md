# Patron Web SPA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the product usable by an actual person — log in with Patreon, read a creator's board, upvote, and submit — against the API Plans 02–05 already ship.

**Architecture:** React Router for two routes (landing, creator board). A single typed `api` client owns the same-origin fetch, the CSRF header, and error normalisation, so no component hand-rolls a request. Server state lives in small purpose-built hooks rather than a data library — there are four endpoints, and a cache layer would be more machinery than the app has state. The board renders from `/capabilities`, which decides *which controls appear*; the server decides *what is allowed*, and the UI never pretends otherwise.

**Tech Stack:** React 18, Vite, Tailwind (all scaffolded in Plan 01), React Router 6, Vitest + React Testing Library.

## Global Constraints

- **The SPA never gates security** (design §4). Capability flags choose what to render; every action is authorised server-side, and a hidden button is a convenience, not a control.
- **No `dangerouslySetInnerHTML`.** Titles, descriptions and link labels are attacker-chosen text; React's default escaping is the protection.
- **External links carry `rel="noopener noreferrer"`** — `url` is fully attacker-chosen.
- **Every state-changing request sends the CSRF header** read from the `pp_csrf` cookie.
- **Accessible by keyboard**: real buttons, labelled inputs, visible focus, `aria-live` for async results.
- **Every async surface has loading, empty and error states.** A blank page on failure is a bug.

## Scope

**In scope:** landing page, creator board with cursor paging, upvote toggle, submit form, login/logout, session display, capability-driven controls, error/loading/empty states, and component tests against a fake API.

**Out of scope — deliberately deferred:**

- **Creator/mod dashboard, kanban, review queue** (design §7) → after Plan 07 ships the status lifecycle those columns display.
- **Catalog search / TMDB autocomplete** (design §5 submit flow) → needs Plan 06's `catalog/search`; the form submits `EXTERNAL_LINK`, which is exactly what the API accepts today.
- **Themes, franchise nesting, where-to-watch badges** → need Plan 08's catalog intelligence.
- **Claiming UI** — the endpoint exists but the flow needs a campaign picker; a creator can claim via API until then.

## Decisions this plan settles

**Capabilities drive rendering, never authorisation.** `GET /creators/:slug/capabilities` returns `{ view, upvote, submit, moderate }`. The submit form renders only when `submit` is true and the upvote button is disabled when `upvote` is false — but a user who forges either still gets a 403 from the API, and the UI shows that error rather than assuming it cannot happen. Design §4 is explicit that the SPA never gates security; this keeps the flag a hint.

**Optimistic upvotes, reconciled from the response.** The count updates immediately and is replaced by the server's number when it answers, reverting on error. A toggle that waits a round-trip feels broken, and the endpoint already returns the authoritative count.

**One `ApiError` type carrying the HTTP status.** Components branch on `401` (sign in), `403` (not allowed), `429` (slow down) and everything else (generic). Design §9 wants generic messages; the *status* is what the UI needs, and the server's message body is never rendered raw.

**Server state in hooks, not a store.** Four endpoints and no cross-page sharing. React Query would buy caching the app cannot yet use, and every dependency is a thing to keep current.

---

## Task 1: API client, CSRF and error handling

**Files:**

- Create: `apps/web/src/api/client.ts`, `apps/web/src/api/types.ts`
- Test: `apps/web/src/api/client.test.ts`
- Modify: `apps/web/package.json` (add `react-router-dom`)

**Interfaces:**

- Produces: `api.get<T>(path)`, `api.post<T>(path, body?)`, `class ApiError extends Error { status: number }`, and `readCsrfToken()`.

- [ ] **Step 1: Add the router dependency**

`cd apps/web && pnpm add react-router-dom@6.27.0`

- [ ] **Step 2: Write the failing test**

`client.test.ts` stubs `document.cookie` and `global.fetch` and asserts:

- `get` calls the same-origin path under `/api/v1` and returns parsed JSON
- `post` sends `x-csrf-token` read from the `pp_csrf` cookie
- `post` sends `credentials: 'same-origin'` so the session cookie rides along
- a 401 throws `ApiError` with `status === 401`
- a 500 with a non-JSON body still throws `ApiError` rather than a parse error
- a 204 resolves without attempting to parse a body

- [ ] **Step 3: Implement**

```ts
export class ApiError extends Error {
  constructor(readonly status: number) {
    // The server's body is never surfaced: design §9 wants generic messages, and the status is
    // the only part the UI branches on.
    super(`Request failed with status ${status}`);
  }
}

export function readCsrfToken(): string | null {
  const match = document.cookie.match(/(?:^|;\s*)pp_csrf=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : null;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = readCsrfToken();
  const response = await fetch(`/api/v1${path}`, {
    method,
    // Same-origin by deployment (see docs/decisions/2026-08-08-same-origin-deployment.md), so
    // the session cookie is sent without CORS credentials mode.
    credentials: 'same-origin',
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token && method !== 'GET' ? { 'x-csrf-token': token } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new ApiError(response.status);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
```

- [ ] **Step 4: Run and commit**

---

## Task 2: Session and capability hooks

**Files:**

- Create: `apps/web/src/api/hooks.ts`
- Test: `apps/web/src/api/hooks.test.tsx`

**Interfaces:**

- Produces: `useSession()` → `{ user, loading, signOut }`; `useCapabilities(slug)` → `{ capabilities, loading }`.

`useSession` treats a 401 from `/me` as "signed out" rather than an error — the common case for an anonymous visitor must not render an error state.

- [ ] **Step 1: Write the failing test**

Asserts: `/me` 200 yields the user; `/me` 401 yields `user: null` and no error; `signOut` POSTs `/auth/logout` and clears the user; a capabilities fetch for an anonymous viewer yields all-false without throwing.

- [ ] **Step 2: Implement, then run and commit**

---

## Task 3: Layout, landing page and routing

**Files:**

- Create: `apps/web/src/App.tsx` (replace), `src/routes/LandingPage.tsx`, `src/components/Layout.tsx`, `src/components/SignInButton.tsx`
- Test: `apps/web/src/routes/LandingPage.test.tsx`

**Interfaces:**

- Produces: routes `/` and `/c/:slug`; a header showing the signed-in user with a sign-out control, or a Patreon sign-in link.

The sign-in control is a plain `<a href="/auth/patreon/login">`, not a fetch: it is a top-level navigation to an OAuth redirect, and XHR would break the flow.

- [ ] **Step 1: Write the failing test**

Asserts: the landing page renders the product name and an explanation; a signed-out visitor sees a sign-in link pointing at `/auth/patreon/login`; a signed-in visitor sees their name and a sign-out button.

- [ ] **Step 2: Implement, then run and commit**

---

## Task 4: The board

**Files:**

- Create: `src/routes/CreatorBoard.tsx`, `src/components/RecommendationCard.tsx`, `src/components/UpvoteButton.tsx`, `src/api/useBoard.ts`
- Test: `src/routes/CreatorBoard.test.tsx`, `src/components/UpvoteButton.test.tsx`

**Interfaces:**

- Produces: the board at `/c/:slug` — creator name, entries ordered as the API returns them, a "Load more" control while `nextCursor` is non-null, and per-entry upvote buttons.

- [ ] **Step 1: Write the failing tests**

Board: loading state first; entries rendered with title, description and upvote count; empty state when there are none; a 401 renders "sign in to view" rather than a crash; a 403 renders "this board is for patrons"; a 404 renders "creator not found"; "Load more" appends the next page and disappears when `nextCursor` is null; external links carry `rel="noopener noreferrer"` and `target="_blank"`.

Upvote button: renders the count; disabled with an explanatory title when `upvote` is false; clicking calls the endpoint and optimistically increments; reverts on error; `aria-pressed` reflects state.

- [ ] **Step 2: Implement**

Cards render text through React's default escaping — no `dangerouslySetInnerHTML` anywhere in the app, which the test asserts by rendering a title containing `<img onerror>` and checking no element was created.

- [ ] **Step 3: Run and commit**

---

## Task 5: The submit form

**Files:**

- Create: `src/components/SubmitForm.tsx`
- Test: `src/components/SubmitForm.test.tsx`

**Interfaces:**

- Produces: a form rendered only when `capabilities.submit` is true, posting `{ type: 'EXTERNAL_LINK', customTitle, description, links }`.

- [ ] **Step 1: Write the failing test**

Asserts: hidden when `submit` is false; every input has an associated label; submitting posts the expected body; the new entry is prepended to the board on success; a `duplicate: true` response shows "already on the board" and does *not* add a second card; a 429 shows the rate-limit message; a 400 shows the rejection message; the submit button is disabled while in flight; validation blocks an empty title client-side without a request.

- [ ] **Step 2: Implement**

Client-side validation mirrors the DTO's bounds (title 1–200, description ≤2000, ≤5 links) so the common mistakes are caught without a round-trip — but it is a convenience, and the server's 400 is still rendered when it disagrees.

- [ ] **Step 3: Run and commit**

---

## Task 6: Styling, accessibility pass and verification

**Files:**

- Modify: all components, `src/index.css`, `README.md`
- Test: `src/a11y.test.tsx`

- [ ] **Step 1: Style with Tailwind**

A calm, readable board: a single column of cards on mobile widening to a comfortable measure, upvote count as a prominent affordance on the left of each card, clear focus rings, and adequate contrast in both light and dark via `prefers-color-scheme`.

- [ ] **Step 2: Accessibility test**

Asserts: every interactive element is reachable by keyboard and has an accessible name; the board region has a heading; async results announce via `aria-live`; the upvote button exposes `aria-pressed`; no positive `tabIndex` anywhere.

- [ ] **Step 3: Full verification**

```bash
pnpm -r typecheck && pnpm -r test && pnpm format:check
pnpm --filter @app/web build
docker build -f apps/web/Dockerfile -t patreonplanner-web .
```

Then run both images together and confirm the SPA loads, `/api/v1/*` proxies, and the OAuth redirect leaves for Patreon — the same-origin path end to end.

- [ ] **Step 4: Document and commit**

---

## Self-Review

**Spec coverage (design §7 "Patron/public board", §4 gating, §10 testing):**

- Patron board respecting `viewVisibility` → Task 4 (401/403 states). ✅
- Cards showing title, description, upvotes, links → Task 4. ✅
- Submit and upvote per tier → Tasks 4-5, driven by capabilities. ✅
- "All tier/role checks server-side; the SPA never gates security" → the flags only choose rendering, and every error path renders the server's refusal. ✅
- Component tests for rendering, gating and both flows (design §10) → Tasks 3-6. ✅
- Kanban dashboard, themes, franchise nesting, where-to-watch, search → **deferred** with the plan each needs. ✅

**Known risks:**

1. **No end-to-end browser test.** Component tests use a fake API, so a contract drift between SPA and API would pass both suites. Task 6's manual two-image check is the compensating control; a Playwright run belongs in a later plan.
2. **Optimistic upvotes can briefly disagree** with another user's concurrent toggle. The response reconciles it, and the board is a demand signal rather than an exact tally.
3. **No pagination for very large boards beyond "Load more".** Fine at current scale; virtualisation is a later concern.
