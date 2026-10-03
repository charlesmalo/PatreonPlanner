import { act, renderHook, waitFor } from '@testing-library/react';
import { api } from './client';
import { UNREAD_POLL_MS, useBoard, useNotifications, useSession } from './hooks';
import { fakeApi, recommendation } from '../test-support';

describe('useSession', () => {
  const originalFetch = global.fetch;
  const originalLocation = window.location;

  beforeEach(() => {
    Object.defineProperty(window, 'location', {
      value: { assign: vi.fn() },
      writable: true,
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    Object.defineProperty(window, 'location', { value: originalLocation, writable: true });
  });

  it('exposes the signed-in user', async () => {
    global.fetch = fakeApi({
      'GET /api/v1/me': { id: 'u1', patreonUserId: 'p1', fullName: 'Ada', avatarUrl: null },
    });
    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.user?.fullName).toBe('Ada');
  });

  it('treats a 401 as anonymous rather than an error', async () => {
    global.fetch = fakeApi({ 'GET /api/v1/me': new Error('401') });
    const { result } = renderHook(() => useSession());
    // Every logged-out visitor hits this path; an error state here would be wrong.
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.user).toBeNull();
  });

  it('signs out against the root-mounted route, not the versioned one', async () => {
    const fetchMock = fakeApi({
      'GET /api/v1/me': { id: 'u1', patreonUserId: 'p1', fullName: 'Ada', avatarUrl: null },
      'POST /auth/logout': null,
    });
    global.fetch = fetchMock;
    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.user).not.toBeNull());

    await act(async () => {
      await result.current.signOut();
    });

    // The API excludes auth/logout from /api/v1. Calling the prefixed path 404s and the session
    // is never destroyed — which is exactly what shipped before this test existed.
    const called = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(called).toContain('/auth/logout');
    expect(called).not.toContain('/api/v1/auth/logout');
  });

  it('still clears the session when logout fails', async () => {
    global.fetch = fakeApi({
      'GET /api/v1/me': { id: 'u1', patreonUserId: 'p1', fullName: 'Ada', avatarUrl: null },
      'POST /auth/logout': new Error('500'),
    });
    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.user).not.toBeNull());

    await act(async () => {
      await result.current.signOut().catch(() => undefined);
    });
    // Leaving a signed-in header over a session we can no longer vouch for would be worse.
    expect(window.location.assign).toHaveBeenCalledWith('/');
  });
});

describe('useBoard', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('asks for the reader&apos;s region, and omits it when they have none', async () => {
    // The seam that makes the whole preference work. Everything either side of it had tests —
    // the hook that stores the choice, the control that changes it, the API that honours it —
    // and the request in the middle carried nothing, which no test could see.
    const fetchMock = fakeApi({
      'GET /api/v1/creators/ada-writes/recommendations': { items: [], nextCursor: null },
    });
    global.fetch = fetchMock;

    const { rerender } = renderHook(
      ({ region }) => useBoard('ada-writes', true, [], 'ACCEPTED', 'upvotes', region),
      {
        initialProps: { region: 'GB' as string | null },
      },
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(String(fetchMock.mock.calls[0][0])).toContain('region=GB');

    rerender({ region: null });

    // Not `region=` or `region=null`: no choice means the server applies its own default, and
    // sending an empty one would be asking for a region named "".
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(1));
    const latest = String(fetchMock.mock.calls[fetchMock.mock.calls.length - 1][0]);
    expect(latest).not.toContain('region');
  });

  it('reports loading until the fetch for this creator lands', async () => {
    global.fetch = fakeApi({
      'GET /api/v1/creators/a/recommendations': { items: [recommendation()], nextCursor: null },
    });
    const { result } = renderHook(() => useBoard('a', true));
    // Not "loaded and empty" — that flashed an empty state before the fetch began.
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.items).toHaveLength(1);
  });

  it('stays in a loading state while disabled rather than claiming an empty board', () => {
    global.fetch = fakeApi({});
    const { result } = renderHook(() => useBoard('a', false));
    expect(result.current.loading).toBe(true);
    expect(result.current.items).toEqual([]);
  });

  it('does not show one creator’s entries under another', async () => {
    global.fetch = fakeApi({
      'GET /api/v1/creators/a/recommendations': {
        items: [recommendation({ id: 'from-a' })],
        nextCursor: null,
      },
      'GET /api/v1/creators/b/recommendations': {
        items: [recommendation({ id: 'from-b' })],
        nextCursor: null,
      },
    });
    const { result, rerender } = renderHook(({ slug }) => useBoard(slug, true), {
      initialProps: { slug: 'a' },
    });
    await waitFor(() => expect(result.current.items[0].id).toBe('from-a'));

    rerender({ slug: 'b' });
    // The moment the slug changes the previous creator's data is no longer "loaded".
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.items[0].id).toBe('from-b'));
  });

  it('surfaces a load-more failure instead of failing silently', async () => {
    let call = 0;
    global.fetch = fakeApi({
      'GET /api/v1/creators/a/recommendations': () => {
        call += 1;
        return call === 1 ? { items: [recommendation()], nextCursor: 'cur' } : new Error('500');
      },
    });
    const { result } = renderHook(() => useBoard('a', true));
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    await act(async () => {
      await result.current.loadMore();
    });
    // Previously this rejected into the click handler and the button just stopped spinning.
    expect(result.current.moreError).toMatch(/could not load more/i);
  });
});

describe('useSession reconciliation', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('drops the signed-in user when a later request comes back unauthorized', async () => {
    // The session is fetched once at mount and never re-checked, so anything that ends it later
    // — an expired or revoked session, a sign-out in another tab, a server that lost its session
    // store — left the header confidently showing a name while every write failed telling the
    // reader to sign in, with no way back except reloading by hand.
    global.fetch = fakeApi({
      'GET /api/v1/me': { id: 'u1', patreonUserId: 'p1', fullName: 'Ada', avatarUrl: null },
      'POST /api/v1/creators/ada-writes/recommendations/rec-1/flags': new Error('401'),
    });
    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.user?.fullName).toBe('Ada'));

    await act(async () => {
      await api
        .post('/creators/ada-writes/recommendations/rec-1/flags', { reason: 'SPAM' })
        .catch(() => undefined);
    });

    expect(result.current.user).toBeNull();
  });

  it('leaves the session alone when a request fails for any other reason', async () => {
    // A 403 is "not allowed", not "not signed in". Treating every failure as a lost session would
    // sign people out for hitting a rate limit.
    global.fetch = fakeApi({
      'GET /api/v1/me': { id: 'u1', patreonUserId: 'p1', fullName: 'Ada', avatarUrl: null },
      'POST /api/v1/creators/ada-writes/recommendations/rec-1/flags': new Error('403'),
    });
    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.user?.fullName).toBe('Ada'));

    await act(async () => {
      await api
        .post('/creators/ada-writes/recommendations/rec-1/flags', { reason: 'SPAM' })
        .catch(() => undefined);
    });

    expect(result.current.user?.fullName).toBe('Ada');
  });
});

describe('useNotifications', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.useRealTimers();
  });

  const unread = (id: string) => ({
    id,
    type: 'ENTRY_STATUS_CHANGED' as const,
    readAt: null,
    createdAt: '2026-08-24T10:00:00.000Z',
    payload: {
      recommendationId: 'rec-1',
      title: 'Cowboy Bebop',
      creatorSlug: 'ada-writes',
      creatorName: 'Ada Writes',
      status: 'ACCEPTED' as const,
    },
  });

  it('asks for nothing at all when signed out', async () => {
    global.fetch = fakeApi({});
    renderHook(() => useNotifications(false));
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('polls the count rather than the list', async () => {
    global.fetch = fakeApi({ 'GET /api/v1/notifications/unread-count': { count: 3 } });

    const { result } = renderHook(() => useNotifications(true));

    await waitFor(() => expect(result.current.unreadCount).toBe(3));
    // The badge is the only thing on a timer: fetching twenty rows every minute for every
    // signed-in reader answers a question that is only ever "is there anything new".
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(result.current.items).toEqual([]);
  });

  it('stops polling once the reader signs out', async () => {
    vi.useFakeTimers();
    global.fetch = fakeApi({ 'GET /api/v1/notifications/unread-count': { count: 1 } });
    const { rerender } = renderHook(({ on }) => useNotifications(on), {
      initialProps: { on: true },
    });
    const before = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.length;

    rerender({ on: false });
    await act(async () => {
      vi.advanceTimersByTime(UNREAD_POLL_MS * 3);
    });

    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before);
  });

  it('loads the list on open and marks read only what it showed', async () => {
    const readCalls: unknown[] = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      if (path === '/api/v1/notifications/unread-count') {
        return { ok: true, status: 200, json: async () => ({ count: 2 }) } as Response;
      }
      if (path === '/api/v1/notifications' && (init?.method ?? 'GET') === 'GET') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ items: [unread('n1'), unread('n2')], nextCursor: 'n2' }),
        } as Response;
      }
      readCalls.push(JSON.parse(String(init?.body)));
      return { ok: true, status: 200, json: async () => ({ updated: 2 }) } as Response;
    });
    const { result } = renderHook(() => useNotifications(true));
    await waitFor(() => expect(result.current.unreadCount).toBe(2));

    await act(async () => {
      await result.current.open();
    });

    expect(result.current.items).toHaveLength(2);
    // By id, not "everything unread": a second page exists here, and the panel has no way to
    // reach it, so marking it read would consume rows the reader can never see.
    expect(readCalls).toEqual([{ ids: ['n1', 'n2'] }]);
    expect(result.current.unreadCount).toBe(0);
  });

  it('reports a failure instead of showing an empty list', async () => {
    global.fetch = fakeApi({
      'GET /api/v1/notifications/unread-count': { count: 1 },
      'GET /api/v1/notifications': new Error('500'),
    });
    const { result } = renderHook(() => useNotifications(true));
    await waitFor(() => expect(result.current.unreadCount).toBe(1));

    await act(async () => {
      await result.current.open();
    });

    // An empty panel under a "1 unread" badge reads as a bug in the app.
    expect(result.current.failed).toBe(true);
    expect(result.current.unreadCount).toBe(1);
  });
});
