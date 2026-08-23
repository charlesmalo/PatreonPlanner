# Viewing As Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** A moderator can see their board as a patron sees it, and can tell at a glance which of the two they are looking at.

**Architecture:** A presentation filter over the capabilities the server already returned. `useCreator` yields the real capabilities; a wrapper narrows them when the reader has chosen patron view. Nothing about the request changes.

## The rule this must not break

**The mode is presentation only.** The server keeps enforcing real capabilities regardless of what the tab believes. If the mode ever became an authorization input — a header, a query parameter, anything the server reads — then a client-side toggle would be a security boundary, and the whole access model would rest on a checkbox the browser controls.

So: narrowing hides controls. It never grants anything, and the server is never told.

## Decisions this plan settles

1. **Narrowing only.** Patron view removes `moderate` and `administer`. It cannot add a capability the server did not grant, so the worst a broken toggle can do is hide a button.
2. **No re-authentication on switching.** It trains people to click through auth prompts, and the goal — preventing accidental writes — is better served by an unmistakable indicator. Design settled this in discussion.
3. **An acknowledgement after inactivity instead.** Returning to a tab left open for hours and finding it in moderator mode is how an accidental change happens. Switching *into* moderator view after `ACK_AFTER_MS` of inactivity asks for confirmation, with "don't ask again for 24 hours".
4. **The choice is per reader and local**, like column collapse: it is not board configuration and nobody else can see it.
5. **The banner is text plus colour, never colour alone.** A colourblind moderator gets nothing from a tint, and this is the signal that stops a mistaken edit.

## Scope

**In:** a mode switch in the header; capability narrowing; a banner while narrowed; the inactivity acknowledgement; persistence per board.

**Out, with reasons:**
- *Impersonating a specific tier.* "What does a $5 patron see" is a different feature — it needs the server to answer as someone else, which is exactly what decision 1 forbids doing client-side.
- *A separate logo per role.* The design doc keeps the logo fixed as the page's one landmark and puts the role on a badge beside it.
- *Remembering the mode across boards.* A moderator on one board is a patron on another; carrying the choice between them would answer the wrong question.

## File Structure

- `apps/web/src/api/hooks.ts` — `useViewMode`, and narrowing inside `useCreator`.
- `apps/web/src/components/ViewModeSwitch.tsx` + test.
- `apps/web/src/components/ModeBanner.tsx` + test.
- `apps/web/src/routes/CreatorBoard.tsx` — mount both.

---

### Task 1: The mode, and what it narrows

- [ ] **Failing tests:** moderator view yields the server's capabilities unchanged; patron view drops `moderate` and `administer` and keeps `view`/`upvote`/`submit`; patron view **cannot** add a capability the server withheld; a reader with no moderator capability is never offered the switch.
- [ ] `useViewMode(slug)` — `localStorage`, per board, defaulting to moderator view for staff.
- [ ] Narrow in `useCreator`, so no call site can forget.
- [ ] **Mutation-check:** making the narrowing additive must fail.
- [ ] Commit.

### Task 2: Saying which one you are in

- [ ] **Failing tests:** the switch names both modes; choosing patron view shows a banner; the banner names the mode in text, not only colour; moderator view shows no banner; the choice survives a remount.
- [ ] `ViewModeSwitch`, `ModeBanner`.
- [ ] Commit.

### Task 3: The acknowledgement

- [ ] **Failing tests:** switching to moderator view after inactivity asks for confirmation; confirming switches; declining stays; "don't ask again" suppresses it for 24 hours; a fresh session does not ask.
- [ ] Track last interaction; compare on switch.
- [ ] **Mutation-check:** removing the inactivity check must fail.
- [ ] Commit.

### Task 4: On the board

- [ ] Mount both; e2e — a moderator switches to patron view, the moderator controls disappear, and the server still refuses nothing (the controls are simply not offered).
- [ ] Commit.

---

## Known risks

- **A reader in patron view may be confused when an action they expect is missing.** The banner says why; nothing else does.
- **The acknowledgement is time-based, so a clock change can trip it.** Harmless — it asks once more than needed.
- **Narrowing is client-side, so a determined reader can restore their own controls** with devtools. That is fine, and is the point of decision 1: the server refuses them anyway.
