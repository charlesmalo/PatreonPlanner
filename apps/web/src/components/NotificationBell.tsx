import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Notification } from '../api/types';

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
                    {/* To the board, not the entry: the entry may be deleted or moved somewhere
                        this reader cannot see, and a link that 404s is worse than one that lands
                        on the board it came from. */}
                    <Link
                      to={`/c/${item.payload.creatorSlug}`}
                      className="font-medium underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
                    >
                      {item.payload.title}
                    </Link>{' '}
                    {describe(item)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** Rendered from type and payload; there is nothing else to consult, by design. */
function describe(item: Notification): string {
  if (item.type === 'ENTRY_FLAGGED') {
    return `was reported on ${item.payload.creatorName}${
      item.payload.reason ? ` (${item.payload.reason.toLowerCase()})` : ''
    }.`;
  }
  // The status is optional on the type; without it there is no sentence to write, so say the
  // neutral thing rather than rendering "was  on Ada Writes."
  return item.payload.status
    ? `was ${item.payload.status.toLowerCase()} on ${item.payload.creatorName}.`
    : `was updated on ${item.payload.creatorName}.`;
}
