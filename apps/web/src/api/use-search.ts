import { useEffect, useRef, useState } from 'react';
import { ApiError, api } from './client';
import type { Recommendation } from './types';

/** The server refuses anything shorter, and a trigram match on one character ranks everything. */
export const MIN_QUERY = 2;

/** Long enough that ordinary typing makes one request, short enough to feel immediate. */
export const SEARCH_DEBOUNCE_MS = 300;

/**
 * Searching one board.
 *
 * The engine behind this has existed since the fuzzy-search work and was reachable only by
 * starting to type a submission — the duplicate hint inside the submit form was its one caller.
 * This is the caller that makes it a board feature.
 *
 * Debounced because the endpoint is the one read with a measured per-request cost and carries a
 * rate limit of its own: a request per keystroke would spend a reader's budget on prefixes of a
 * word they had not finished typing.
 */
export function useSearch(slug: string, query: string) {
  const [results, setResults] = useState<Recommendation[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Which query the state belongs to. A slow response for an abandoned query must not overwrite
  // a newer one — the reader would be reading results for something they stopped typing.
  const latest = useRef(0);

  const trimmed = query.trim();
  const active = trimmed.length >= MIN_QUERY;

  useEffect(() => {
    if (!active) {
      // Cleared rather than left behind: stale results under an empty box read as the board
      // being filtered by something invisible.
      setResults([]);
      setError(null);
      setLoading(false);
      return;
    }

    const ticket = ++latest.current;
    setLoading(true);
    const timer = setTimeout(() => {
      api
        .get<{ items: Recommendation[] }>(
          `/creators/${encodeURIComponent(slug)}/recommendations/similar?q=${encodeURIComponent(trimmed)}`,
        )
        .then((body) => {
          if (ticket !== latest.current) return;
          setResults(Array.isArray(body?.items) ? body.items : []);
          setError(null);
        })
        .catch((err: unknown) => {
          if (ticket !== latest.current) return;
          setResults([]);
          const status = err instanceof ApiError ? err.status : 0;
          setError(
            status === 429
              ? // The one message where trying again *does* work, so it says to wait rather
                // than offering a retry that will be refused too.
                'Too many searches just now. Wait a moment and try again.'
              : 'Could not search this board. Try again.',
          );
        })
        .finally(() => {
          if (ticket === latest.current) setLoading(false);
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [slug, trimmed, active]);

  return { results, loading, error, active };
}
