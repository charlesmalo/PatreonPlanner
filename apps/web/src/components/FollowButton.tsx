import { useState } from 'react';
import { api } from '../api/client';

interface FollowButtonProps {
  slug: string;
  recommendationId: string;
  title: string;
  following: boolean;
}

/**
 * "Tell me about this one."
 *
 * The thing themes cannot say. Themes are the board's categories — anime, dystopia — and somebody
 * waiting on a particular show is naming a title, not a category.
 *
 * A follow reaches them even on a board they have not favourited, and even when their theme
 * narrowing would have filtered the entry out. It does not override which columns they asked
 * about: a reader who wanted only Now Playing wanted that about everything.
 */
export function FollowButton({ slug, recommendationId, title, following }: FollowButtonProps) {
  const [followed, setFollowed] = useState(following);
  const [busy, setBusy] = useState(false);

  async function toggle() {
    const next = !followed;
    // Optimistic, then reconciled — the pattern the pick control already follows. A control that
    // goes on claiming a change the server refused is worse than one that flickers.
    setFollowed(next);
    setBusy(true);
    try {
      const path = `/creators/${encodeURIComponent(slug)}/recommendations/${recommendationId}/follow`;
      if (next) await api.post(path);
      else await api.del(path);
    } catch {
      setFollowed(!next);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={busy}
      aria-pressed={followed}
      aria-label={`${followed ? 'Stop following' : 'Follow'} “${title}”`}
      className="rounded border border-slate-300 px-2 py-1 text-xs disabled:opacity-50 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:hover:bg-slate-800"
    >
      {followed ? '🔔 Following' : '🔕 Follow'}
    </button>
  );
}
