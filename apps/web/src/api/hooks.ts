import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, onUnauthorized } from './client';
import type {
  Board,
  Capabilities,
  CreatorProfile,
  Notification,
  Recommendation,
  ReviewQueueItem,
  SessionUser,
  ThemeSummary,
} from './types';

const NO_CAPABILITIES: Capabilities = {
  view: false,
  upvote: false,
  submit: false,
  moderate: false,
  administer: false,
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

  // Anything that 401s means the session is gone, whoever the header currently claims to be.
  useEffect(() => onUnauthorized(() => setUser(null)), []);

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

export function useReviewQueue(slug: string) {
  const [items, setItems] = useState<ReviewQueueItem[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);

  const path = `/creators/${encodeURIComponent(slug)}/review-queue`;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .get<{ items: ReviewQueueItem[]; nextOffset: number | null }>(path)
      .then((queue) => {
        if (cancelled) return;
        setItems(queue.items);
        setNextOffset(queue.nextOffset);
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

  /** Applies a moderator's own change locally rather than refetching the whole queue. */
  const update = useCallback((id: string, changes: Partial<ReviewQueueItem>) => {
    setItems((current) => current.map((i) => (i.id === id ? { ...i, ...changes } : i)));
  }, []);

  const dropFlag = useCallback((recommendationId: string, flagId: string) => {
    setItems((current) =>
      current.map((item) =>
        item.id === recommendationId
          ? {
              ...item,
              flags: item.flags.filter((f) => f.id !== flagId),
              // Recomputed from the list rather than decremented, so a double click cannot drive
              // the count below what is actually shown.
              openFlagCount: item.flags.filter((f) => f.id !== flagId).length,
            }
          : item,
      ),
    );
  }, []);

  /**
   * The queue lists every entry on the board, not only flagged ones, so a board with more than a
   * page of entries left its tail permanently unreachable without this.
   */
  const loadMore = useCallback(async () => {
    if (nextOffset === null) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const queue = await api.get<{ items: ReviewQueueItem[]; nextOffset: number | null }>(
        `${path}?offset=${nextOffset}`,
      );
      setItems((current) => {
        const seen = new Set(current.map((i) => i.id));
        return [...current, ...queue.items.filter((i) => !seen.has(i.id))];
      });
      setNextOffset(queue.nextOffset);
    } catch {
      setMoreError('Could not load more. Try again.');
    } finally {
      setLoadingMore(false);
    }
  }, [nextOffset, path]);

  return {
    items,
    loading,
    error,
    update,
    dropFlag,
    loadMore,
    loadingMore,
    moreError,
    hasMore: nextOffset !== null,
  };
}

export function useThemes(slug: string, enabled: boolean) {
  const [themes, setThemes] = useState<ThemeSummary[]>([]);
  const path = `/creators/${encodeURIComponent(slug)}/themes`;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    api
      .get<{ items: ThemeSummary[] }>(path)
      // Themes are a way to narrow the board, not a reason to fail rendering it.
      .then((body) => !cancelled && setThemes(body.items))
      .catch(() => !cancelled && setThemes([]));
    return () => {
      cancelled = true;
    };
  }, [path, enabled]);

  return themes;
}

export function useBoard(slug: string, enabled: boolean, themeId?: string | null) {
  const [items, setItems] = useState<Board['items']>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  // Which path the state above belongs to. Without it, navigating between creators rendered the
  // previous creator's suggestions under the new creator's name until the refetch landed, and a
  // stale error stuck around.
  const [loadedPath, setLoadedPath] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);

  // The theme is part of the path, so switching it refetches and resets paging — the cursor
  // from an unfiltered page means nothing in a filtered one.
  const path = `/creators/${encodeURIComponent(slug)}/recommendations${
    themeId ? `?theme=${encodeURIComponent(themeId)}` : ''
  }`;

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
    prepend,
  };
}

/** Conservative on purpose: this fires for every signed-in reader for as long as the tab is open. */
export const UNREAD_POLL_MS = 60_000;

/**
 * The badge polls a single integer; the list is fetched only when the panel opens, and opening it
 * is what marks the unread rows read. Polling the list instead would move twenty rows on a timer
 * to answer a question that is only ever "is there anything new".
 */
export function useNotifications(enabled: boolean) {
  const [unreadCount, setUnreadCount] = useState(0);
  const [items, setItems] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setUnreadCount(0);
      setItems([]);
      return;
    }
    let cancelled = false;
    const poll = () =>
      api
        .get<{ count: number }>('/notifications/unread-count')
        .then(({ count }) => {
          if (!cancelled) setUnreadCount(count);
        })
        // A failed poll is not worth showing anyone: the badge simply does not move.
        .catch(() => undefined);

    poll();
    const timer = setInterval(poll, UNREAD_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled]);

  const open = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const page = await api.get<{ items: Notification[] }>('/notifications');
      setItems(page.items);
      // Only the rows actually shown. Marking everything read would silently consume anything
      // past the first page — and since the panel has no way to reach a second page, those rows
      // would be both read and unreachable.
      const ids = page.items.filter((item) => item.readAt === null).map((item) => item.id);
      if (ids.length > 0) await api.post('/notifications/read', { ids });
      setUnreadCount((count) => Math.max(0, count - ids.length));
    } catch {
      // The badge is left where it was and the next poll corrects it, but the panel has to say
      // something: an empty list under a "3 unread" badge reads as a bug.
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  return { unreadCount, items, loading, failed, open };
}

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
