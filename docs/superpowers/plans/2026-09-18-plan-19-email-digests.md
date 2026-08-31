# Email Digests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One email a day summarising what happened on the boards a reader follows — for readers who asked for it, and nobody else.

**Architecture:** The digest reads the **notification rows that already exist**. It is not a second source of events and not a second implementation of who may hear what: those rows were filtered at fan-out by visibility, status, theme and follow, so the digest inherits every one of those decisions for free.

**Tech Stack:** NestJS 10, Prisma 5, BullMQ (already wired), Resend behind a thin sender interface.

## Global Constraints

- **Free tier.** Resend's free tier is **3,000 emails a month, 100 a day**. A daily digest is one email per reader per day, so that ceiling is roughly **100 readers**. Per-event email would have been that many times the number of moves, which is the reason Amendment A.4 chose a digest before anybody knew what the provider would be.
- **The provider is behind one interface.** Resend today; Brevo, MailerSend or anything else should be one file.
- **Optional as a set.** No API key means no digests, and the app runs exactly as it does now.

---

## The address was given for signing in

Every email address here came from Patreon's OAuth, for authentication. Sending a digest to it is a **different purpose from the one it was handed over for**, and that is not a detail to be settled by a default.

So:

- **Digests are opt-in.** Default off, for everybody, including people who already have accounts.
- **Unsubscribe works without signing in**, because it has to work from a mail client. That means a signed token in the URL — an HMAC over the user id, not the id itself, or anybody could unsubscribe anybody by counting.
- **Every digest carries the unsubscribe link.** Not because a provider demands it, though they do.

## Decisions this plan settles

- **One digest per reader, not per board.** Cheaper by however many boards they follow, and nobody wants six emails at eight in the morning.
- **The digest reads notifications, not events.** Anything the bell would not have shown them cannot appear in the email. No second answer to "may they see this".
- **A failed send does not advance the watermark.** `lastDigestAt` moves only when the provider accepted the message; otherwise tomorrow's digest still contains today's news.
- **Nothing is sent from a request.** The job tick only — an HTTP handler that sends email is an HTTP handler that times out.
- **Empty digests are not sent.** A daily email saying nothing happened is how people unsubscribe.

## Scope

**In:** `User.emailDigest` and `lastDigestAt`; the unsubscribe token and endpoint; the sender interface with a Resend implementation; the assembly and the job; the opt-in control.

**Out, with reasons:**
- *Per-board digest scheduling.* One a day is the product; hourly is a notification, and that is what the bell is.
- *HTML templating beyond a plain list.* A digest is a list of things that happened with links. Anything richer needs a template system and a preview surface.
- *Bounce and complaint handling.* Needed before real volume, and it needs the provider's webhook — which is the same unverified-contract problem billing has. Named in the risks rather than guessed at.

## File Structure

- `apps/api/prisma/schema.prisma` + migration — `emailDigest`, `lastDigestAt`.
- `apps/api/src/email/email-sender.ts` — the interface, and a no-op for when nothing is configured.
- `apps/api/src/email/resend.sender.ts` — the only file that knows the provider.
- `apps/api/src/email/digest.service.ts` — who gets what, and what it says. No network.
- `apps/api/src/email/digest.job.ts` — on the existing tick.
- `apps/api/src/email/unsubscribe.controller.ts` + token service.
- `apps/web/src/routes/NotificationSettings.tsx` — the opt-in.

---

### Task 1: Who gets a digest, and what is in it

- [ ] **Failing tests:** a reader who opted in with unread news gets one; a reader who did not opt in gets nothing however much news there is; an empty digest is not sent; news already read is not repeated; news since the last digest is included; the watermark does not move when the send fails; a reader with no address is skipped.
- [ ] Schema, migration, `digest.service.ts`.
- [ ] **Mutation-check:** sending to somebody who never opted in; sending an empty digest; advancing the watermark on failure.
- [ ] Commit.

### Task 2: Actually sending it

- [ ] **Failing tests:** the sender is called with the reader's address and a body naming what moved; no key configured means nothing is sent and nothing fails; a provider error is logged and does not stop the batch.
- [ ] `email-sender.ts`, `resend.sender.ts`, `digest.job.ts` on the tick.
- [ ] **Mutation-check:** a failing provider stopping the batch.
- [ ] Commit.

### Task 3: Asking for it, and stopping it

- [ ] **Failing tests:** the token verifies for its own user and no other; a tampered token is refused; unsubscribing turns the flag off; it works with no session; the opt-in control reflects and changes the setting.
- [ ] **Mutation-check:** accepting an unsigned id; accepting another user's token.
- [ ] Commit.

## Known risks

- **Deliverability needs a verified sending domain.** Without SPF and DKIM on a domain the sender controls, digests land in spam and the free tier is spent on mail nobody sees. This needs DNS records and cannot be done from here.
- **Bounces and complaints are not handled.** Providers suspend senders who ignore them. Fine at the volume the free tier allows; not fine after.
- **100 emails a day is the ceiling**, and it is reached at 100 opted-in readers. The next tier is the first recurring bill this project would carry.
- **The contract with Resend is unverified**, exactly as billing's was — the shape of a send request is my reading of their documentation, not a response I have seen.
