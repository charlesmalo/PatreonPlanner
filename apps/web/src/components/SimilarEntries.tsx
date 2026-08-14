import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { Board, Recommendation } from '../api/types';
import { UpvoteButton } from './UpvoteButton';

/** Matches the server's floor; below it a trigram match is noise. */
const MIN_QUERY_LENGTH = 2;
const DEBOUNCE_MS = 250;

interface SimilarEntriesProps {
  slug: string;
  query: string;
  canUpvote: boolean;
  onCount: (id: string, count: number, upvoted?: boolean) => void;
}

/**
 * Design §5's "already submitted?": what is on the board that looks like what you are typing.
 *
 * Renders nothing at all when there is nothing to say — no empty state, no error. This is an aid
 * offered beside a form, and interrupting someone mid-submission for a failure they did not ask
 * for would be worse than staying quiet.
 */
export function SimilarEntries({ slug, query, canUpvote, onCount }: SimilarEntriesProps) {
  const [matches, setMatches] = useState<Recommendation[]>([]);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      setMatches([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .get<Board>(
          `/creators/${encodeURIComponent(slug)}/recommendations/similar?q=${encodeURIComponent(
            trimmed,
          )}`,
        )
        .then((body) => !cancelled && setMatches(body.items))
        .catch(() => !cancelled && setMatches([]));
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [slug, query]);

  if (matches.length === 0) return null;

  return (
    <div className="mt-2 rounded border border-amber-300 bg-amber-50 p-2 dark:border-amber-800 dark:bg-amber-950/40">
      <p className="text-xs font-medium">Already on the board — upvote instead?</p>
      <ul className="mt-1.5 space-y-1.5">
        {matches.map((match) => (
          <li key={match.id} className="flex items-center gap-2">
            <UpvoteButton
              slug={slug}
              recommendationId={match.id}
              title={match.customTitle}
              upvoteCount={match.upvoteCount}
              hasUpvoted={match.hasUpvoted}
              canUpvote={canUpvote}
              onCount={onCount}
            />
            {/* Text, never markup: a title is submitter-authored. */}
            <span className="min-w-0 break-words text-xs">{match.customTitle}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
