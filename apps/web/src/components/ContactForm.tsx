import { useState } from 'react';
import { api } from '../api/client';

interface ContactFormProps {
  slug: string;
  /** Set when this is a dispute about one entry rather than general contact. */
  subjectId?: string;
  subjectTitle?: string;
  onSent?: () => void;
}

const MIN = 10;
const MAX = 2000;

/**
 * One form for both jobs. A dispute is this with a subject; general contact is this without one —
 * the difference is what it points at, not a separate screen.
 */
export function ContactForm({ slug, subjectId, subjectTitle, onSent }: ContactFormProps) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  async function send(event: React.FormEvent) {
    event.preventDefault();
    if (body.trim().length < MIN) {
      setFailed(true);
      setMessage(`Say a little more — at least ${MIN} characters.`);
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await api.post(`/creators/${encodeURIComponent(slug)}/tickets`, {
        body: body.trim(),
        ...(subjectId ? { subjectId } : {}),
      });
      setBody('');
      setFailed(false);
      setMessage('Sent. A moderator will take a look.');
      onSent?.();
    } catch {
      setFailed(true);
      // Covers both the refusals a reader can hit: not signed in on a board that requires it,
      // and a message the moderation pipeline rejected.
      setMessage('Could not send that. Sign in, or try rewording it.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={send} className="rounded border border-slate-200 p-3 dark:border-slate-800">
      <label htmlFor={`contact-${subjectId ?? 'board'}`} className="block text-sm font-medium">
        {subjectTitle ? `Something wrong with “${subjectTitle}”?` : 'Message the moderators'}
      </label>
      <textarea
        id={`contact-${subjectId ?? 'board'}`}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        maxLength={MAX}
        rows={3}
        placeholder={
          subjectTitle
            ? 'e.g. this is season 3, not a duplicate of season 1'
            : 'Anything the moderators should know'
        }
        className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:bg-slate-950"
      />
      <button
        type="submit"
        disabled={busy}
        className="mt-2 rounded border border-slate-300 px-3 py-1 text-sm disabled:opacity-50 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:hover:bg-slate-800"
      >
        {busy ? 'Sending…' : 'Send'}
      </button>
      {message ? (
        <p
          role={failed ? 'alert' : 'status'}
          className="mt-2 text-sm text-slate-600 dark:text-slate-300"
        >
          {message}
        </p>
      ) : null}
    </form>
  );
}
