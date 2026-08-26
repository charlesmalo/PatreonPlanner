import { renderHook, waitFor } from '@testing-library/react';
import { useCatalogSearch } from './use-catalog-search';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const hit = (name: string) => ({
  tmdbId: 1,
  mediaType: 'MOVIE' as const,
  name,
  year: 2000,
  posterPath: null,
});

describe('useCatalogSearch', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    vi.useRealTimers();
  });

  const respondWith = (byQuery: Record<string, Promise<{ results: unknown[] }>>, seen?: string[]) =>
    vi.fn(async (input: RequestInfo | URL) => {
      const q = new URL(String(input), 'http://localhost').searchParams.get('q') ?? '';
      seen?.push(q);
      return {
        ok: true,
        status: 200,
        json: async () => await byQuery[q],
      } as Response;
    });

  it('ignores a slow response that a later keystroke superseded', async () => {
    // The failure this prevents is invisible in the happy path: a slow response for the shorter
    // query lands after a fast one for the longer, and the list flickers backwards to results
    // for text the user has already finished replacing.
    const slow = deferred<{ results: unknown[] }>();
    const fetched: string[] = [];
    global.fetch = respondWith(
      {
        gh: slow.promise,
        ghibli: Promise.resolve({ results: [hit('Ghibli Collection')] }),
      },
      fetched,
    );

    const { result, rerender } = renderHook(({ q }) => useCatalogSearch('ada-writes', q, false), {
      initialProps: { q: 'gh' },
    });
    // Past the debounce, so the first request is genuinely in flight rather than cancelled by
    // the next keystroke. Without this wait there is only ever one request and the test cannot
    // observe the race it is named for.
    await waitFor(() => expect(fetched).toContain('gh'), { timeout: 2000 });

    rerender({ q: 'ghibli' });
    await waitFor(() => expect(result.current.results).toHaveLength(1), { timeout: 2000 });
    expect(result.current.results[0]).toMatchObject({ name: 'Ghibli Collection' });

    // Now let the superseded request finish. It must change nothing.
    slow.resolve({ results: [hit('Stale Result')] });
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current.results[0]).toMatchObject({ name: 'Ghibli Collection' });
  });

  it('does not search once a title has been picked', async () => {
    // Leaving it running repopulates the list underneath the choice that closed it.
    const fetchMock = respondWith({ ghibli: Promise.resolve({ results: [hit('Ghibli')] }) });
    global.fetch = fetchMock;

    renderHook(() => useCatalogSearch('ada-writes', 'ghibli', true));
    await new Promise((r) => setTimeout(r, 400));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('says the catalogue is unreachable rather than showing an empty result', async () => {
    // Design §5: no match means refine or add a link, not a dead end.
    global.fetch = vi.fn(async () => {
      throw new Error('offline');
    });

    const { result } = renderHook(() => useCatalogSearch('ada-writes', 'ghibli', false));

    await waitFor(() => expect(result.current.error).toMatch(/could not search/i));
    expect(result.current.results).toEqual([]);
  });
});
