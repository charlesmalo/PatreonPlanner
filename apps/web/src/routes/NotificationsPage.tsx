import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { Notification } from '../api/types';
import { destinationFor } from '../api/notification-destination';
import { describeResolution } from '../api/ticket-wording';
import { NOTIFICATION_FILTERS } from '../api/notification-wording';

// Derived, never restated: a second copy of this union is a second thing to keep in step, and
// the one that used to live here was already the kind of drift the enum audit was written for.
type Filter = '' | Notification['type'];
type Sort = '' | 'oldest' | 'severity';

/**
 * The whole list, with the controls the dropdown deliberately lacks. The bell answers "anything
 * new?" and always shows newest first; this is where a moderator works through a backlog, which
 * is a different job and wants different ordering.
 */
export function NotificationsPage() {
  const [items, setItems] = useState<Notification[] | null>(null);
  const [type, setType] = useState<Filter>('');
  const [sort, setSort] = useState<Sort>('');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    if (type) params.set('type', type);
    if (sort) params.set('sort', sort);
    if (unreadOnly) params.set('unreadOnly', 'true');
    const query = params.toString();

    setFailed(false);
    api
      .get<{ items: Notification[] }>(`/notifications${query ? `?${query}` : ''}`)
      .then((page) => {
        if (!cancelled) setItems(page.items);
      })
      .catch(() => {
        if (!cancelled) {
          setItems([]);
          setFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [type, sort, unreadOnly]);

  return (
    <section>
      <h1 className="text-2xl font-semibold tracking-tight">Notifications</h1>

      <div className="mt-4 flex flex-wrap items-end gap-4">
        <div>
          <label htmlFor="notif-type" className="block text-sm font-medium">
            Show
          </label>
          <select
            id="notif-type"
            value={type}
            onChange={(event) => setType(event.target.value as Filter)}
            className="mt-1 rounded border border-slate-300 px-2 py-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:bg-slate-950"
          >
            <option value="">Everything</option>
            {NOTIFICATION_FILTERS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="notif-sort" className="block text-sm font-medium">
            Sort
          </label>
          <select
            id="notif-sort"
            value={sort}
            onChange={(event) => setSort(event.target.value as Sort)}
            className="mt-1 rounded border border-slate-300 px-2 py-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:bg-slate-950"
          >
            <option value="">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="severity">Most serious first</option>
          </select>
        </div>

        <label className="flex items-center gap-2 pb-1 text-sm">
          <input
            type="checkbox"
            checked={unreadOnly}
            onChange={(event) => setUnreadOnly(event.target.checked)}
          />
          Unread only
        </label>
      </div>

      {items === null ? (
        <p role="status" className="mt-6 text-slate-600 dark:text-slate-300">
          Loading…
        </p>
      ) : items.length === 0 ? (
        <p role="status" className="mt-6 text-slate-600 dark:text-slate-300">
          {failed ? 'Could not load notifications.' : 'Nothing here.'}
        </p>
      ) : (
        <ul className="mt-6 divide-y divide-slate-200 dark:divide-slate-800">
          {items.map((item) => (
            <li key={item.id} className="flex items-start gap-2 py-3">
              {item.readAt === null ? (
                <span
                  aria-hidden="true"
                  className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-sky-600"
                />
              ) : (
                <span aria-hidden="true" className="mt-1.5 h-2 w-2 shrink-0" />
              )}
              <span className="text-sm">
                <Link
                  to={destinationFor(item)}
                  className="font-medium underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
                >
                  {item.payload.title}
                </Link>{' '}
                {describe(item)}
                {/* The reason is what decides the ranking, so it belongs on the row that ranking
                    moves around. */}
                {item.payload.reason ? (
                  <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                    {item.payload.reason.toLowerCase().replace(/_/g, ' ')}
                  </span>
                ) : null}
                {/* The moderator's actual answer, which is the reason to open this at all. It sat
                    in the payload unrendered from the day tickets shipped. */}
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
    </section>
  );
}

/** Rendered from type and payload, the same way the dropdown does it. */
function describe(item: Notification): string {
  if (item.type === 'TICKET_RAISED') {
    return `— a message to the moderators of ${item.payload.creatorName}`;
  }
  if (item.type === 'TICKET_RESOLVED') {
    return `— ${describeResolution(item.payload.resolution)} by the moderators of ${item.payload.creatorName}`;
  }
  if (item.type === 'ENTRY_FLAGGED') return `was reported on ${item.payload.creatorName}`;
  const alsoCount = (item.groupCount ?? 1) - 1;
  const also = alsoCount > 0 ? ` and ${alsoCount} other change${alsoCount === 1 ? '' : 's'}` : '';
  return `was ${(item.payload.status ?? 'updated').toLowerCase()} on ${item.payload.creatorName}${also}`;
}
