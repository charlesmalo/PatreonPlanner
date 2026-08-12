import { Link, useParams } from 'react-router-dom';
import { useBoard, useCreator } from '../api/hooks';
import type { Recommendation } from '../api/types';
import { RecommendationCard } from '../components/RecommendationCard';
import { SubmitForm } from '../components/SubmitForm';

/**
 * Design §7's patron board: Suggestions, Accepted, Now Playing, Completed. Rejected and Deleted
 * are absent by design — a patron never sees them, and a moderator reads them in the review
 * queue, which is the surface built for the bin.
 */
const COLUMNS: Array<[string, string]> = [
  ['PENDING', 'Suggestions'],
  ['ACCEPTED', 'Accepted'],
  ['ACTIVE', 'Now Playing'],
  ['COMPLETED', 'Completed'],
];

export function CreatorBoard() {
  const { slug = '' } = useParams();
  const { creator, capabilities, error, loading } = useCreator(slug);
  const board = useBoard(slug, !loading && !error);

  if (loading) {
    return <p role="status">Loading board…</p>;
  }

  if (error) {
    return <BoardError status={error.status} />;
  }

  const columns = COLUMNS.map(
    ([status, label]) =>
      [status, label, board.items.filter((item) => item.status === status)] as const,
    // An empty column renders nothing at all: four headings over three empty lists reads as a
    // broken page rather than an empty one.
  ).filter(([, , items]) => items.length > 0);

  return (
    <section>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{creator?.displayName}</h1>
        {capabilities.moderate ? (
          <Link
            to={`/c/${encodeURIComponent(slug)}/review`}
            className="text-sm text-sky-700 underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-sky-400"
          >
            Review queue
          </Link>
        ) : null}
      </div>

      {capabilities.submit ? (
        <div className="mt-6">
          <SubmitForm slug={slug} onCreated={board.prepend} />
        </div>
      ) : null}

      {board.loading ? (
        <p role="status" className="mt-8 text-slate-600 dark:text-slate-300">
          Loading suggestions…
        </p>
      ) : board.error ? (
        <BoardError status={board.error.status} />
      ) : board.items.length === 0 ? (
        <>
          <h2 className="mt-8 text-lg font-medium">Suggestions</h2>
          <p className="mt-3 text-slate-600 dark:text-slate-300">
            Nothing suggested yet. {capabilities.submit ? 'Be the first.' : ''}
          </p>
        </>
      ) : (
        <>
          {columns.map(([status, label, items]) => (
            <div key={status}>
              <h2 className="mt-8 text-lg font-medium">{label}</h2>
              <ul className="mt-3 space-y-3">
                {items.map((item) => (
                  <RecommendationCard
                    key={item.id}
                    slug={slug}
                    recommendation={item}
                    canUpvote={capabilities.upvote}
                    canModerate={capabilities.moderate}
                    onCount={board.applyUpvote}
                    onStatusChanged={board.applyStatus}
                  />
                ))}
              </ul>
            </div>
          ))}
          {/* Kept mounted and disabled rather than unmounted: removing a focused button drops
              keyboard focus to the body, losing the reader's place on the last page. */}
          <button
            type="button"
            onClick={board.loadMore}
            disabled={board.loadingMore || !board.hasMore}
            className="mt-4 rounded border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-50 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            {board.loadingMore ? 'Loading…' : board.hasMore ? 'Load more' : 'No more suggestions'}
          </button>
          <p
            role="status"
            aria-live="polite"
            className="mt-2 text-sm text-red-600 dark:text-red-400"
          >
            {board.moreError}
          </p>
        </>
      )}
    </section>
  );
}

export type { Recommendation };

function BoardError({ status }: { status: number }) {
  // The server decides; this only explains its answer in terms the reader can act on.
  const text =
    status === 404
      ? 'No creator with that address.'
      : status === 401
        ? 'Sign in to see this board.'
        : status === 403
          ? 'This board is for the creator’s patrons.'
          : 'Could not load this board. Try again.';
  return (
    <p role="status" className="mt-3 text-slate-600 dark:text-slate-300">
      {text}
    </p>
  );
}
