import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import type { Ticket } from '../api/types';
import { TicketCard } from '../components/TicketCard';

/**
 * The inbox a moderator works through.
 *
 * Every message here is answerable: the list endpoint demands `HANDLE_REPORTS`, so a reader
 * without it has no items to be offered controls for. The single-message page is where that is
 * not true, and it decides per reader.
 */
export function Tickets() {
  const { slug = '' } = useParams();
  const [items, setItems] = useState<Ticket[] | null>(null);
  const [showing, setShowing] = useState<'OPEN' | 'RESOLVED'>('OPEN');
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
          {items.map((ticket) => (
            <li key={ticket.id}>
              <TicketCard
                slug={slug}
                ticket={ticket}
                canResolve
                onResolved={() => void load()}
                onError={setError}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
