import { useState } from 'react';
import { ApiError, api } from '../api/client';

/**
 * Resolving or dismissing the report attached to an entry.
 *
 * Its own file because it shares nothing with the queue but two ids — it holds its own busy and
 * message state and talks to its own endpoint. Living inside the queue's file made that file the
 * largest in the app while hiding that this is a self-contained thing.
 */
export function FlagActions({
  slug,
  flagId,
  onResolved,
}: {
  slug: string;
  flagId: string;
  onResolved: () => void;
}) {
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function resolve(status: 'RESOLVED' | 'DISMISSED') {
    setBusy(true);
    setMessage(null);
    try {
      await api.patch(`/creators/${encodeURIComponent(slug)}/flags/${flagId}`, { status });
      onResolved();
    } catch (error) {
      setMessage(
        error instanceof ApiError && error.status === 403
          ? 'You do not moderate this board.'
          : 'Could not update that report. Try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <p className="mt-1 flex gap-2">
      <button
        type="button"
        disabled={busy}
        onClick={() => resolve('RESOLVED')}
        className="rounded border border-slate-300 px-2 py-0.5 disabled:opacity-50 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:hover:bg-slate-800"
      >
        Uphold
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => resolve('DISMISSED')}
        className="rounded border border-slate-300 px-2 py-0.5 disabled:opacity-50 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:hover:bg-slate-800"
      >
        Dismiss
      </button>
      {message ? (
        <span role="status" className="text-red-600 dark:text-red-400">
          {message}
        </span>
      ) : null}
    </p>
  );
}
