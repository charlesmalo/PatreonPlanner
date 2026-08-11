import type { Recommendation } from '../api/types';
import { UpvoteButton } from './UpvoteButton';

interface RecommendationCardProps {
  slug: string;
  recommendation: Recommendation;
  canUpvote: boolean;
  onCount: (id: string, count: number) => void;
}

export function RecommendationCard({
  slug,
  recommendation,
  canUpvote,
  onCount,
}: RecommendationCardProps) {
  return (
    <li className="flex gap-4 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <UpvoteButton
        slug={slug}
        recommendationId={recommendation.id}
        upvoteCount={recommendation.upvoteCount}
        canUpvote={canUpvote}
        onCount={onCount}
      />
      <div className="min-w-0 flex-1">
        {/* Rendered as text, never as HTML: every field here is submitter-controlled. */}
        <h3 className="font-medium">{recommendation.customTitle}</h3>
        {recommendation.description ? (
          <p className="mt-1 whitespace-pre-line text-sm text-slate-600 dark:text-slate-300">
            {recommendation.description}
          </p>
        ) : null}
        {recommendation.links.length > 0 ? (
          <ul className="mt-2 flex flex-wrap gap-3">
            {recommendation.links.map((link) => (
              <li key={link.url}>
                <a
                  href={link.url}
                  target="_blank"
                  // The URL is entirely submitter-chosen, so the opened page must not get a
                  // handle on this one.
                  rel="noopener noreferrer"
                  className="text-sm text-sky-700 underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-sky-400"
                >
                  {link.label ?? link.url}
                </a>
              </li>
            ))}
          </ul>
        ) : null}
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          Suggested by {recommendation.submittedBy.fullName ?? 'a patron'}
        </p>
      </div>
    </li>
  );
}
