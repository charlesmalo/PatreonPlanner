# Cosmetics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give premium something visible to be — more of the reaction palette we already ship — without taking a single emote away from anyone who has already used one.

**Architecture:** `palette.ts` splits into a free set and a premium set. **Reading is never gated**: an emote that has been used renders for everybody, so a count cannot vanish when somebody's subscription lapses. Only *casting* a premium emote is gated.

**Tech Stack:** NestJS 10, Prisma 5, React 18, Jest + Testcontainers, Vitest + RTL.

## Global Constraints

- **Free tier only.** No new dependency. Amendment A.2 is explicit that premium unlocks *more of the set we already ship* — never uploaded images, which mean storage, a CDN bill and a moderation surface worse than text.
- **Premium never enters `can(capability, viewer, policy)`.** It is a `User` property and a rendering hint, not an authorization input.
- **Nothing already cast is taken away.** A lapsed subscription stops new premium reactions; it does not remove old ones or hide their counts.

---

## Why this is the safe premium feature

It costs nothing to serve, cannot be abused, and withholds no functionality: reacting works for everybody, and there are six perfectly good emotes in the free set. §10 already built reactions on their own merits rather than as a premium hook, which is what makes attaching one to them honest now.

`palette.ts` predicted this exact change: *"splitting this into free and premium tiers would implement an undecided answer; when it is decided, the split happens here."* Amendment A.2 decided it.

## Decisions this plan settles

- **The premium set stays non-derogatory.** A reaction hangs off somebody's suggestion, and a downvote-shaped emote turns hype into a pile-on — which is precisely what §10 separated reactions from upvotes to avoid. Additions are positive or neutral: 🍿 🧠 🥹 ⭐ 🎯 🫶.
- **Reads are never gated.** Gating them would make a count disappear when a reactor's subscription lapsed, which is both a lie about the data and a clawback.
- **`/auth/me` carries `isPremium`.** Premium is a `User` property, so the session payload is where it belongs — not on a per-board response, and never in `Viewer`.
- **A locked emote is shown disabled, not hidden.** Same reasoning as the notification settings: this reader is eligible to buy the thing, and a control that vanishes teaches nothing. The opposite of the link-review controls, which are hidden because the API refuses that reader outright.

## Scope

**In:** the palette split; the write gate; `isPremium` on `/auth/me`; the reaction bar showing locked emotes as locked.

**Out, with reasons:**
- *Colour schemes and board themes.* A separate surface with its own storage question, and worth doing after this proves the gate's shape.
- *Profile flair.* It renders on somebody else's board, so it needs the creator toggle §10 gave reactions — a bigger change than the palette.

---

### Task 1: The palette splits

- [x] **Failing tests:** a free reader may cast a free emote; a free reader casting a premium one is refused with 402; a premium reader may cast either; an already-cast premium reaction still renders and still counts for a reader who is not premium.
- [x] Split `palette.ts`; gate the write in `reactions.service.ts`; keep every read ungated.
- [x] **Mutation-check:** dropping the gate; gating reads as well as writes; putting a premium emote in the free set.
- [x] Commit.

### Task 2: The reader can see what they would get

- [x] **Failing tests:** `/auth/me` reports `isPremium`; a free reader sees the premium emotes disabled with a reason; a premium reader can click them; a locked emote that already has a count still shows its count.
- [x] Commit.

## What it found

**A pre-existing test iterated the whole palette expecting success**, which broke the moment the
palette grew a gated half. It is a test about *ordering* — that a reaction never moves an entry —
so it now uses the free set and stays independent of what premium contains.

**The `/api/v1/me` shape test caught the new field**, which is the invariant doing its job. It
gained two cases while being updated: that premium is reported as a boolean and that the date
behind it never reaches the client — a date on the wire invites a client to compare it against its
own clock, and a device with a wrong clock would grant itself premium.

**`useSession` could not be called from the reaction bar.** It fetches, and the bar renders once
per entry, so a hook there turns one question into one request per card. The flag is threaded from
the board instead, the way `permissions` already is.

## Known risks

- **The two palettes must stay in step across the API and the SPA**, as the single one already has to. A premium emote the client offers and the server rejects is a worse failure than one it never offers, and only an integration test would catch the drift.
- **Nothing writes `premiumUntil` yet**, so in practice everybody sees the locked half. That is the gate working, but it means the feature is unexercised by real use until billing exists.
