import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from './client';
import type { Board, Recommendation, ThemeSummary } from './types';

/** Reading the board itself: its columns, its themes, and one entry on its own page. */

export function useThemes(slug: string, enabled: boolean) {
  const [themes, setThemes] = useState<ThemeSummary[]>([]);
  const path = `/creators/${encodeURIComponent(slug)}/themes`;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    api
      .get<{ items: ThemeSummary[] }>(path)
      // Themes are a way to narrow the board, not a reason to fail rendering it — which is why
      // the shape is checked as well as the request. A body without `items` set state to
      // undefined, and every consumer reading `.length` off that crashed the page it was meant
      // to be a convenience on.
      .then((body) => !cancelled && setThemes(Array.isArray(body?.items) ? body.items : []))
      .catch(() => !cancelled && setThemes([]));
    return () => {
      cancelled = true;
    };
  }, [path, enabled]);

  return themes;
}

export function useBoard(
  slug: string,
  enabled: boolean,
  themeIds?: string[],
  status?: string,
  sort?: string,
) {
  const [items, setItems] = useState<Board['items']>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  // Which path the state above belongs to. Without it, navigating between creators rendered the
  // previous creator's suggestions under the new creator's name until the refetch landed, and a
  // stale error stuck around.
  const [loadedPath, setLoadedPath] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);

  // The labels, the column and the sort are all part of the path, so changing any of them
  // refetches and resets paging — a cursor from one ordering means nothing in another, and
  // re-sorting a page already fetched would sort one page of a list with more behind it.
  //
  // Sorted before joining so the same selection always produces the same path: picking Anime then
  // Thriller and picking them the other way round are the same filter, and two spellings of it
  // would refetch for no reason and defeat any cache keyed on the path.
  const query = new URLSearchParams();
  if (themeIds && themeIds.length > 0) query.set('themes', [...themeIds].sort().join(','));
  if (status) query.set('status', status);
  if (sort) query.set('sort', sort);
  const search = query.toString();
  const path = `/creators/${encodeURIComponent(slug)}/recommendations${search ? `?${search}` : ''}`;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setError(null);
    api
      .get<Board>(path)
      .then((board) => {
        if (cancelled) return;
        setItems(board.items);
        setCursor(board.nextCursor);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err : new ApiError(0));
      })
      .finally(() => {
        if (!cancelled) setLoadedPath(path);
      });
    return () => {
      cancelled = true;
    };
  }, [path, enabled]);

  const loadMore = useCallback(async () => {
    if (!cursor) return;
    setLoadingMore(true);
    setMoreError(null);
    const requestedPath = path;
    try {
      const board = await api.get<Board>(
        `${path}${path.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(cursor)}`,
      );
      // Dropped if the viewer navigated away mid-request: otherwise creator A's second page
      // lands on creator B's board.
      if (requestedPath !== path) return;
      // De-duplicate by id: the board sorts on a live counter, so an entry upvoted between
      // pages can legitimately appear twice.
      setItems((current) => {
        const seen = new Set(current.map((i) => i.id));
        return [...current, ...board.items.filter((i) => !seen.has(i.id))];
      });
      setCursor(board.nextCursor);
    } catch {
      // A silent failure leaves the button simply not working, with nothing to tell the reader.
      setMoreError('Could not load more. Try again.');
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, path]);

  const applyUpvote = useCallback((id: string, upvoteCount: number, upvoted?: boolean) => {
    setItems((current) =>
      current.map((i) =>
        i.id === id
          ? { ...i, upvoteCount, ...(upvoted === undefined ? {} : { hasUpvoted: upvoted }) }
          : i,
      ),
    );
  }, []);

  const applyStatus = useCallback((id: string, status: string) => {
    setItems((current) => current.map((i) => (i.id === id ? { ...i, status } : i)));
  }, []);

  /** An entry that has moved to another column is no longer this one's to show. */
  const remove = useCallback((id: string) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const prepend = useCallback((item: Board['items'][number]) => {
    setItems((current) => [item, ...current.filter((i) => i.id !== item.id)]);
  }, []);

  return {
    items,
    // Anything not yet loaded for *this* path is still loading, which also removes the flash of
    // "nothing suggested yet" before the enabled fetch starts.
    loading: loadedPath !== path,
    loadingMore,
    error,
    moreError,
    hasMore: cursor !== null,
    loadMore,
    applyUpvote,
    applyStatus,
    remove,
    prepend,
  };
}

/** Conservative on purpose: this fires for every signed-in reader for as long as the tab is open. */

/** One entry, for its own page. Separate from the board so a shared link needs no board load. */
export function useEntry(slug: string, id: string) {
  const [entry, setEntry] = useState<Recommendation | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);

  const path = `/creators/${encodeURIComponent(slug)}/recommendations/${encodeURIComponent(id)}`;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .get<Recommendation>(path)
      .then((value) => {
        if (!cancelled) setEntry(value);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err : new ApiError(0));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  /** The card's controls report counts back; the page holds one entry, so it just replaces it. */
  const applyUpvote = useCallback((_id: string, upvoteCount: number, hasUpvoted?: boolean) => {
    setEntry((current) =>
      current ? { ...current, upvoteCount, hasUpvoted: hasUpvoted ?? current.hasUpvoted } : current,
    );
  }, []);

  const applyStatus = useCallback((_id: string, status: string) => {
    setEntry((current) =>
      current ? { ...current, status: status as Recommendation['status'] } : current,
    );
  }, []);

  return { entry, error, loading, applyUpvote, applyStatus };
}
