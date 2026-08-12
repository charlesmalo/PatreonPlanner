import { useId, useState } from 'react';
import { ApiError, api } from '../api/client';

const REASONS: Array<[string, string]> = [
  ['SPAM', 'Spam or advertising'],
  ['HARASSMENT', 'Harassment or hate'],
  ['SEXUAL_CONTENT', 'Sexual content'],
  ['OFF_TOPIC', 'Off topic'],
  ['DUPLICATE', 'Already on the board'],
  ['OTHER', 'Something else'],
];

interface FlagButtonProps {
  slug: string;
  recommendationId: string;
  title: string;
}

export function FlagButton({ slug, recommendationId, title }: FlagButtonProps) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('SPAM');
  const [note, setNote] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reasonId = useId();
  const noteId = useId();

  async function send() {
    setBusy(true);
    setMessage(null);
    try {
      const result = await api.post<{ duplicate: boolean }>(
        `/creators/${encodeURIComponent(slug)}/recommendations/${recommendationId}/flags`,
        // An empty textarea is no note, not an empty one — the API stores null and a moderator
        // should not see a blank line where a reason would be.
        { reason, ...(note.trim() ? { note: note.trim() } : {}) },
      );
      setOpen(false);
      setMessage(
        result.duplicate
          ? 'You already reported this — a moderator will look at it.'
          : 'Reported — thanks. A moderator will take a look.',
      );
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 0;
      setMessage(
        status === 401
          ? 'Sign in to report an entry.'
          : status === 400
            ? 'That report could not be sent. Try rewording it.'
            : 'Could not send that report. Try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={`Report “${title}” to a moderator`}
        className="text-xs text-slate-500 underline hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-slate-400 dark:hover:text-slate-200"
      >
        Report
      </button>
      {open ? (
        <div className="mt-2 space-y-2">
          <div>
            <label htmlFor={reasonId} className="block text-xs font-medium">
              Reason
            </label>
            <select
              id={reasonId}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900"
            >
              {REASONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={noteId} className="block text-xs font-medium">
              What is wrong with it? (optional)
            </label>
            <textarea
              id={noteId}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={1000}
              rows={2}
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900"
            />
          </div>
          <button
            type="button"
            onClick={send}
            disabled={busy}
            className="rounded bg-slate-800 px-3 py-1 text-xs text-white disabled:opacity-50 hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:bg-slate-200 dark:text-slate-900"
          >
            {busy ? 'Sending…' : 'Send report'}
          </button>
        </div>
      ) : null}
      {message ? (
        <p
          role="status"
          aria-live="polite"
          className="mt-1 text-xs text-slate-600 dark:text-slate-300"
        >
          {message}
        </p>
      ) : null}
    </div>
  );
}
