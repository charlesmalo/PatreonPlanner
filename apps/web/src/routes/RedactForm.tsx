import { useState } from 'react';
import { ApiError, api } from '../api/client';
import type { ReviewQueueItem } from '../api/types';

/**
 * Editing an entry's title and description in place, which is what redaction is here.
 *
 * Seeded from the entry and owns its own draft: the queue is not told anything until a save
 * succeeds, so abandoning the form leaves the row exactly as it was.
 */
export function RedactForm({
  slug,
  item,
  onDone,
}: {
  slug: string;
  item: ReviewQueueItem;
  onDone: (changes: Partial<ReviewQueueItem>) => void;
}) {
  const [customTitle, setCustomTitle] = useState(item.customTitle);
  const [description, setDescription] = useState(item.description ?? '');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    // Only what actually changed: the API rejects an empty PATCH rather than writing an audit
    // row for an edit that did not happen, and sending unchanged fields would fake one.
    const changes: Record<string, string> = {};
    if (customTitle !== item.customTitle) changes.customTitle = customTitle;
    if (description !== (item.description ?? '')) changes.description = description;
    if (Object.keys(changes).length === 0) {
      setMessage('Nothing changed.');
      return;
    }

    setBusy(true);
    setMessage(null);
    try {
      const updated = await api.patch<{ customTitle: string; description: string | null }>(
        `/creators/${encodeURIComponent(slug)}/recommendations/${item.id}`,
        changes,
      );
      onDone({ customTitle: updated.customTitle, description: updated.description });
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 0;
      setMessage(
        status === 400
          ? 'That text was rejected. Try rewording it.'
          : status === 403
            ? 'You do not moderate this board.'
            : 'Could not save that redaction. Try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 space-y-2 rounded border border-slate-200 p-3 dark:border-slate-800">
      <div>
        <label htmlFor={`title-${item.id}`} className="block text-xs font-medium">
          Title
        </label>
        <input
          id={`title-${item.id}`}
          value={customTitle}
          maxLength={200}
          onChange={(event) => setCustomTitle(event.target.value)}
          className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-900"
        />
      </div>
      <div>
        <label htmlFor={`desc-${item.id}`} className="block text-xs font-medium">
          Description
        </label>
        <textarea
          id={`desc-${item.id}`}
          value={description}
          maxLength={2000}
          rows={3}
          onChange={(event) => setDescription(event.target.value)}
          className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-900"
        />
      </div>
      <button
        type="button"
        onClick={save}
        disabled={busy}
        className="rounded bg-slate-800 px-3 py-1 text-xs text-white disabled:opacity-50 hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:bg-slate-200 dark:text-slate-900"
      >
        {busy ? 'Saving…' : 'Save redaction'}
      </button>
      {message ? (
        <p role="status" aria-live="polite" className="text-xs text-red-600 dark:text-red-400">
          {message}
        </p>
      ) : null}
    </div>
  );
}
