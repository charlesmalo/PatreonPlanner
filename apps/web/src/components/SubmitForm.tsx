import { useState } from 'react';
import { ApiError, api } from '../api/client';
import type { Recommendation, SubmitResult } from '../api/types';

interface SubmitFormProps {
  slug: string;
  onCreated: (recommendation: Recommendation) => void;
}

const MAX_TITLE = 200;
const MAX_DESCRIPTION = 2000;

export function SubmitForm({ slug, onCreated }: SubmitFormProps) {
  const [customTitle, setCustomTitle] = useState('');
  const [description, setDescription] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    // Mirrors the DTO's bounds so the common mistake costs no round-trip — a convenience, not a
    // control; the server's 400 is still rendered when it disagrees.
    if (customTitle.trim().length === 0) {
      setMessage('Give it a title.');
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const result = await api.post<SubmitResult>(
        `/creators/${encodeURIComponent(slug)}/recommendations`,
        {
          type: 'EXTERNAL_LINK',
          customTitle: customTitle.trim(),
          ...(description.trim() ? { description: description.trim() } : {}),
          ...(url.trim() ? { links: [{ url: url.trim() }] } : {}),
        },
      );
      if (result.duplicate) {
        setMessage('That one is already on the board — upvote it instead.');
      } else {
        setMessage('Added. It is pending review.');
      }
      onCreated(result.recommendation);
      setCustomTitle('');
      setDescription('');
      setUrl('');
    } catch (err) {
      setMessage(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900"
    >
      <h2 className="font-medium">Suggest something</h2>
      <div className="mt-3 space-y-3">
        <div>
          <label htmlFor="rec-title" className="block text-sm font-medium">
            Title
          </label>
          <input
            id="rec-title"
            value={customTitle}
            maxLength={MAX_TITLE}
            onChange={(e) => setCustomTitle(e.target.value)}
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:bg-slate-950"
          />
        </div>
        <div>
          <label htmlFor="rec-description" className="block text-sm font-medium">
            Why? <span className="font-normal text-slate-500">(optional)</span>
          </label>
          <textarea
            id="rec-description"
            value={description}
            maxLength={MAX_DESCRIPTION}
            rows={3}
            onChange={(e) => setDescription(e.target.value)}
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:bg-slate-950"
          />
        </div>
        <div>
          <label htmlFor="rec-url" className="block text-sm font-medium">
            Link <span className="font-normal text-slate-500">(optional)</span>
          </label>
          <input
            id="rec-url"
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:bg-slate-950"
          />
        </div>
      </div>
      <button
        type="submit"
        disabled={busy}
        className="mt-4 rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:bg-slate-100 dark:text-slate-900"
      >
        {busy ? 'Sending…' : 'Suggest'}
      </button>
      {message ? (
        <p role="status" className="mt-3 text-sm text-slate-600 dark:text-slate-300">
          {message}
        </p>
      ) : null}
    </form>
  );
}

function messageFor(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Something went wrong. Try again.';
  switch (error.status) {
    case 429:
      return 'You have suggested recently — try again a little later.';
    case 400:
      return 'That suggestion was rejected. Try rewording it.';
    case 403:
      return 'Suggesting is for patrons at the required tier.';
    case 401:
      return 'Sign in to suggest something.';
    default:
      return 'Something went wrong. Try again.';
  }
}
