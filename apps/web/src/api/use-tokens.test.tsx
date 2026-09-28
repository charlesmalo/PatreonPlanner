import { act, renderHook, waitFor } from '@testing-library/react';
import { useTokens } from './use-tokens';
import { fakeApi } from '../test-support';

const balance = {
  enabled: true,
  available: 3,
  ledger: [
    {
      id: 'l1',
      kind: 'TIER_GRANT' as const,
      amount: 3,
      periodKey: '2026-09',
      reason: null,
      createdAt: '2026-09-01T00:00:00.000Z',
    },
  ],
};

describe('useTokens', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('reads this reader&apos;s balance on this board', async () => {
    global.fetch = fakeApi({ 'GET /api/v1/creators/ada-writes/tokens': balance });
    const { result } = renderHook(() => useTokens('ada-writes', true));

    await waitFor(() => expect(result.current.available).toBe(3));
    expect(result.current.enabled).toBe(true);
    expect(result.current.ledger).toHaveLength(1);
  });

  it('asks for nothing at all when the reader is not signed in', async () => {
    // The request is 401 for a stranger, and every anonymous visitor would make it. Worse, the
    // read is what grants — so firing it disabled would mean granting on a guess about who is
    // asking.
    const fetch = fakeApi({ 'GET /api/v1/creators/ada-writes/tokens': balance });
    global.fetch = fetch;
    const { result } = renderHook(() => useTokens('ada-writes', false));

    await waitFor(() => expect(result.current.available).toBe(0));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('stays silent when the balance cannot be read', async () => {
    // Tokens sit on top of a board that works without them. An error here would take down the
    // board for a reader whose only problem is an optional extra.
    global.fetch = fakeApi({
      'GET /api/v1/creators/ada-writes/tokens': new Error('500'),
    });
    const { result } = renderHook(() => useTokens('ada-writes', true));

    await waitFor(() => expect(result.current.enabled).toBe(false));
    expect(result.current.available).toBe(0);
    expect(result.current.ledger).toEqual([]);
  });

  it('drops a balance it can no longer confirm, rather than showing a stale one', async () => {
    // Starting from zero cannot tell "reset" apart from "keep" — only a failure after a good
    // read can. A kept balance draws a redeem control funded by tokens that may already be
    // spent, and every press of it fails.
    let fail = false;
    global.fetch = fakeApi({
      'GET /api/v1/creators/ada-writes/tokens': () => {
        if (fail) throw Object.assign(new Error('nope'), { status: 500 });
        return balance;
      },
    });
    const { result } = renderHook(() => useTokens('ada-writes', true));
    await waitFor(() => expect(result.current.available).toBe(3));

    fail = true;
    await act(() => result.current.refresh());

    expect(result.current.available).toBe(0);
    expect(result.current.enabled).toBe(false);
  });

  it('re-reads on demand, which is how a spend updates the balance', async () => {
    let available = 3;
    global.fetch = fakeApi({
      'GET /api/v1/creators/ada-writes/tokens': () => ({ ...balance, available }),
    });
    const { result } = renderHook(() => useTokens('ada-writes', true));
    await waitFor(() => expect(result.current.available).toBe(3));

    available = 2;
    await act(() => result.current.refresh());

    expect(result.current.available).toBe(2);
  });

  it('re-reads when the reader moves to another board', async () => {
    // The balance is per creator. Carrying one board&apos;s number to the next would offer a
    // redeem control funded by tokens that do not exist here.
    global.fetch = fakeApi({
      'GET /api/v1/creators/ada-writes/tokens': balance,
      'GET /api/v1/creators/bo-reads/tokens': { ...balance, available: 1 },
    });
    const { result, rerender } = renderHook(({ slug }) => useTokens(slug, true), {
      initialProps: { slug: 'ada-writes' },
    });
    await waitFor(() => expect(result.current.available).toBe(3));

    rerender({ slug: 'bo-reads' });

    await waitFor(() => expect(result.current.available).toBe(1));
  });
});
