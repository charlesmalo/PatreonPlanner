import { Link, useParams } from 'react-router-dom';
import { useCreator, useEntry } from '../api/hooks';
import { RecommendationCard } from '../components/RecommendationCard';

/**
 * One entry on its own page, so a card on the board can stay a summary and a reader can still
 * link someone straight to the thing they mean.
 */
export function EntryDetail() {
  const { slug = '', id = '' } = useParams();
  const { creator, capabilities } = useCreator(slug);
  const { entry, error, loading, applyUpvote, applyStatus } = useEntry(slug, id);

  const backToBoard = (
    <Link
      to={`/c/${slug}`}
      className="text-sm underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
    >
      {creator ? `Back to ${creator.displayName}` : 'Back to the board'}
    </Link>
  );

  if (loading) {
    return (
      <p role="status" className="text-slate-600 dark:text-slate-300">
        Loading…
      </p>
    );
  }

  // A shareable URL gets shared after the entry is gone, or with someone who cannot see it. The
  // API answers 404 either way on purpose, so this says the same thing for both.
  if (error || !entry) {
    return (
      <section>
        <h1 className="text-xl font-semibold">Not found</h1>
        <p className="mt-2 text-slate-600 dark:text-slate-300">
          That entry is not on this board, or is not one you can see.
        </p>
        <p className="mt-4">{backToBoard}</p>
      </section>
    );
  }

  return (
    <section>
      <p>{backToBoard}</p>
      <div className="mt-4">
        {/* The card carries the title as this page's h1: showing it above as well would print
            the same words twice, and the card is what the reader recognises from the board. */}
        <RecommendationCard
          slug={slug}
          recommendation={entry}
          headingLevel={1}
          canUpvote={capabilities.upvote}
          canModerate={capabilities.moderate}
          permissions={capabilities.permissions}
          onCount={applyUpvote}
          onStatusChanged={applyStatus}
        />
      </div>
    </section>
  );
}
