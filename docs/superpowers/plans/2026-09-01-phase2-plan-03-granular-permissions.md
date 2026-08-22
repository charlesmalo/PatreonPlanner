# Granular Moderator Permissions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** An owner decides what each moderator may do, rather than every mod holding every moderator power.

**Architecture:** `MODERATE` stays the coarse gate — it still answers "is this person staff here". A second, finer check runs after it for the specific action. Permissions are stored as a set on the staff row; an owner holds all of them implicitly and cannot be reduced.

## Global Constraints

- Free tooling only.
- **Fail closed.** A permission absent from a staff row is denied. A new permission added later is denied to every existing mod until an owner grants it — the opposite default would silently widen what current mods can do.
- The capability resolver stays pure: no Prisma, no Redis, so authorization stays testable without a database.
- No creator or mod may affect another creator's board. This already holds and is the most heavily tested property in the system.

## Decisions this plan settles

1. **Permissions sit beside `MODERATE`, not inside it.** `can('MODERATE', …)` remains the answer to "is this person staff here", which the review queue, the board and the notification fan-out all ask. Splitting that answer per-action would mean auditing every one of those call sites for which permission it meant.
2. **An owner holds everything, always.** Not by being granted the full set — by the check short-circuiting on `OWNER`. A grantable owner is an owner who can be locked out of their own board.
3. **The set is an array on `CreatorStaff`, not a join table.** It is read on every moderated request and written by one screen; a join table would add a query to the hot path to model a set with at most a dozen members.
4. **Existing mods get everything.** Fail-closed is the rule for *new* permissions, but a migration that silently strips working moderators of powers they had yesterday is a different thing: it would break live boards to satisfy a principle about future grants.
5. **Five permissions, from the five things mods actually do today:** `MOVE_ENTRIES`, `EDIT_ENTRIES`, `HANDLE_REPORTS`, `WRITE_NOTES`, `MANAGE_THEMES`. Each maps to endpoints that already exist. Anything finer invents distinctions nobody has asked for.

## Scope

**In:** `StaffPermission` enum; `CreatorStaff.permissions`; a `RequirePermission` decorator checked in the same guard; the ten `MODERATE` endpoints annotated; grant and revoke on the staff endpoints; the staff page showing and editing them.

**Out, with reasons:**
- *Per-entry or per-theme scoping.* A mod who may move entries may move any of them; scoping to a subset is a different feature with no request behind it.
- *Roles beyond OWNER and MOD.* The permission set is the customisation; a middle role would be a preset, and presets are worth adding once real boards show a shape that repeats.
- *Audit of permission changes.* `ModerationAction` audits what mods do to content; who granted what is a smaller surface, and worth adding when there is a second owner to disagree with.

## File Structure

- `apps/api/prisma/schema.prisma` + migration — `StaffPermission`, `CreatorStaff.permissions`.
- `apps/api/src/access/permissions.ts` — the pure check, beside `capability.ts`.
- `apps/api/src/access/require-permission.decorator.ts`
- `apps/api/src/access/creator-access.guard.ts` — resolve the set, enforce the decorator.
- The five controllers — annotate.
- `apps/api/src/staff/staff.service.ts` + controller — grant and revoke.
- `apps/web/src/routes/StaffPage.tsx` — show and edit.

---

### Task 1: The set, and the pure check

- [ ] **Failing tests** for `hasPermission(viewer, permission)`: an owner holds everything; a mod holds only what is granted; a mod with an empty set holds nothing; a non-staff viewer holds nothing even with a set somehow attached.
- [ ] `enum StaffPermission`; `CreatorStaff.permissions StaffPermission[]`; migration granting every existing mod the full set.
- [ ] `permissions.ts` — pure, `OWNER` short-circuits.
- [ ] Commit.

### Task 2: Enforced where it matters

- [ ] **Failing tests**, one per permission: a mod without it is refused; a mod with it succeeds; an owner succeeds regardless; and — the one that matters — **a mod with a *different* permission is refused**, so the check cannot pass by merely holding something.
- [ ] `RequirePermission` decorator, read in `CreatorAccessGuard` after the capability check.
- [ ] Annotate the ten endpoints.
- [ ] **Mutation-check:** removing the decorator from any endpoint, and making the guard ignore it, must each fail.
- [ ] Commit.

### Task 3: Granting and revoking

- [ ] **Failing tests:** an owner grants and revokes; a mod cannot; a mod cannot grant themselves; an owner's own permissions cannot be reduced; an unknown permission is a 400; another board's staff row is a 404.
- [ ] `PATCH /creators/:slug/staff/:userId/permissions`, `ADMINISTER`.
- [ ] Commit.

### Task 4: The page

- [ ] **Failing tests:** the staff list shows each mod's permissions; an owner toggles one; the owner's own row shows everything and is not editable; a mod viewing the page sees no controls.
- [ ] Extend `StaffPage`.
- [ ] e2e: an owner revokes a mod's report handling, and that mod then cannot resolve a report.
- [ ] Commit.

---

## Known risks

- **Two checks per request** — capability then permission — and a future endpoint could carry the first and forget the second. The mutation check catches today's endpoints; nothing stops tomorrow's from being added without one.
- **A mod can be left holding nothing**, which is a confusing state: they are staff, the board offers them the queue, and every action fails. The page should say so; the API cannot.
- **Permissions are per board, so a mod on two boards has two sets.** Correct, and a support burden the first time someone asks why they can do a thing here and not there.
