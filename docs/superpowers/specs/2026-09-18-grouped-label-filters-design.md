# Grouped Label Filters — Design

**Status:** every section is **proposed**. Nothing here is built. Decisions marked **OPEN** need an
answer before the plan that touches them.

**What this covers:** letting a reader express `(A) OR (B AND Y) OR (C AND X)` over a board's
labels, by combining filter chips into groups.

**What it builds on:** the multi-select OR filter shipped in #131 — *Filter labels* inside each
column, selection shared across tabs, persisted locally. That filter is the flat case of what is
described here: today's `[Anime] [Thriller]` is `(Anime) OR (Thriller)`, which stays exactly what
it means. **Nothing in this design changes the behaviour of an ungrouped filter.**

**What it does not change:** the access model, what a label is, or the `/themes` management page.
Labels are still `Theme` rows server-side; only how a reader combines them changes.

---

## 1. The model

A filter is an **OR of groups**; a group is an **AND of labels**. That is disjunctive normal form,
and it is not a general boolean expression on purpose — it is precisely what the interaction can
express, so the model and the UI cannot drift apart.

```
(A) OR (B AND Y) OR (C AND X) OR (Z)
```

Client state is `string[][]` — an array of groups, each an array of label ids. Today's flat
selection is the degenerate case where every group has one member.

**A label appears at most once across the whole filter.** `(A AND B) OR (A)` is redundant — the
second term can never add a row the first did not — and allowing it would let a reader build a
filter whose parts contradict their own reading of it. Combining a label into a group removes it
from wherever it was.

### Ordering — **decided: insertion order, preserved**

Groups keep the order they were made, and members the order they were combined. It is the only
order a reader can predict, and the wire format sorts nothing, so a filter reads the same as the
chips look.

---

## 2. The interaction

### Coupling — **decided: a menu, with drag as a shortcut**

Each chip carries a **Combine with…** menu listing the other groups currently filtering. Choosing
one merges this chip into that group.

Drag-and-drop does the same thing: drop a chip onto another and they combine.

The menu is the accessible path and the drag is the shortcut — the same split entry grouping
already uses, for the reason `drag.ts` states plainly: native drag *"does nothing on touch"*, and
nothing from a keyboard. A grouping mechanism reachable only by drag would be unreachable on the
phones this demo is tested from, and the codebase has already decided that question once.

### Decoupling — **decided: magnets between members**

A group renders its members joined by **magnets** — one between each adjacent pair. Clicking a
magnet splits the group **at that point**:

```
(Anime ─●─ Thriller ─●─ Long Watch)
         ↑
   split here  →  (Anime) OR (Thriller AND Long Watch)
```

A magnet is a button, named for what it does to which labels: *"Split between Anime and
Thriller"*. Splitting a two-member group returns both labels to ordinary chips.

### Removal — **decided: one ✕ per group**

An ungrouped chip keeps its own ✕, as shipped. A **group** has a single ✕ that removes the whole
group from the filter; its members do not keep individual ✕ buttons. Removing part of a group is
what the magnets are for, and two overlapping ways to take a label out of a group would make
neither obvious.

### Focus — **decided**

Every one of these controls destroys the element that was clicked, so focus has to be placed
deliberately or it falls to `<body>`:

| action | focus goes to |
| --- | --- |
| combine (menu or drop) | the resulting group's **Combine with…** trigger |
| split at a magnet | the **left** resulting group's trigger |
| remove a group with ✕ | the toggle for its first member, which returns to the label list |

That last row reuses what #131 already does: the label list is stable, so a label's own toggle is
always somewhere to land.

### Announcements — **decided**

The existing polite live region grows to read the whole expression in words rather than symbols:

> Filtering by Anime, or Thriller and Long Watch.

Symbols do not read aloud usefully, and a screen-reader user has no chips to look at.

---

## 3. The wire format

### Encoding — **decided: `themes=a|b,c`**

`,` separates groups, `|` separates members within a group. `themes=a|b,c` is `(a AND b) OR (c)`.

This extends #131's format rather than replacing it: `themes=a,b` still parses, still means
`(a) OR (b)`, and an old client keeps working. One parameter, readable in a log, and no
array-versus-string duality from repeated parameters.

**Validation.** Every id must be a UUID and must belong to this board; one bad id refuses the whole
filter with 404, as it does today. Additionally:

- at most 20 ids in total, as today
- at most 8 groups, and at most 8 members in a group
- a label may not appear twice anywhere in the expression — **400**, not a silent de-duplication,
  because a client sending one has a bug and hiding it makes that bug harder to find

### The query — **decided**

```ts
OR: groups.map((group) => ({
  AND: group.map((themeId) => ({ title: { themes: { some: { themeId } } } })),
}))
```

Each group is an AND of `some` clauses — an entry must carry *every* label in the group. The OR
sits across groups.

**This must be composed inside the existing `AND`, never spread alongside it.** The board's where
clause already carries an `AND` holding visibility and the keyset cursor, and it already carries a
comment recording what happened when a disjunction was spread instead: page one was correct and
every page after it leaked rejected, deleted and other patrons' pending entries. A second `OR` key
at the top level would repeat that exactly.

**No duplicate rows.** A single-label group uses `some`, which matches a row once however many of
its labels hit. An entry carrying every label of a group still matches once. Keyset pagination
cannot survive a duplicated row, and there is already a test for the flat case to extend.

---

## 4. What the reader sees when a group matches nothing

An AND group is narrow by construction, and on a real board most pairs of labels never co-occur.
Measured on the demo board: of ten possible pairs across five labels, **five never co-occur at
all**, and the largest overlap is four entries between two near-synonyms.

So the common outcome of combining two labels is an empty column — which reads as a broken filter
rather than a true answer.

### **OPEN** — how much to say about it

| option | cost |
| --- | --- |
| Say nothing | Cheapest. The column's existing empty text appears, and the reader guesses whether they broke it |
| Empty state names the filter | *"No entries carry both Anime and Documentary."* Honest and cheap, and it explains the zero without claiming anything about other columns |
| Disable impossible combinations | Truthful and unguessable — but needs per-label co-occurrence counts the API does not expose, and they would have to be recomputed per column |

**Recommendation: the second.** It costs one string, it turns a confusing empty column into an
answer, and it does not need the API to learn anything new.

---

## 5. Persistence

The stored value becomes the encoded expression — the same string the wire carries — under the
board-level key #131 introduced. `a|b,c` rather than `a,b`.

**A stored filter is validated on read.** Labels get deleted and merged on the `/themes` page, so a
remembered filter can name a label that no longer exists. Unknown ids are dropped from the group
they sit in, an emptied group is dropped, and if nothing survives the filter clears. Silently:
a reader returning to a board does not need an error about a label they may not remember choosing.

Still local only, and still not synced to the server, for the reason #131 gives.

---

## 6. Demo data — **decided: nothing to seed, corrected after measuring**

> **This section was wrong, and is kept with its correction rather than rewritten.** It asserted
> the demo could not show grouping and asked for a seeded pair of co-occurring labels. When the
> implementation reached that task the numbers were measured instead of assumed, and the demo
> already showed both outcomes:
>
> ```
> Animation AND Anime        4 entries
> Animation AND Long Watch   1
> Thriller AND Animation     1
> Thriller AND Anime         1
> Long Watch AND Anime       1
> Thriller AND Long Watch    0
> ```
>
> A group that fills a column and pairs that find nothing both exist, so no seed change was made.
> Retuning deliberately-chosen demo data to produce what it already produces would have been work
> for its own sake. `docs/demo-walkthrough.md` §4c documents both cases instead.
>
> The mistake is the one this repository keeps finding: **written from what the seed looked like
> rather than from what the database held.** The sparsity that prompted it is real — five of the
> ten possible pairs are empty — but "mostly sparse" is not "cannot show it", and one query
> separated the two.

The original text follows.

The demo cannot currently show this. With five labels whose overlaps are almost all zero, a
playtester combining two labels sees an empty column, and the feature looks broken exactly when
they try it.

This is the *"too uniform to show a feature"* problem the tracker records, and the seed is already
deliberately arranged so each mechanic differs visibly from its absence — Producer at 3, one of
Cal's votes stale, Dee's vote added in #127 so grouping's de-duplication shows. Grouping labels
needs the same treatment: at least one pair of labels co-occurring on two or more entries, and one
pair that genuinely co-occurs on none, so both outcomes can be seen.

---

## 7. Sequencing

1. The wire format and query, server-side, with the flat case still passing untouched
2. The `string[][]` model and encoding client-side, with the flat UI unchanged
3. Magnets and the group ✕ — decoupling before coupling, because it is the simpler half and makes
   the coupled state testable before anything can build one
4. The **Combine with…** menu
5. Drag-to-combine, as the shortcut
6. The empty-state wording from §4, and the seed from §6

Each step leaves the board working. Steps 1–2 change nothing a reader can see.

---

## Open questions

1. **§4** — how much the empty column should say when a group matches nothing. Recommendation
   recorded above.
2. **Does a group of one exist?** Splitting a two-member group yields two ordinary chips, and
   combining is only offered between existing chips, so a one-member group should be
   unrepresentable. Worth stating in the plan so the encoder never emits `a|` and the parser
   rejects it.
