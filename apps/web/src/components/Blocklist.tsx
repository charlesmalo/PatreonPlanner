import { useEffect, useState } from 'react';
import { api } from '../api/client';

interface Blockword {
  id: string;
  pattern: string;
  action: 'BLOCK' | 'FLAG';
  createdAt: string;
}

/** The server takes 2 to 100 characters. Checked here so a short word is answered, not 400'd. */
const MIN_LENGTH = 2;
const MAX_LENGTH = 100;

const ACTIONS: Array<{ value: 'BLOCK' | 'FLAG'; label: string }> = [
  { value: 'BLOCK', label: 'Refuse the suggestion' },
  { value: 'FLAG', label: 'Send it to the review queue' },
];

/**
 * Words this board will not accept, or will not accept quietly.
 *
 * Everything behind this existed already — list, add, remove, normalisation, the conflict on a
 * duplicate, and enforcement in the moderation pipeline — and nothing in the app called any of it.
 * A creator could not add a single word.
 *
 * Behind `ADMINISTER` rather than `MANAGE_POLICY`: design §7 files the blocklist beside creator
 * admin because it decides what the board will accept at all, and a moderator who arrived by
 * invite link must not be able to widen or narrow it.
 */
export function Blocklist({ slug }: { slug: string }) {
  const [items, setItems] = useState<Blockword[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [pattern, setPattern] = useState('');
  const [action, setAction] = useState<'BLOCK' | 'FLAG'>('BLOCK');
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ items: Blockword[] }>(`/creators/${encodeURIComponent(slug)}/blocklist`)
      .then((body) => {
        if (!cancelled) setItems(body.items);
      })
      .catch(() => {
        // Not an empty list. A failed load rendered as "nothing on the list" tells a creator
        // their words are gone, and invites them to add duplicates the server will refuse.
        if (cancelled) return;
        setItems([]);
        setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  async function add(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = pattern.trim();
    // Answered here rather than sent: the server's 400 is correct and reads like the page is
    // broken, because nothing on screen said what the limit was.
    if (trimmed.length < MIN_LENGTH) {
      setMessage('Use at least two characters — a single letter would match almost everything.');
      return;
    }
    setMessage(null);
    try {
      const created = await api.post<Blockword>(`/creators/${encodeURIComponent(slug)}/blocklist`, {
        pattern: trimmed,
        action,
      });
      setItems((current) => [...(current ?? []), created]);
      setPattern('');
    } catch (error) {
      // The server answers a duplicate with 409 on purpose. Reporting it as a failure would have
      // a creator retyping a word that is already doing its job.
      const status = (error as { status?: number })?.status;
      setMessage(
        status === 409
          ? 'That word is already on the list.'
          : 'That did not save. Nothing changed.',
      );
    }
  }

  async function remove(word: Blockword) {
    const previous = items ?? [];
    setItems(previous.filter((item) => item.id !== word.id));
    setMessage(null);
    try {
      await api.del(`/creators/${encodeURIComponent(slug)}/blocklist/${word.id}`);
    } catch {
      setItems(previous);
      setMessage('That did not remove. Nothing changed.');
    }
  }

  if (items === null) return <p className="mt-2 text-sm">Loading…</p>;

  return (
    <div className="mt-3">
      <p className="text-sm text-slate-600 dark:text-slate-300">
        {/* The trap this feature carries. It is a plain substring test, so a short word catches
            far more than a creator expects, and the surprise lands on a patron whose suggestion
            vanished. Better said once here than discovered in the queue. */}
        Matched anywhere inside a suggestion, so a short word catches a lot:{' '}
        <span className="font-medium">ass</span> also catches{' '}
        <span className="font-medium">assassin</span>. Case does not matter.
      </p>

      {loadFailed ? (
        <p className="mt-3 text-sm text-slate-600 dark:text-slate-300">
          The list could not be loaded, so what is on it is unknown. Adding a word here would still
          work, but check the list before assuming it is empty.
        </p>
      ) : items.length === 0 ? (
        <p className="mt-3 text-sm text-slate-600 dark:text-slate-300">
          Nothing on the list. Every suggestion is judged by the usual checks alone.
        </p>
      ) : (
        <ul className="mt-3 space-y-1">
          {items.map((word) => (
            <li
              key={word.id}
              className="flex items-center justify-between gap-3 rounded border border-slate-200 px-3 py-1.5 text-sm dark:border-slate-800"
            >
              <span>
                <span className="font-medium">{word.pattern}</span>
                <span className="ml-2 text-slate-600 dark:text-slate-300">
                  {word.action === 'BLOCK' ? 'refused' : 'sent for review'}
                </span>
              </span>
              <button
                type="button"
                onClick={() => remove(word)}
                // Named with the word itself: a column of buttons all called "Remove" tells a
                // screen-reader user nothing about which one they are on.
                aria-label={`Remove ${word.pattern}`}
                className="rounded border border-slate-300 px-2 py-0.5 text-xs hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:hover:bg-slate-800"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={add} className="mt-4 flex flex-wrap items-end gap-2">
        <div>
          <label htmlFor="blockword" className="block text-sm font-medium">
            Word or phrase
          </label>
          <input
            id="blockword"
            value={pattern}
            maxLength={MAX_LENGTH}
            onChange={(event) => setPattern(event.target.value)}
            className="mt-1 rounded border border-slate-300 px-2 py-1 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:bg-slate-950"
          />
        </div>
        <div>
          <label htmlFor="blockword-action" className="block text-sm font-medium">
            What happens
          </label>
          <select
            id="blockword-action"
            value={action}
            onChange={(event) => setAction(event.target.value as 'BLOCK' | 'FLAG')}
            className="mt-1 rounded border border-slate-300 px-2 py-1 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:bg-slate-950"
          >
            {ACTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <button
          type="submit"
          className="rounded border border-slate-300 px-3 py-1 text-sm hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:hover:bg-slate-800"
        >
          Add
        </button>
      </form>

      {message ? (
        <p role="status" className="mt-2 text-sm text-slate-600 dark:text-slate-300">
          {message}
        </p>
      ) : null}
    </div>
  );
}
