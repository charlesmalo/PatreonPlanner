import type { CatalogResult } from '../api/types';

interface CatalogueSearchFieldProps {
  query: string;
  onQueryChange: (value: string) => void;
  picked: CatalogResult | null;
  onPick: (result: CatalogResult | null) => void;
  results: CatalogResult[];
  error: string | null;
  /** Whether a search has come back for what is typed — not merely that the box is empty. */
  searched: boolean;
  /** "Add what I typed anyway", for a title the catalogue does not carry. */
  onUseTyped: (title: string) => void;
}

/**
 * Looking a work up in the catalogue, and giving up on it.
 *
 * Rendering only: every piece of state it shows belongs to the form, because the form is what
 * submits it. Extracting the markup rather than the state is the point — lifting the state into a
 * parent would move the size around rather than remove it, which is why the obvious split of this
 * form by mode was left alone.
 */
export function CatalogueSearchField({
  query,
  onQueryChange,
  picked,
  onPick,
  results,
  error,
  searched,
  onUseTyped,
}: CatalogueSearchFieldProps) {
  return (
    <div>
      <label htmlFor="rec-search" className="block text-sm font-medium">
        Search films and shows
      </label>
      {picked ? (
        <div className="mt-1 flex items-center gap-2">
          <span className="rounded bg-slate-100 px-2 py-1 text-sm dark:bg-slate-800">
            {picked.name}
            {picked.year ? ` (${picked.year})` : ''}
          </span>
          <button
            type="button"
            onClick={() => onPick(null)}
            className="text-sm underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
          >
            Change
          </button>
        </div>
      ) : (
        <>
          <input
            id="rec-search"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="e.g. Spirited Away"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:bg-slate-950"
          />
          {results.length > 0 ? (
            <ul className="mt-2 space-y-1">
              {results.slice(0, 5).map((result) => (
                <li key={`${result.mediaType}-${result.tmdbId}`}>
                  <button
                    type="button"
                    onClick={() => onPick(result)}
                    className="w-full rounded px-2 py-1 text-left text-sm hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:hover:bg-slate-800"
                  >
                    {result.name}
                    {result.year ? ` (${result.year})` : ''}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {error ? (
            <p role="status" className="mt-1 text-sm text-slate-600 dark:text-slate-300">
              {error}
            </p>
          ) : null}
          {/* Only once a search has actually come back empty — saying "nothing matches" while the
              reader is still typing the second letter would be wrong, and would flicker. */}
          {searched && !error && results.length === 0 ? (
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
              Nothing in the catalogue matches that.{' '}
              <button
                type="button"
                onClick={() => onUseTyped(query.trim())}
                className="underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
              >
                Add “{query.trim()}” anyway
              </button>
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
