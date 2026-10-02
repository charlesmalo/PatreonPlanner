import { useId, useState } from 'react';
import { useSearch, MIN_QUERY } from '../api/use-search';
import { RecommendationCard } from './RecommendationCard';
import { columnLabel } from './board-columns';
import type { StaffPermission } from '../api/types';

interface BoardSearchProps {
  slug: string;
  canUpvote: boolean;
  canModerate: boolean;
  permissions?: StaffPermission[];
  isPremium?: boolean;
  /** Something changed on a result, so whatever is behind the search should re-read. */
  onChanged: () => void;
}

/**
 * Searching a board, across every column at once.
 *
 * Above the tabs rather than inside one, because the engine takes no status filter and returns
 * matches from all four columns. Put inside a tab it would answer a narrower question than it
 * was asked without saying so — a reader searching Suggestions would silently miss the match
 * sitting in Accepted.
 *
 * Which is also why every result names its column: a card is identical in all four, so without
 * the label a reader cannot tell whether what they found is still waiting or already watched.
 */
export function BoardSearch({
  slug,
  canUpvote,
  canModerate,
  permissions,
  isPremium,
  onChanged,
}: BoardSearchProps) {
  const [query, setQuery] = useState('');
  const { results, loading, error, active } = useSearch(slug, query);
  const inputId = useId();
  const typed = query.trim().length;

  return (
    <section aria-label="Board search" className="mt-6">
      <label htmlFor={inputId} className="block text-sm font-medium">
        Search this board
      </label>
      <div className="mt-1 flex gap-2">
        <input
          id={inputId}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Title, or what it is about"
          className="w-full rounded border border-slate-300 px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:bg-slate-950"
        />
        {query ? (
          <button
            type="button"
            onClick={() => setQuery('')}
            className="shrink-0 rounded border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:hover:bg-slate-900"
          >
            Clear
          </button>
        ) : null}
      </div>

      {/* Said rather than left silent: an input that does nothing for one character looks broken,
          and the server refuses the request anyway. */}
      {typed > 0 && typed < MIN_QUERY ? (
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          Keep typing — at least {MIN_QUERY} characters.
        </p>
      ) : null}

      {active ? (
        <div className="mt-3">
          {/* One live region for every outcome, so a screen reader hears the result of a search
              it cannot see change. */}
          <p
            role="status"
            aria-live="polite"
            className="text-sm text-slate-600 dark:text-slate-300"
          >
            {error
              ? error
              : loading
                ? 'Searching…'
                : results.length === 0
                  ? 'Nothing on this board matches.'
                  : `${results.length} ${results.length === 1 ? 'result' : 'results'}`}
          </p>
          {!error && results.length > 0 ? (
            <ul className="mt-2 space-y-2">
              {results.map((entry) => (
                <li key={entry.id}>
                  <p className="mb-1 text-xs font-medium text-slate-500 dark:text-slate-400">
                    {columnLabel(entry.status)}
                  </p>
                  <ul>
                    <RecommendationCard
                      slug={slug}
                      recommendation={entry}
                      canUpvote={canUpvote}
                      canModerate={canModerate}
                      permissions={permissions}
                      isPremium={isPremium}
                      onCount={onChanged}
                      onStatusChanged={onChanged}
                    />
                  </ul>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
