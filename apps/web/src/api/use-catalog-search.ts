import { useEffect, useRef, useState } from 'react';
import { api } from './client';
import type { CatalogResult } from './types';

const SEARCH_DEBOUNCE_MS = 300;

/**
 * Debounced catalogue search, with the race that matters already handled.
 *
 * Its own hook because it is the only part of the submit form that is pure logic, and the part
 * where getting it wrong is invisible: without the sequence check a slow response for "gh"
 * arriving after a fast one for "ghibli" replaces the right results with stale ones, and the
 * list flickers backwards while the user is still typing.
 *
 * Goes quiet once a title is picked — there is nothing left to search for, and leaving it running
 * repopulates the list underneath the choice that closed it.
 */
export function useCatalogSearch(slug: string, query: string, picked: boolean) {
  const [results, setResults] = useState<CatalogResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const seqRef = useRef(0);

  useEffect(() => {
    if (picked || query.trim().length < 2) {
      setResults([]);
      setSearched(false);
      return;
    }
    setSearched(false);
    const seq = ++seqRef.current;
    const timer = setTimeout(async () => {
      try {
        const response = await api.get<{ results: CatalogResult[] }>(
          `/creators/${encodeURIComponent(slug)}/catalog/search?q=${encodeURIComponent(query.trim())}`,
        );
        // Ignore a response that a later keystroke has superseded, or results flicker backwards.
        if (seq !== seqRef.current) return;
        setResults(response.results);
        setError(null);
        setSearched(true);
      } catch {
        if (seq !== seqRef.current) return;
        setResults([]);
        // Design §5: no match means refine or switch to an external link, not a dead end.
        setError('Could not search the catalogue. You can still add a link below.');
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, picked, slug]);

  return { results, error, searched, setResults, setError };
}
