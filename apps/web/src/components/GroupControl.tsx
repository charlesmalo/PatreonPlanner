import { useState } from 'react';
import { ApiError, api } from '../api/client';
import type { Recommendation } from '../api/types';

interface GroupControlProps {
  slug: string;
  entry: Recommendation;
  /** Already filtered by `groupTargets`; the column's tree lives with the caller, not here. */
  targets: Recommendation[];
  onChanged: () => void;
}

/**
 * Putting one entry under another, and taking it back out.
 *
 * A menu rather than only a drag, for the reason `drag.ts` gives about the status menu: native
 * drag-and-drop does nothing on touch and nothing from a keyboard. The drop target on the board
 * is a shortcut for people with a mouse; this is how the feature is actually reachable.
 *
 * Grouping **preserves** the child — it keeps its row, its votes and its own page — so the only
 * thing that changes is what the head displays and the de-duplicated total it carries. That is
 * what separates this from merging a theme, where the loser ceases to exist, and it is why the
 * wording here is "group" rather than "merge".
 */
export function GroupControl({ slug, entry, targets, onChanged }: GroupControlProps) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Only a group somebody chose can be undone. A catalogue-implied nesting has nothing to
  // ungroup, and the endpoint returns early on it — a button that did nothing.
  const grouped = entry.parentSource === 'STAFF';
  const path = `/creators/${encodeURIComponent(slug)}/recommendations/${entry.id}/group`;

  function explain(error: unknown): string {
    const status = error instanceof ApiError ? error.status : 0;
    return status === 409
      ? // Pre-filtered, so this is the race: somebody grouped one of the two while this menu was
        // open. 409 is the status where trying again cannot work, so it does not say "try again".
        'That changed while the menu was open. Reload the board.'
      : status === 403
        ? // Names the permission, not the role: grouping is MOVE_ENTRIES, and a moderator without
          // it does moderate this board.
          'Moving entries is not one of your permissions on this board.'
        : 'Could not change that grouping. Try again.';
  }

  async function groupInto(intoId: string) {
    setBusy(true);
    setMessage(null);
    try {
      await api.post(path, { intoId });
      setOpen(false);
      onChanged();
    } catch (error) {
      setMessage(explain(error));
    } finally {
      setBusy(false);
    }
  }

  async function ungroup() {
    setBusy(true);
    setMessage(null);
    try {
      await api.del(path);
      setOpen(false);
      onChanged();
    } catch (error) {
      setMessage(explain(error));
    } finally {
      setBusy(false);
    }
  }

  // Nothing to offer: not grouped, and nowhere to go. Rendering an empty menu would be a control
  // that opens onto nothing.
  if (!grouped && targets.length === 0) return null;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
        // Names the entry, so a screen reader on a long board knows which card this belongs to.
        aria-label={`Group “${entry.customTitle}” with another entry`}
        className="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:hover:bg-slate-800"
      >
        Group
      </button>
      {open ? (
        <ul role="menu" className="mt-1 rounded border border-slate-300 dark:border-slate-700">
          {grouped ? (
            <li>
              <button
                type="button"
                role="menuitem"
                disabled={busy}
                onClick={ungroup}
                className="block w-full px-3 py-1.5 text-left text-xs hover:bg-slate-100 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:hover:bg-slate-800"
              >
                Ungroup
              </button>
            </li>
          ) : (
            targets.map((target) => (
              <li key={target.id}>
                <button
                  type="button"
                  role="menuitem"
                  disabled={busy}
                  onClick={() => groupInto(target.id)}
                  className="block w-full px-3 py-1.5 text-left text-xs hover:bg-slate-100 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:hover:bg-slate-800"
                >
                  {/* Text, never markup: a title is a stranger's words. */}
                  Into “{target.customTitle}”
                </button>
              </li>
            ))
          )}
        </ul>
      ) : null}
      {message ? (
        <p role="status" aria-live="polite" className="mt-1 text-xs text-red-600 dark:text-red-400">
          {message}
        </p>
      ) : null}
    </div>
  );
}
