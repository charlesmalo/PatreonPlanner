import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useCreator, useThemes } from '../api/hooks';
import { BoardColumn } from '../components/BoardColumn';
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
  // Bumped when a submission lands or a card moves, which remounts the columns so they refetch.
  // Each column owns its own cursor, so an entry leaving one has to be picked up by another —
  // threading every mutation through four independent lists would be more code for less
  // certainty.
  const [revision, setRevision] = useState(0);
  const refresh = () => setRevision((current) => current + 1);

  if (loading) {
    return <p role="status">Loading board…</p>;
  }

  if (error) {
    return <BoardError status={error.status} />;
  }

  return (
    <section>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{creator?.displayName}</h1>
        {capabilities.administer ? (
          <Link
            to={`/c/${encodeURIComponent(slug)}/staff`}
            className="text-sm text-sky-700 underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-sky-400"
          >
            Moderators
          </Link>
        ) : null}
        {capabilities.upvote ? (
          <Link
            to={`/c/${encodeURIComponent(slug)}/my-votes`}
            className="text-sm text-sky-700 underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-sky-400"
          >
            Your votes
          </Link>
        ) : null}
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
          <SubmitForm
            slug={slug}
            onCreated={refresh}
            canUpvote={capabilities.upvote}
            onUpvoted={refresh}
          />
        </div>
      ) : null}

      {/* The row scrolls, never the page body — a horizontally scrolling page is unusable. Below
          the breakpoint the columns stack, which is the reading order they already had. */}
      <div className="mt-8 flex flex-col gap-4 overflow-x-auto pb-2 sm:flex-row sm:items-start">
        {COLUMNS.map(([status, label]) => (
          <BoardColumn
            key={`${status}-${revision}`}
            slug={slug}
            status={status}
            label={label}
            theme={theme}
            canUpvote={capabilities.upvote}
            canModerate={capabilities.moderate}
            onMoved={refresh}
            emptyText={
              status === 'PENDING'
                ? `Nothing suggested yet.${capabilities.submit ? ' Be the first.' : ''}`
                : undefined
            }
          />
        ))}
      </div>
    </section>
  );
}

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
