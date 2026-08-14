import { useId, useState } from 'react';
import { ApiError, api } from '../api/client';
import type { CreatorNote } from '../api/types';

interface NoteEditorProps {
  slug: string;
  recommendationId: string;
  onWritten: (note: CreatorNote) => void;
}

/** Staff-only, so it lives in the review queue rather than on the card. */
export function NoteEditor({ slug, recommendationId, onWritten }: NoteEditorProps) {
  // Defaults to commentary: a TIMELINE note is public the moment it is written, and there is no
  // draft state to take it back with.
  const [kind, setKind] = useState<'NOTE' | 'TIMELINE'>('NOTE');
  const [body, setBody] = useState('');
  const [plannedFor, setPlannedFor] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const kindId = useId();
  const bodyId = useId();
  const dateId = useId();

  async function write() {
    if (body.trim().length === 0) {
      setMessage('Write something first.');
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const note = await api.post<CreatorNote>(
        `/creators/${encodeURIComponent(slug)}/recommendations/${recommendationId}/notes`,
        {
          kind,
          body: body.trim(),
          // Only ever on a timeline note: the API rejects it on commentary, and so does the
          // database.
          ...(kind === 'TIMELINE' && plannedFor
            ? { plannedFor: new Date(plannedFor).toISOString() }
            : {}),
        },
      );
      onWritten(note);
      setBody('');
      setPlannedFor('');
    } catch (error) {
      setMessage(
        error instanceof ApiError && error.status === 400
          ? 'That note was rejected. Try rewording it.'
          : error instanceof ApiError && error.status === 409
            ? 'That entry already has too many notes.'
            : 'Could not add that note. Try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 space-y-2 rounded border border-slate-200 p-2 dark:border-slate-800">
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label htmlFor={kindId} className="block text-xs font-medium">
            Kind
          </label>
          <select
            id={kindId}
            value={kind}
            onChange={(event) => setKind(event.target.value as 'NOTE' | 'TIMELINE')}
            className="mt-1 rounded border border-slate-300 px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900"
          >
            <option value="NOTE">Private note</option>
            <option value="TIMELINE">Timeline (public)</option>
          </select>
        </div>
        {kind === 'TIMELINE' ? (
          <div>
            <label htmlFor={dateId} className="block text-xs font-medium">
              When (optional)
            </label>
            <input
              id={dateId}
              type="date"
              value={plannedFor}
              onChange={(event) => setPlannedFor(event.target.value)}
              className="mt-1 rounded border border-slate-300 px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900"
            />
          </div>
        ) : null}
      </div>

      {kind === 'TIMELINE' ? (
        <p className="text-[10px] text-slate-500 dark:text-slate-400">
          Patrons will see this on the board as soon as you add it.
        </p>
      ) : null}

      <div>
        <label htmlFor={bodyId} className="block text-xs font-medium">
          Note
        </label>
        <textarea
          id={bodyId}
          value={body}
          maxLength={2000}
          rows={2}
          onChange={(event) => setBody(event.target.value)}
          className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900"
        />
      </div>

      <button
        type="button"
        onClick={write}
        disabled={busy}
        className="rounded bg-slate-800 px-3 py-1 text-xs text-white disabled:opacity-50 hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:bg-slate-200 dark:text-slate-900"
      >
        {busy ? 'Adding…' : 'Add note'}
      </button>
      {message ? (
        <p role="status" aria-live="polite" className="text-xs text-red-600 dark:text-red-400">
          {message}
        </p>
      ) : null}
    </div>
  );
}
