import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FollowButton } from './FollowButton';

describe('FollowButton', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const setup = (following = false) => {
    const calls: Array<{ method: string; path: string }> = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        method: init?.method ?? 'GET',
        path: new URL(String(input), 'http://localhost').pathname,
      });
      return { ok: true, status: 204, json: async () => ({}) } as Response;
    }) as unknown as typeof global.fetch;
    render(
      <FollowButton
        slug="ada-writes"
        recommendationId="rec-1"
        title="Akira"
        following={following}
      />,
    );
    return calls;
  };

  it('names the entry, so a screen reader on a long board knows which one', () => {
    setup();

    expect(screen.getByRole('button', { name: /Follow “Akira”/ })).toBeInTheDocument();
  });

  it('follows, and says it is following', async () => {
    const calls = setup();

    await userEvent.click(screen.getByRole('button', { name: /Follow “Akira”/ }));

    expect(
      await screen.findByRole('button', { name: /Stop following “Akira”/ }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(calls).toEqual([
        { method: 'POST', path: '/api/v1/creators/ada-writes/recommendations/rec-1/follow' },
      ]),
    );
  });

  it('unfollows an entry already followed', async () => {
    const calls = setup(true);

    await userEvent.click(screen.getByRole('button', { name: /Stop following “Akira”/ }));

    await waitFor(() => expect(calls[0]?.method).toBe('DELETE'));
  });

  it('puts the state back when the server refuses', async () => {
    // Optimistic, then reconciled: a control that goes on claiming a change the server refused is
    // worse than one that flickers.
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({}),
    })) as unknown as typeof global.fetch;
    render(
      <FollowButton slug="ada-writes" recommendationId="rec-1" title="Akira" following={false} />,
    );

    await userEvent.click(screen.getByRole('button', { name: /Follow “Akira”/ }));

    expect(await screen.findByRole('button', { name: /Follow “Akira”/ })).toBeInTheDocument();
  });

  it('marks its pressed state, not only its label', () => {
    setup(true);

    expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'true');
  });
});
