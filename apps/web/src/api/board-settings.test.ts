import {
  hydrate,
  localCollapsed,
  localSort,
  localThemes,
  remember,
  rememberThemes,
} from './board-settings';

describe('board settings', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    window.localStorage.clear();
  });

  const ok = (body: unknown) =>
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => body,
    })) as unknown as typeof global.fetch;

  it('reads the local value without waiting on anything', () => {
    // Synchronous on purpose. A board that waits on a request before it can render is a worse
    // board for everybody, including the reader who paid for the syncing.
    window.localStorage.setItem('pp.board.ada.collapsed.PENDING', 'true');
    window.localStorage.setItem('pp.board.ada.sort.ACTIVE', 'manual');

    expect(localCollapsed('ada', 'PENDING')).toBe(true);
    expect(localSort('ada', 'ACTIVE')).toBe('manual');
    expect(localSort('ada', 'PENDING')).toBe('');
  });

  it('records a change locally before the request happens', async () => {
    let resolveRequest: () => void = () => {};
    global.fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveRequest = () =>
            resolve({ ok: true, status: 200, json: async () => ({}) } as Response);
        }),
    ) as unknown as typeof global.fetch;

    const pending = remember('ada', 'PENDING', { collapsed: true });

    // Already true, with the request still in flight: the reader has seen the column fold.
    expect(localCollapsed('ada', 'PENDING')).toBe(true);
    resolveRequest();
    await pending;
  });

  it('keeps the local change when the server refuses it', async () => {
    // A free reader's 402, or any failure. Losing a change the reader has already seen take
    // effect is worse than not syncing it.
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 402,
      json: async () => ({}),
    })) as unknown as typeof global.fetch;

    await remember('ada', 'ACTIVE', { sort: 'manual' });

    expect(localSort('ada', 'ACTIVE')).toBe('manual');
  });

  it('sends the whole arrangement, because the endpoint replaces rather than patches', async () => {
    const bodies: unknown[] = [];
    global.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }) as unknown as typeof global.fetch;
    window.localStorage.setItem('pp.board.ada.collapsed.COMPLETED', 'true');

    await remember('ada', 'ACTIVE', { sort: 'manual' });

    expect(bodies).toEqual([{ collapsed: ['COMPLETED'], sorts: { ACTIVE: 'manual' } }]);
  });

  it('lets the stored arrangement win over the local one', async () => {
    // The whole feature. They can only disagree when the reader arranged this board somewhere
    // else, which is exactly when the stored answer is the right one.
    window.localStorage.setItem('pp.board.ada.collapsed.PENDING', 'true');
    global.fetch = ok({ collapsed: ['ACTIVE'], sorts: { ACTIVE: 'manual' }, canSync: true });

    expect(await hydrate('ada')).toBe(true);

    expect(localCollapsed('ada', 'PENDING')).toBe(false);
    expect(localCollapsed('ada', 'ACTIVE')).toBe(true);
    expect(localSort('ada', 'ACTIVE')).toBe('manual');
  });

  it('leaves a non-syncing reader’s arrangement alone', async () => {
    // Their local copy is the only copy, and an empty server answer must not wipe it.
    window.localStorage.setItem('pp.board.ada.collapsed.PENDING', 'true');
    global.fetch = ok({ collapsed: [], sorts: {}, canSync: false });

    expect(await hydrate('ada')).toBe(false);

    expect(localCollapsed('ada', 'PENDING')).toBe(true);
  });

  it('leaves the local arrangement alone when the request fails', async () => {
    window.localStorage.setItem('pp.board.ada.collapsed.PENDING', 'true');
    global.fetch = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof global.fetch;

    expect(await hydrate('ada')).toBe(false);
    expect(localCollapsed('ada', 'PENDING')).toBe(true);
  });

  describe('label filters', () => {
    it('starts with nothing filtering', () => {
      expect(localThemes('ada-writes')).toEqual([]);
    });

    it('remembers the selection for the whole board, not per column', async () => {
      // Shared across columns on purpose: a reader narrowing to Anime and swapping to Accepted is
      // still asking about Anime, and a per-status key would look like the filter clearing itself.
      await rememberThemes('ada-writes', [['t1'], ['t2']]);
      expect(localThemes('ada-writes')).toEqual([['t1'], ['t2']]);
    });

    it('keeps one board filter out of another board', async () => {
      await rememberThemes('ada-writes', [['t1']]);
      expect(localThemes('mo-reads')).toEqual([]);
    });

    it('clears back to empty', async () => {
      await rememberThemes('ada-writes', [['t1']]);
      await rememberThemes('ada-writes', []);
      expect(localThemes('ada-writes')).toEqual([]);
    });

    it('remembers groups, not just labels', async () => {
      await rememberThemes('ada-writes', [['t1', 't2'], ['t3']]);
      expect(localThemes('ada-writes')).toEqual([['t1', 't2'], ['t3']]);
    });

    it('reads a value written before groups existed as one group each', async () => {
      // #131 wrote `t1,t2`. That meant `(t1) OR (t2)` then and means the same now, so a reader
      // who filtered before this shipped finds their filter intact.
      window.localStorage.setItem('pp.board.ada-writes.themes', 't1,t2');
      expect(localThemes('ada-writes')).toEqual([['t1'], ['t2']]);
    });

    it('sends nothing to the server', async () => {
      // Local only: the view-settings payload carries collapse and sort, and adding a field there
      // is a DTO change for something documented as best-effort arrangement.
      const fetchSpy = vi.fn();
      global.fetch = fetchSpy;
      await rememberThemes('ada-writes', [['t1']]);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});
