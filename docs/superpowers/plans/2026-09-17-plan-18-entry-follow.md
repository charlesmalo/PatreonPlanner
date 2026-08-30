# Following One Entry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a reader say "tell me about *this one*", which is what was asked for originally and what themes cannot express.

**Architecture:** A `(reader, entry)` row. The fan-out audience becomes the union of *people who follow the board* and *people who follow this entry*, both then put through the same visibility check.

**Tech Stack:** NestJS 10, Prisma 5, React 18, Jest + Testcontainers, Vitest + RTL.

## Global Constraints

- **Free tier only.** No new dependency.
- **Visibility is resolved for everybody in the audience.** A follow is a wish, not an entitlement — somebody who followed an entry and then let their pledge lapse must stop hearing about it, exactly like a board follower.
- **404 not 403** for an entry the reader may not see.

---

## Why themes were not enough

Themes come from TMDB's genres and keywords — *anime*, *dystopia*, *space opera*. The original request was "tell me when they update Apothecary Diaries and Demon Slayer, but not One Piece", which is three titles and no categories. No arrangement of a genre vocabulary expresses it.

This is the other half rather than a replacement: themes for breadth, a follow for the one show somebody is waiting on.

## Decisions this plan settles

- **A follow beats the theme narrowing.** Statuses answer *what counts as news*; themes and follows both answer *about what*, and a follow is the most specific answer available. Someone who narrowed to anime and then followed a documentary meant it.
- **A follow does not beat the status narrowing.** A reader who asked to hear only about Now Playing asked that about everything, including the show they are waiting on. The two compose: the columns you chose, for the things you chose.
- **Following an entry works on a board you have not favourited.** This is the case that makes the feature worth building — "that board is too noisy to follow, but tell me about this one thing" was in the original request in as many words.
- **It follows the entry, not the title.** The notification is about something moving on a *board*, and a title is shared across boards. Following the entry keeps the question and the answer on the same board, and de-duplication means a resubmission resolves to the same row rather than a new one.

## Scope

**In:** the `EntryFollow` model; the union in the fan-out; follow and unfollow endpoints; a control on the card.

**Out, with reasons:**
- *Following a title across every board.* A different feature with a different privacy story — it says which boards you read.
- *Following a theme on one board but not another.* That is what the per-board preference already is.

---

### Task 1: The follow, and who it reaches

- [ ] **Failing tests:** a follower of an entry hears about it; a follow beats theme narrowing; a follow does not beat status narrowing; it works without favouriting the board; somebody who may not see the board hears nothing however hard they followed; the actor and submitter are still excluded; unfollowing stops it; following twice is one row.
- [ ] Schema + migration; union in `audienceFor`.
- [ ] **Mutation-check:** dropping the union; letting a follow bypass the visibility check; letting it bypass the status filter; applying the theme filter to a followed entry.
- [ ] Commit.

### Task 2: Asking for it

- [ ] **Failing tests:** `POST`/`DELETE /creators/:slug/recommendations/:id/follow`; an entry on another board is a 404; an anonymous reader is refused; the card shows the state and toggles it.
- [ ] Commit.

## Known risks

- **The audience query grows a second source.** It is still two statements, but "who hears about this" now has two answers to keep in step — and only the visibility filter is common to both.
- **A followed entry that is deleted takes its follows with it**, by cascade. Correct, and it means a reader is never told why something stopped arriving.
