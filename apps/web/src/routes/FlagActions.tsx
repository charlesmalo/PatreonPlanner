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
      const status = error instanceof ApiError ? error.status : 0;
      setMessage(
        status === 409
          ? // Another moderator resolved it first, or this was a double click. "Try again" was
            // the wrong advice: 409 is exactly the status where retrying cannot work, because
            // the report is already resolved and no number of retries changes that.
            'That report has already been handled. Refresh to see how.'
          : status === 403
            ? // Names the permission, not the role. A 403 here almost always means somebody who
              // *does* moderate this board and was never granted HANDLE_REPORTS — telling them
              // they do not moderate it sends them looking for the wrong problem.
              'Handling reports is not one of your permissions on this board.'
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
