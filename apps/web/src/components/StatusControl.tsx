import { useState } from 'react';
import { ApiError, api } from '../api/client';

/**
 * The API's transition map, mirrored so the menu never offers a move the server will refuse with
 * a 409. This is a rendering hint like every other capability in the SPA — the server is what
 * actually enforces the lifecycle, and a drift here costs a clear error message, not safety.
 */
const NEXT: Record<string, string[]> = {
  PENDING: ['ACCEPTED', 'REJECTED', 'DELETED'],
  ACCEPTED: ['ACTIVE', 'REJECTED', 'DELETED'],
  ACTIVE: ['COMPLETED', 'REJECTED', 'DELETED'],
  COMPLETED: ['REJECTED', 'DELETED'],
  REJECTED: ['PENDING', 'DELETED'],
  DELETED: ['PENDING'],
};

/** Design §7's column names, which is what a moderator sees on the board. */
export const STATUS_LABELS: Record<string, string> = {
  PENDING: 'Suggestions',
  ACCEPTED: 'Accepted',
  ACTIVE: 'Now Playing',
  COMPLETED: 'Completed',
  REJECTED: 'Rejected',
  DELETED: 'Deleted',
};

const MENU_LABELS: Record<string, string> = { ...STATUS_LABELS, ACCEPTED: 'Accepted' };

interface StatusControlProps {
  slug: string;
  recommendationId: string;
  title: string;
  status: string;
  onChanged: (id: string, status: string) => void;
}

export function StatusControl({
  slug,
  recommendationId,
  title,
  status,
  onChanged,
}: StatusControlProps) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function move(next: string) {
    setBusy(true);
    setMessage(null);
    try {
      const result = await api.post<{ id: string; status: string }>(
        `/creators/${encodeURIComponent(slug)}/recommendations/${recommendationId}/status`,
        { status: next },
      );
      setOpen(false);
      onChanged(result.id, result.status);
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 0;
      const conflict = error instanceof ApiError ? error.conflict : undefined;
      setMessage(
        status === 409
          ? conflict === 'STALE'
            ? // Somebody else moved it while this menu was open. Saying "not allowed from here"
              // was wrong: the move asked for may be perfectly legal from where the entry now
              // is, and it sent moderators hunting for a rule that was never the problem.
              'Someone else moved this entry. Reload to see where it is now.'
            : 'That move is not allowed from here.'
          : status === 403
            ? // Not "you do not moderate this board": the likeliest 403 here is a moderator who
              // does moderate it and was never granted MOVE_ENTRIES, and telling them otherwise
              // sends them looking for the wrong problem.
              'Moving entries is not one of your permissions on this board.'
            : status === 401
              ? 'Sign in to moderate.'
              : 'Could not move that entry. Try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
        // Names the entry, so a screen reader on a long board knows which card this belongs to.
        aria-label={`Move “${title}” to another column`}
        className="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:hover:bg-slate-800"
      >
        Move
      </button>
      {open ? (
        <ul role="menu" className="mt-1 rounded border border-slate-300 dark:border-slate-700">
          {(NEXT[status] ?? []).map((next) => (
            <li key={next}>
              <button
                type="button"
                role="menuitem"
                disabled={busy}
                onClick={() => move(next)}
                className="block w-full px-3 py-1.5 text-left text-xs hover:bg-slate-100 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:hover:bg-slate-800"
              >
                {MENU_LABELS[next] ?? next}
              </button>
            </li>
          ))}
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
