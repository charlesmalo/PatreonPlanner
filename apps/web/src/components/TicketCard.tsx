import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { Ticket, TicketResolution } from '../api/types';

/**
 * A starting point per resolution, editable before sending. The last is deliberately
 * uninformative: sometimes the honest answer is one a moderator does not want to explain, and
 * saying so plainly beats an evasive paragraph.
 */
const CANNED: Record<TicketResolution, string> = {
  CONFIRMED: 'You were right — thank you for flagging it. We have made the change.',
  DENIED: 'Thank you for writing. We have looked and are leaving this as it is.',
  LINKED: 'Thank you — we have linked this to the existing entry.',
  CLOSED: 'This ticket has been handled internally and resolved.',
};

const LABELS: Record<TicketResolution, string> = {
  CONFIRMED: 'Confirm',
  DENIED: 'Deny',
  LINKED: 'Link to existing',
  CLOSED: 'Close',
};

interface TicketCardProps {
  slug: string;
  ticket: Ticket;
  /**
   * Whether this reader may answer it — true for staff working the inbox, false for the person
   * who wrote it. A send button that the server will refuse is worse than no button: the reader
   * writes the reply first and learns afterwards.
   */
  canResolve: boolean;
  /** Called after a successful answer, so the page re-reads rather than guessing what was stored. */
  onResolved: () => void;
  onError: (message: string) => void;
}

/**
 * One message, with the controls to answer it when the reader may.
 *
 * Shared by the inbox and the single-message page. The rule worth not duplicating is the one
 * below about canned text: both outcomes look plausible on screen, so a second copy of it would
 * drift without anyone seeing.
 */
export function TicketCard({ slug, ticket, canResolve, onResolved, onError }: TicketCardProps) {
  const [resolution, setResolution] = useState<TicketResolution>('CONFIRMED');
  const [reply, setReply] = useState(CANNED.CONFIRMED);
  const [busy, setBusy] = useState(false);

  function choose(next: TicketResolution) {
    setResolution(next);
    // Swap the canned text only while it is still canned — a moderator who has started writing
    // keeps what they wrote.
    setReply((current) => (Object.values(CANNED).includes(current) ? CANNED[next] : current));
  }

  async function send() {
    setBusy(true);
    try {
      await api.patch(`/creators/${encodeURIComponent(slug)}/tickets/${ticket.id}`, {
        resolution,
        // `reply` is optional on the API: sending `""` and sending nothing are different rows,
        // and an empty quoted reply reads worse to the reader than no reply at all.
        ...(reply.trim() ? { reply: reply.trim() } : {}),
      });
      onResolved();
    } catch {
      onError('Could not send that. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded border border-slate-200 p-3 dark:border-slate-800">
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
      ) : canResolve ? (
        <div className="mt-3">
          <fieldset className="flex flex-wrap gap-3">
            <legend className="sr-only">How to resolve this</legend>
            {(Object.keys(CANNED) as TicketResolution[]).map((value) => (
              <label key={value} className="flex items-center gap-1.5 text-xs">
                <input
                  type="radio"
                  name={`resolution-${ticket.id}`}
                  checked={resolution === value}
                  onChange={() => choose(value)}
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
            value={reply}
            rows={2}
            onChange={(event) => setReply(event.target.value)}
            className="mt-2 w-full rounded border border-slate-300 px-2 py-1 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:bg-slate-950"
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => void send()}
            className="mt-2 rounded border border-slate-300 px-3 py-1 text-sm disabled:opacity-50 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            Send reply
          </button>
        </div>
      ) : (
        // The reader who wrote it, before anyone has answered. Saying nothing here would leave
        // the page looking like it had failed to load the half that matters.
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          No answer yet. You will be told when there is one.
        </p>
      )}
    </div>
  );
}
