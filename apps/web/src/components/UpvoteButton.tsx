import { useState } from 'react';
import { ApiError, api } from '../api/client';
import type { UpvoteResult } from '../api/types';

interface UpvoteButtonProps {
  slug: string;
  recommendationId: string;
  upvoteCount: number;
  canUpvote: boolean;
  onCount: (id: string, count: number) => void;
}

export function UpvoteButton({
  slug,
  recommendationId,
  upvoteCount,
  canUpvote,
  onCount,
}: UpvoteButtonProps) {
  const [pressed, setPressed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    setBusy(true);
    setError(null);
    const optimistic = pressed ? upvoteCount - 1 : upvoteCount + 1;
    // Optimistic: a toggle that waits a round-trip feels broken, and the endpoint returns the
    // authoritative count to reconcile against.
    onCount(recommendationId, optimistic);
    setPressed(!pressed);
    try {
      const result = await api.post<UpvoteResult>(
        `/creators/${encodeURIComponent(slug)}/recommendations/${recommendationId}/upvote`,
      );
      onCount(recommendationId, result.upvoteCount);
      setPressed(result.upvoted);
    } catch (err) {
      onCount(recommendationId, upvoteCount);
      setPressed(pressed);
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
        title={canUpvote ? 'Upvote this suggestion' : 'Upvoting is for patrons'}
        className="flex w-14 flex-col items-center rounded border border-slate-300 py-2 text-sm font-medium enabled:hover:bg-slate-100 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:enabled:hover:bg-slate-800"
      >
        <span aria-hidden="true">▲</span>
        <span>{upvoteCount}</span>
        <span className="sr-only">upvotes</span>
      </button>
      {error ? (
        <span role="status" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </span>
      ) : null}
    </div>
  );
}
