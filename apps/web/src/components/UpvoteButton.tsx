import { useState } from 'react';
import { ApiError, api } from '../api/client';
import type { UpvoteResult } from '../api/types';

interface UpvoteButtonProps {
  slug: string;
  recommendationId: string;
  title: string;
  upvoteCount: number;
  hasUpvoted: boolean;
  canUpvote: boolean;
  onCount: (id: string, count: number, upvoted?: boolean) => void;
}

export function UpvoteButton({
  slug,
  recommendationId,
  title,
  upvoteCount,
  hasUpvoted,
  canUpvote,
  onCount,
}: UpvoteButtonProps) {
  // Seeded from the server: without it the control announced "not pressed" for an entry the
  // viewer had already upvoted, and the optimistic delta guessed the wrong direction.
  const pressed = hasUpvoted;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    setBusy(true);
    setError(null);
    const optimistic = pressed ? upvoteCount - 1 : upvoteCount + 1;
    // Optimistic: a toggle that waits a round-trip feels broken, and the endpoint returns the
    // authoritative count to reconcile against.
    onCount(recommendationId, optimistic, !pressed);
    try {
      const result = await api.post<UpvoteResult>(
        `/creators/${encodeURIComponent(slug)}/recommendations/${recommendationId}/upvote`,
      );
      onCount(recommendationId, result.upvoteCount, result.upvoted);
    } catch (err) {
      onCount(recommendationId, upvoteCount, pressed);
      // The flag only decides what renders; the server is what actually decides, so its refusal
      // has to be shown rather than assumed impossible.
      setError(err instanceof ApiError && err.status === 403 ? 'Not allowed' : 'Try again');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-center gap-1">
      <button
        type="button"
        onClick={toggle}
        disabled={!canUpvote || busy}
        aria-pressed={pressed}
        // Names every button distinctly: otherwise a screen reader hears "3 upvotes" with no
        // clue which suggestion it belongs to.
        aria-label={`${pressed ? 'Remove upvote from' : 'Upvote'} ${title} — ${upvoteCount} upvotes`}
        title={canUpvote ? 'Upvote this suggestion' : 'Upvoting is for patrons'}
        className="flex w-14 flex-col items-center rounded border border-slate-300 py-2 text-sm font-medium enabled:hover:bg-slate-100 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:enabled:hover:bg-slate-800"
      >
        <span aria-hidden="true">▲</span>
        <span>{upvoteCount}</span>
        <span className="sr-only">upvotes</span>
      </button>
      {/* Always mounted so the text is a mutation of an existing live region — a region that
          appears already-populated is unreliably announced. */}
      <span role="status" aria-live="polite" className="text-xs text-red-600 dark:text-red-400">
        {error}
      </span>
    </div>
  );
}
