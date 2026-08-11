import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from './client';
import type { Board, Capabilities, CreatorProfile, SessionUser } from './types';

const NO_CAPABILITIES: Capabilities = {
  view: false,
  upvote: false,
  submit: false,
  moderate: false,
};

export function useSession() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api
      .get<SessionUser>('/me')
      .then((value) => {
        if (!cancelled) setUser(value);
      })
      // A 401 is the ordinary anonymous case, not a failure — rendering an error for every
      // logged-out visitor would be wrong.
      .catch(() => {
        if (!cancelled) setUser(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const signOut = useCallback(async () => {
    try {
      // Root-mounted: the API excludes auth/logout from the /api/v1 prefix, so prefixing it 404s
      // and the session would survive a click that looked like it worked.
      await api.postRoot('/auth/logout');
    } finally {
      setUser(null);
      // Reload regardless: a failed logout must not leave the UI showing a signed-in header over
      // a session whose state we no longer know.
      window.location.assign('/');
    }
  }, []);

  return { user, loading, signOut };
}

export function useCreator(slug: string) {
  const [creator, setCreator] = useState<CreatorProfile | null>(null);
  const [capabilities, setCapabilities] = useState<Capabilities>(NO_CAPABILITIES);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      api.get<CreatorProfile>(`/creators/${encodeURIComponent(slug)}`),
      api.get<Capabilities>(`/creators/${encodeURIComponent(slug)}/capabilities`),
    ])
      .then(([profile, caps]) => {
        if (cancelled) return;
        setCreator(profile);
        setCapabilities(caps);
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
  }, [slug]);

  return { creator, capabilities, error, loading };
}

export function useBoard(slug: string, enabled: boolean) {
  const [items, setItems] = useState<Board['items']>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  // Which path the state above belongs to. Without it, navigating between creators rendered the
  // previous creator's suggestions under the new creator's name until the refetch landed, and a
  // stale error stuck around.
  const [loadedPath, setLoadedPath] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);

  const path = `/creators/${encodeURIComponent(slug)}/recommendations`;

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
      const board = await api.get<Board>(`${path}?cursor=${encodeURIComponent(cursor)}`);
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
    prepend,
  };
}
