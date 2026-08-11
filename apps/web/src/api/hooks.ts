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
    await api.post('/auth/logout');
    setUser(null);
    // Reload so every hook re-reads its state against the now-anonymous session rather than
    // holding data the viewer may no longer be entitled to.
    window.location.assign('/');
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
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const path = `/creators/${encodeURIComponent(slug)}/recommendations`;

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
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
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path, enabled]);

  const loadMore = useCallback(async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const board = await api.get<Board>(`${path}?cursor=${encodeURIComponent(cursor)}`);
      // De-duplicate by id: the board sorts on a live counter, so an entry upvoted between
      // pages can legitimately appear twice.
      setItems((current) => {
        const seen = new Set(current.map((i) => i.id));
        return [...current, ...board.items.filter((i) => !seen.has(i.id))];
      });
      setCursor(board.nextCursor);
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, path]);

  const applyUpvote = useCallback((id: string, upvoteCount: number) => {
    setItems((current) => current.map((i) => (i.id === id ? { ...i, upvoteCount } : i)));
  }, []);

  const prepend = useCallback((item: Board['items'][number]) => {
    setItems((current) => [item, ...current.filter((i) => i.id !== item.id)]);
  }, []);

  return {
    items,
    loading,
    loadingMore,
    error,
    hasMore: cursor !== null,
    loadMore,
    applyUpvote,
    prepend,
  };
}
