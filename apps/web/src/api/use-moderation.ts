import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from './client';
import type { Notification, ReviewQueueItem } from './types';

/** The surfaces a moderator works: the review queue, and the bell that points at it. */

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
