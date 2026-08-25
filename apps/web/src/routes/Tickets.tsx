import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';

type Resolution = 'CONFIRMED' | 'DENIED' | 'LINKED' | 'CLOSED';

interface Ticket {
  id: string;
  body: string;
  status: string;
  resolution: Resolution | null;
  reply: string | null;
  createdAt: string;
  raisedBy: { id: string; fullName: string | null } | null;
  subject: { id: string; customTitle: string } | null;
}

/**
 * A starting point per resolution, editable before sending. The last is deliberately
 * uninformative: sometimes the honest answer is one a moderator does not want to explain, and
 * saying so plainly beats an evasive paragraph.
 */
const CANNED: Record<Resolution, string> = {
  CONFIRMED: 'You were right — thank you for flagging it. We have made the change.',
  DENIED: 'Thank you for writing. We have looked and are leaving this as it is.',
  LINKED: 'Thank you — we have linked this to the existing entry.',
  CLOSED: 'This ticket has been handled internally and resolved.',
};

const LABELS: Record<Resolution, string> = {
  CONFIRMED: 'Confirm',
  DENIED: 'Deny',
  LINKED: 'Link to existing',
  CLOSED: 'Close',
};

export function Tickets() {
  const { slug = '' } = useParams();
  const [items, setItems] = useState<Ticket[] | null>(null);
  const [showing, setShowing] = useState<'OPEN' | 'RESOLVED'>('OPEN');
  const [drafts, setDrafts] = useState<Record<string, { resolution: Resolution; reply: string }>>(
    {},
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const page = await api.get<{ items: Ticket[] }>(
        `/creators/${encodeURIComponent(slug)}/tickets?status=${showing}`,
      );
      setItems(page.items);
      setError(null);
    } catch {
      setItems([]);
      setError('Could not load messages.');
    }
  }, [slug, showing]);

  useEffect(() => {
    void load();
  }, [load]);

  const draftFor = (id: string) =>
    drafts[id] ?? { resolution: 'CONFIRMED' as const, reply: CANNED.CONFIRMED };

  function choose(id: string, resolution: Resolution) {
    const current = draftFor(id);
    // Swap the canned text only while it is still canned — a moderator who has started writing
    // keeps what they wrote.
    const untouched = Object.values(CANNED).includes(current.reply);
    setDrafts((all) => ({
      ...all,
      [id]: { resolution, reply: untouched ? CANNED[resolution] : current.reply },
    }));
  }

  async function resolve(id: string) {
    const draft = draftFor(id);
    setBusy(true);
    try {
      await api.patch(`/creators/${encodeURIComponent(slug)}/tickets/${id}`, {
        resolution: draft.resolution,
        ...(draft.reply.trim() ? { reply: draft.reply.trim() } : {}),
      });
      await load();
    } catch {
      setError('Could not send that. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <p>
        <Link
          to={`/c/${slug}`}
          className="text-sm underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
        >
          Back to the board
        </Link>
      </p>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight">Messages</h1>

      <label htmlFor="ticket-status" className="mt-4 block text-sm font-medium">
        Show
      </label>
      <select
        id="ticket-status"
        value={showing}
        onChange={(event) => setShowing(event.target.value as 'OPEN' | 'RESOLVED')}
        className="mt-1 rounded border border-slate-300 px-2 py-1 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:bg-slate-950"
      >
        <option value="OPEN">Open</option>
        <option value="RESOLVED">Resolved</option>
      </select>

      {error ? (
        <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}

      {items === null ? (
        <p role="status" className="mt-6">
          Loading…
        </p>
      ) : items.length === 0 ? (
        <p className="mt-6 text-slate-600 dark:text-slate-300">Nothing here.</p>
      ) : (
        <ul className="mt-6 space-y-4">
          {items.map((ticket) => {
            const draft = draftFor(ticket.id);
            return (
              <li
                key={ticket.id}
                className="rounded border border-slate-200 p-3 dark:border-slate-800"
              >
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {ticket.raisedBy?.fullName ?? 'Someone not signed in'}
                  {ticket.subject ? (
                    <>
                      {' · about '}
                      <Link to={`/c/${slug}/e/${ticket.subject.id}`} className="underline">
                        {ticket.subject.customTitle}
                      </Link>
                    </>
                  ) : (
                    ' · about the board'
                  )}
                </p>
                {/* Text, never markup: this is a stranger's words. */}
                <p className="mt-1 whitespace-pre-line break-words text-sm">{ticket.body}</p>

                {ticket.status === 'RESOLVED' ? (
                  <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                    {ticket.resolution}
                    {ticket.reply ? ` — “${ticket.reply}”` : ''}
                  </p>
                ) : (
                  <div className="mt-3">
                    <fieldset className="flex flex-wrap gap-3">
                      <legend className="sr-only">How to resolve this</legend>
                      {(Object.keys(CANNED) as Resolution[]).map((value) => (
                        <label key={value} className="flex items-center gap-1.5 text-xs">
                          <input
                            type="radio"
                            name={`resolution-${ticket.id}`}
                            checked={draft.resolution === value}
                            onChange={() => choose(ticket.id, value)}
                          />
                          {LABELS[value]}
                        </label>
                      ))}
                    </fieldset>
                    <label htmlFor={`reply-${ticket.id}`} className="sr-only">
                      Reply to this message
                    </label>
                    <textarea
                      id={`reply-${ticket.id}`}
                      value={draft.reply}
                      rows={2}
                      onChange={(event) =>
                        setDrafts((all) => ({
                          ...all,
                          [ticket.id]: { ...draft, reply: event.target.value },
                        }))
                      }
                      className="mt-2 w-full rounded border border-slate-300 px-2 py-1 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:bg-slate-950"
                    />
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => resolve(ticket.id)}
                      className="mt-2 rounded border border-slate-300 px-3 py-1 text-sm disabled:opacity-50 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:hover:bg-slate-800"
                    >
                      Send reply
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
