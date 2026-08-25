# Disputes & Contact Tickets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** A reader can tell staff something — that a de-duplication was wrong, or anything else — and get an answer.

**Architecture:** One `Ticket` model, whose subject is either a recommendation or nothing. A dispute and a general message differ by what they point at, not by which table they live in.

## Decisions this plan settles

1. **One mechanism, not two.** A dispute is a ticket with a subject; general contact is a ticket without one. Two tables would mean two inboxes, two notification types, and two sets of resolution logic to drift apart.
2. **`HANDLE_REPORTS` gates it.** Working a ticket is the same job as working a report, done from the same inbox. A sixth permission would be speculative generality (`04_CODE_STANDARDS.md` §5) — nobody has asked to separate the two.
3. **Signed-in by default; the creator may open it.** A public contact form on a public board is the highest-value spam target in the app. `CreatorPolicy.allowAnonymousTickets` defaults false.
4. **The reply is stored on the ticket, not sent anywhere.** Email is out of Phase 1 and out of the free-tier constraint. The reader is told through the notification system that already exists.
5. **A resolution is recorded even when the reply is uninformative.** "Handled internally" is a legitimate answer to a reader; it is not a legitimate answer to the audit trail, so `resolution` is always set.
6. **Tickets are rate-limited and moderated like any other user text.** A ticket body is attacker-chosen text a moderator will read.

## Scope

**In:** `Ticket` model; raise, list, resolve; the pipeline and limiter on the body; a notification to staff on raise and to the reader on resolve; the inbox in the SPA.

**Out, with reasons:**
- *Threaded back-and-forth.* One message, one reply. A conversation needs read state per side and a notification per turn, and nobody has asked for it.
- *Acting on the resolution automatically* — "confirm" does not create or group a card. Grouping is not built (§3 of the design, still blocked), and a resolution that silently edits the board is worse than one a moderator applies deliberately.
- *An About section.* Creator-authored profile text with no inbox behind it; unrelated to this mechanism beyond sharing a design section.

## File Structure

- `apps/api/prisma/schema.prisma` + migration — `Ticket`, `TicketStatus`, `TicketResolution`, `CreatorPolicy.allowAnonymousTickets`.
- `apps/api/src/tickets/` — service, controller, DTOs, module.
- `apps/web/src/routes/Tickets.tsx` — the staff inbox.
- `apps/web/src/components/ContactForm.tsx` — raising one.

---

### Task 1: Raising a ticket

- [ ] **Failing tests:** a signed-in reader raises one; a signed-out reader is refused unless the board allows it; a body that fails moderation is refused and earns a strike; the subject may be a recommendation on this board; a recommendation on another board is a 404; the limiter applies.
- [ ] Model + migration. `subjectId` nullable, `onDelete: SetNull` — a ticket about an entry outlives the entry, and the message still reads.
- [ ] `POST /creators/:slug/tickets`, `VIEW` capability.
- [ ] Notify staff who hold `HANDLE_REPORTS`, coalesced like flag notifications.
- [ ] Commit.

### Task 2: Working the inbox

- [ ] **Failing tests:** staff list open tickets; a mod without `HANDLE_REPORTS` is refused; a patron is refused; resolving records the resolution, the reply and the actor; a resolved ticket leaves the open list; another board's ticket is a 404.
- [ ] `GET /creators/:slug/tickets`, `PATCH /creators/:slug/tickets/:id`.
- [ ] Notify the reader on resolve, carrying the reply.
- [ ] **Mutation-check:** dropping `HANDLE_REPORTS`, dropping the `creatorId` scope, and resolving without recording the actor must each fail.
- [ ] Commit.

### Task 3: The screens

- [ ] Contact form on the board; dispute entry from a card.
- [ ] `/c/:slug/tickets` inbox with canned replies per resolution.
- [ ] e2e: a patron disputes a de-duplication, a moderator resolves it, the patron is told.
- [ ] Commit.

---

## Known risks

- **The canned replies are a UI convenience only.** Nothing stops a moderator sending a reply that contradicts the resolution recorded beside it.
- **A ticket about a deleted entry loses its subject** (`SetNull`), so the moderator sees the message without the card. The body carries the reader's own words, which is usually enough.
- **No threading**, so a reader who needs to clarify must raise a second ticket. Acceptable now; the first support complaint about it is the signal to revisit.
- **Anonymous tickets, if a creator opts in, are rate-limited by IP alone** — the weakest identifier the limiter has.
