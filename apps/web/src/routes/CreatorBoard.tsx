import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useBoard, useCreator, useThemes } from '../api/hooks';
import type { Recommendation } from '../api/types';
import { RecommendationCard } from '../components/RecommendationCard';
import { SubmitForm } from '../components/SubmitForm';
import { ThemeFilter } from '../components/ThemeFilter';

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
  const [theme, setTheme] = useState<string | null>(null);
  const themes = useThemes(slug, !loading && !error);
  const board = useBoard(slug, !loading && !error, theme);

  if (loading) {
    return <p role="status">Loading board…</p>;
  }

  if (error) {
    return <BoardError status={error.status} />;
  }

  // Children are rendered inside their parent, so they must not also appear at the top level.
  // Only within the same column: columns are the lifecycle, and nesting a pending entry inside
  // an accepted one would move it out of the column its status says it belongs to.
  const columns = COLUMNS.map(([status, label]) => {
    const inColumn = board.items.filter((item) => item.status === status);
    const ids = new Set(inColumn.map((item) => item.id));
    const roots = inColumn.filter((item) => !item.parentId || !ids.has(item.parentId));
    const childrenOf = (id: string) => inColumn.filter((item) => item.parentId === id);
    return [status, label, roots, childrenOf] as const;
    // An empty column renders nothing at all: four headings over three empty lists reads as a
    // broken page rather than an empty one.
  }).filter(([, , roots]) => roots.length > 0);

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

      <ThemeFilter themes={themes} selected={theme} onSelect={setTheme} />

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
      ) : columns.length === 0 ? (
        <>
          <h2 className="mt-8 text-lg font-medium">Suggestions</h2>
          <p className="mt-3 text-slate-600 dark:text-slate-300">
            {/* Keyed on the rendered columns, not the raw item count: a staff viewer whose page
                holds only rejected or deleted entries has items but no column to show them in,
                and rendered a page with nothing on it at all. */}
            {board.items.length === 0
              ? `Nothing suggested yet. ${capabilities.submit ? 'Be the first.' : ''}`
              : 'Nothing on the board — the entries here are in the review queue.'}
          </p>
        </>
      ) : (
        <>
          {columns.map(([status, label, roots, childrenOf]) => (
            <div key={status}>
              <h2 className="mt-8 text-lg font-medium">{label}</h2>
              <ul className="mt-3 space-y-3">
                {roots.map((item) => (
                  <RecommendationCard
                    key={item.id}
                    slug={slug}
                    recommendation={item}
                    canUpvote={capabilities.upvote}
                    canModerate={capabilities.moderate}
                    onCount={board.applyUpvote}
                    onStatusChanged={board.applyStatus}
                    // Nested markup rather than a margin, so the containment is there for a
                    // screen reader as well as for the eye.
                    children={childrenOf(item.id).map((child) => (
                      <RecommendationCard
                        key={child.id}
                        slug={slug}
                        recommendation={child}
                        canUpvote={capabilities.upvote}
                        canModerate={capabilities.moderate}
                        onCount={board.applyUpvote}
                        onStatusChanged={board.applyStatus}
                      />
                    ))}
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
