import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Notification } from '../api/types';
import { describeResolution } from '../api/ticket-wording';

interface NotificationBellProps {
  unreadCount: number;
  items: Notification[];
  loading: boolean;
  /** True when the last fetch failed, so the panel can say so instead of looking empty. */
  failed?: boolean;
  /** Called when the panel opens: the list is fetched then, not on every poll. */
  onOpen: () => void;
}

export function NotificationBell({
  unreadCount,
  items,
  loading,
  failed = false,
  onOpen,
}: NotificationBellProps) {
  const [open, setOpen] = useState(false);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) onOpen();
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        // The count goes in the accessible name, not only in the badge: a bare number beside an
        // icon tells a screen reader nothing about what it counts.
        aria-label={
          unreadCount > 0 ? `${unreadCount} unread notifications` : 'Notifications, no unread'
        }
        className="relative rounded border border-slate-300 px-2 py-1 text-sm hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:hover:bg-slate-800"
      >
        <span aria-hidden="true">🔔</span>
        {unreadCount > 0 ? (
          <span
            aria-hidden="true"
            className="absolute -right-1 -top-1 rounded-full bg-sky-600 px-1.5 text-xs font-medium text-white"
          >
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="absolute right-0 z-10 mt-2 w-80 rounded border border-slate-200 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-900">
          {/* Always offered, including when the panel is empty: what it holds is the unread
              tail, and a reader with nothing new may still want what they have already seen. */}
          {loading ? (
            <p className="px-3 py-4 text-sm text-slate-600 dark:text-slate-300">Loading…</p>
          ) : failed ? (
            <p className="px-3 py-4 text-sm text-slate-600 dark:text-slate-300">
              Could not load notifications.
            </p>
          ) : items.length === 0 ? (
            <p className="px-3 py-4 text-sm text-slate-600 dark:text-slate-300">Nothing yet.</p>
          ) : (
            <ul className="max-h-96 divide-y divide-slate-200 overflow-y-auto dark:divide-slate-700">
              {items.map((item) => (
                <li key={item.id} className="flex items-start gap-2 px-3 py-2 text-sm">
                  {item.readAt === null ? (
                    <span
                      data-testid="unread-marker"
                      aria-hidden="true"
                      className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-sky-600"
                    />
                  ) : (
                    <span aria-hidden="true" className="mt-1.5 h-2 w-2 shrink-0" />
                  )}
                  <span>
                    <Link
                      to={destinationFor(item)}
                      className="font-medium underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
                    >
                      {item.payload.title}
                    </Link>{' '}
                    {describe(item)}
                    {/* The moderator's actual answer. It was in the payload from the day tickets
                        shipped and rendered nowhere, so a reader was told their message had been
                        dealt with and never got to read what was said. */}
                    {item.payload.reply ? (
                      <span className="mt-1 block border-l-2 border-slate-300 pl-2 text-slate-600 dark:border-slate-700 dark:text-slate-300">
                        {item.payload.reply}
                      </span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="border-t border-slate-200 px-3 py-2 dark:border-slate-700">
            <Link
              to="/notifications"
              onClick={() => setOpen(false)}
              className="text-sm underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
            >
              See all notifications
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Where the news is acted on, which is not always where it happened.
 *
 * A report goes to the queue: the board is where an entry is read, the queue is where a
 * moderator can do something about it. A status change goes to the entry itself, which has its
 * own page and says so plainly when it has since been removed.
 */
function destinationFor(item: Notification): string {
  const board = `/c/${item.payload.creatorSlug}`;
  if (item.type === 'ENTRY_FLAGGED') return `${board}/review`;
  // A message is answered on the tickets page. Sending a moderator to the entry it happens to be
  // about leaves them looking at the thing rather than at what was said about it.
  if (item.type === 'TICKET_RAISED' || item.type === 'TICKET_RESOLVED') return `${board}/tickets`;
  return item.payload.recommendationId
    ? `${board}/e/${item.payload.recommendationId}`
    : // No id means the content was refused before it existed; the board is all there is.
      board;
}

/** Rendered from type and payload; there is nothing else to consult, by design. */
function describe(item: Notification): string {
  if (item.type === 'TICKET_RAISED') {
    return `— a message to the moderators of ${item.payload.creatorName}.`;
  }
  if (item.type === 'TICKET_RESOLVED') {
    return `— ${describeResolution(item.payload.resolution)} by the moderators of ${item.payload.creatorName}.`;
  }
  if (item.type === 'ENTRY_FLAGGED') {
    return `was reported on ${item.payload.creatorName}${
      item.payload.reason ? ` (${item.payload.reason.toLowerCase()})` : ''
    }.`;
  }
  // A folded row stands for several moves and its payload describes the newest. Saying so keeps
  // the sentence true — "was completed on Ada Writes" alone would quietly drop the other five.
  const alsoCount = (item.groupCount ?? 1) - 1;
  const also = alsoCount > 0 ? ` and ${alsoCount} other change${alsoCount === 1 ? '' : 's'}` : '';
  // The status is optional on the type; without it there is no sentence to write, so say the
  // neutral thing rather than rendering "was  on Ada Writes."
  return item.payload.status
    ? `was ${item.payload.status.toLowerCase()} on ${item.payload.creatorName}${also}.`
    : `was updated on ${item.payload.creatorName}${also}.`;
}
