import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { useCreator } from '../api/hooks';
import type { Ticket } from '../api/types';
import { TicketCard } from '../components/TicketCard';

/**
 * One message on its own page, which is where a ticket notification lands.
 *
 * It exists because `payload.ticketId` had nowhere to point. Both notifications were sent to the
 * inbox, and for the reader who raised the message that was worse than useless: the inbox demands
 * `HANDLE_REPORTS`, so the one person a TICKET_RESOLVED notification is addressed to was the one
 * person the page it linked to refused.
 *
 * So this page serves two readers. Which controls it draws is the only difference between them,
 * and the server decides the same question again regardless.
 */
export function TicketDetail() {
  const { slug = '', id = '' } = useParams();
  const { creator, capabilities, loading: loadingCreator } = useCreator(slug);
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setTicket(
        await api.get<Ticket>(
          `/creators/${encodeURIComponent(slug)}/tickets/${encodeURIComponent(id)}`,
        ),
      );
    } catch {
      setTicket(null);
    } finally {
      setLoading(false);
    }
  }, [slug, id]);

  useEffect(() => {
    void load();
  }, [load]);

  const canResolve =
    capabilities.moderate && (capabilities.permissions ?? []).includes('HANDLE_REPORTS');

  const backToBoard = (
    <Link
      to={`/c/${slug}`}
      className="text-sm underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
    >
      {creator ? `Back to ${creator.displayName}` : 'Back to the board'}
    </Link>
  );

  // Both requests, not just the message: the permissions decide what is drawn, so rendering on
  // the message alone shows a moderator a read-only page that then sprouts controls.
  if (loading || loadingCreator) {
    return (
      <p role="status" className="text-slate-600 dark:text-slate-300">
        Loading…
      </p>
    );
  }

  // The API answers 404 both for a message that is gone and for one that was never this reader's,
  // deliberately — so this says the same thing for both.
  if (!ticket) {
    return (
      <section>
        <h1 className="text-xl font-semibold">Not found</h1>
        <p className="mt-2 text-slate-600 dark:text-slate-300">
          That message is not on this board, or is not one you can see.
        </p>
        <p className="mt-4">{backToBoard}</p>
      </section>
    );
  }

  return (
    <section>
      <p className="flex flex-wrap gap-4">
        {backToBoard}
        {/* Offered only to whoever the inbox would actually let in. The board hides its Messages
            link on the same condition, for the same reason. */}
        {canResolve ? (
          <Link
            to={`/c/${slug}/tickets`}
            className="text-sm underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
          >
            All messages
          </Link>
        ) : null}
      </p>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight">Message</h1>

      {error ? (
        <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}

      <div className="mt-4">
        <TicketCard
          slug={slug}
          ticket={ticket}
          canResolve={canResolve}
          onResolved={() => void load()}
          onError={setError}
        />
      </div>
    </section>
  );
}
