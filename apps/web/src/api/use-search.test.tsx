import { renderHook, waitFor } from '@testing-library/react';
import { useSearch } from './use-search';
import { fakeApi, recommendation } from '../test-support';

const SEARCH = 'GET /api/v1/creators/ada-writes/recommendations/similar';
const hit = (title: string) => ({ items: [recommendation({ customTitle: title })] });

describe('useSearch', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('is inactive until the query is long enough', async () => {
    const fetch = fakeApi({ [SEARCH]: hit('Princess Mononoke') });
    global.fetch = fetch;
    const { result } = renderHook(() => useSearch('ada-writes', 'm'));

    await waitFor(() => expect(result.current.active).toBe(false));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('ignores a query that is only whitespace', async () => {
    // It trims to nothing, and the server answers 400 for it — so the request is not merely
    // unproductive, it is refused.
    const fetch = fakeApi({ [SEARCH]: hit('Princess Mononoke') });
    global.fetch = fetch;
    const { result } = renderHook(() => useSearch('ada-writes', '    '));

    await waitFor(() => expect(result.current.active).toBe(false));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns what the board matched', async () => {
    global.fetch = fakeApi({ [SEARCH]: hit('Princess Mononoke') });
    const { result } = renderHook(() => useSearch('ada-writes', 'mononoke'));

    await waitFor(() => expect(result.current.results).toHaveLength(1));
    expect(result.current.results[0].customTitle).toBe('Princess Mononoke');
    expect(result.current.error).toBeNull();
  });

  it('drops results the moment the query stops being searchable', async () => {
    // The component hides the results area when the query is too short, so stale state is
    // invisible there — until a *new* search is in flight, when the previous board's matches
    // render under "Searching…" and can be clicked before they are replaced.
    global.fetch = fakeApi({ [SEARCH]: hit('Princess Mononoke') });
    const { result, rerender } = renderHook(({ q }) => useSearch('ada-writes', q), {
      initialProps: { q: 'mononoke' },
    });
    await waitFor(() => expect(result.current.results).toHaveLength(1));

    rerender({ q: '' });

    expect(result.current.results).toEqual([]);
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('searches again when the reader moves to another board', async () => {
    // The slug is part of the question. Carrying one board's matches to the next would offer
    // entries that do not exist here.
    global.fetch = fakeApi({
      [SEARCH]: hit('Princess Mononoke'),
      'GET /api/v1/creators/bo-reads/recommendations/similar': hit('Nausicaa'),
    });
    const { result, rerender } = renderHook(({ slug }) => useSearch(slug, 'ghibli'), {
      initialProps: { slug: 'ada-writes' },
    });
    await waitFor(() => expect(result.current.results[0]?.customTitle).toBe('Princess Mononoke'));

    rerender({ slug: 'bo-reads' });

    await waitFor(() => expect(result.current.results[0]?.customTitle).toBe('Nausicaa'));
  });

  it('survives a body without an items array', async () => {
    // The same shape check `useThemes` documents: a body without `items` set state to undefined,
    // and every consumer reading `.length` off it crashed the page it was meant to help.
    global.fetch = fakeApi({ [SEARCH]: {} });
    const { result } = renderHook(() => useSearch('ada-writes', 'mononoke'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.results).toEqual([]);
  });

  it('makes one request for a word typed one letter at a time', async () => {
    // The endpoint is the one read with a measured per-request cost and carries its own rate
    // limit. Without the debounce a six-letter word spends five of a reader's budget on
    // prefixes they never meant to search for.
    const fetch = fakeApi({ [SEARCH]: hit('Princess Mononoke') });
    global.fetch = fetch;
    const { result, rerender } = renderHook(({ q }) => useSearch('ada-writes', q), {
      initialProps: { q: 'mo' },
    });
    for (const q of ['mon', 'mono', 'monon', 'mononoke']) rerender({ q });

    await waitFor(() => expect(result.current.results).toHaveLength(1));
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
