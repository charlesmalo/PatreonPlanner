# Link Candidates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Stop a submitted URL from becoming a live link on someone's board without a human deciding it should be.

## The threat this closes

Submitting an entry that matches an existing one currently returns the existing entry and throws the submitted link away. The design asks for the link to be *kept* — which, done naively, means **any patron can attach a URL to any card on any public board**, where it renders with the creator's implicit endorsement. The moderation pipeline screens for profanity, not for phishing.

A URL is also actionable in a way a title is not: clicking it leaves the site. So links are the one piece of submitted content that waits for a human.

## The consequence, stated plainly

**A patron's own link no longer appears on their own entry until staff publish it.** An `EXTERNAL_LINK` entry from a patron shows as a pending suggestion with no clickable link.

That is what the design asks for and the reasoning holds — a pending entry is visible to patrons by default, so "it is only pending" does not make its link safe. It is still a visible change to how the board reads, and it is the reason this is its own plan rather than a footnote to grouping.

## Decisions this plan settles

1. **Status on the link, not a second table.** A candidate and a published link differ by whether someone approved them; everything else about them is identical.
2. **Staff links publish immediately.** Someone who can already edit the board's content does not need to approve their own URL.
3. **Locking a preferred link stops new candidates.** Once a creator has decided where to watch something, a queue of alternatives is noise rather than a decision waiting to be made.
4. **Canonicalise the platforms whose identity is stable**, and treat everything else as distinct. Netflix uses the same numeric id across every TLD, YouTube ids are global, Crunchyroll slugs are consistent. Guessing at an unknown domain would silently merge two different pages.
5. **De-duplicate on the canonical form.** The same page submitted by four people is one candidate, not four.

## Scope

**In:** `LinkStatus`; `submittedByUserId`; `isPreferred`; candidates from duplicate submissions; publish, discard and prefer; canonicalisation; the board showing published links only.

**Out, with reasons:**
- *Checking whether a URL resolves.* Fetching a submitted URL server-side is a request-forgery surface, and a link that 200s is not thereby safe.
- *Merging candidates into provider availability.* They are different data with different trust — TMDB's is refreshed and authoritative, a candidate is a claim. Rendering them as one list would make neither legible.
- *Notifying staff per candidate.* A busy entry would produce a stream; the review surface is where they are worked.

## File Structure

- `apps/api/prisma/schema.prisma` + migration — `LinkStatus`, `submittedByUserId`, `isPreferred`.
- `apps/api/src/recommendations/links.service.ts` — canonicalise, contribute, publish, discard, prefer.
- `apps/api/src/recommendations/recommendations.controller.ts` — the staff endpoints.

---

### Task 1: Candidates

- [x] **Failing tests:** a patron's link on a new entry is a candidate; a staff member's publishes immediately; the board shows published only; staff see candidates; a duplicate submission contributes its link rather than losing it; the same page submitted twice is one candidate; a locked entry refuses new candidates.
- [x] Model + migration; existing rows become `PUBLISHED`, because they are what the board already shows and silently hiding them would be a regression dressed as a fix.
- [x] Canonicalisation for Netflix, YouTube and Crunchyroll; everything else compared as given.
- [x] **Mutation-check:** publishing a patron's link, showing candidates on the board, and skipping canonicalisation must each fail.
- [x] Commit.

### Task 2: Deciding

- [x] **Failing tests:** staff publish a candidate; staff discard one; staff mark one preferred; preferring publishes it if it was a candidate; a patron and a mod without `EDIT_ENTRIES` are refused; another board's link is a 404.
- [x] `PATCH|DELETE /creators/:slug/links/:id`.
- [x] Commit.

---

## Known risks

- **Migrated rows keep their raw URL as their canonical form.** The migration is SQL and cannot
  call `canonicalUrl`, so a pre-existing `https://www.netflix.com/title/123` does not collide with
  a newly submitted `netflix:123` — the board grows one duplicate candidate rather than merging
  them. Harmless and staff-visible; a backfill script would fix it if real data ever justifies one.
- **Canonicalisation is a shipped list.** A platform that changes its URL shape starts producing duplicate candidates until the list is updated; nothing detects that.
- ~~**A patron submitting a link gets no feedback that it is waiting.**~~ Closed during Task 1: a
  viewer sees published links *plus candidates they submitted themselves*, so their own link comes
  back in `candidateLinks` rather than appearing to vanish. Nobody else sees it.
- **Staff have no UI for this yet.** `PATCH|DELETE /creators/:slug/links/:id` exist and `candidateLinks`
  reaches a staff client, but nothing renders it — deciding a candidate currently needs a direct API
  call. That is the next plan, not a gap in this one.
- **Locking is per entry**, so a creator who prefers one platform everywhere must lock every entry individually.
