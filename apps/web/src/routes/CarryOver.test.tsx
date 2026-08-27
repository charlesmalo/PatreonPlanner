import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { CarryOver } from './CarryOver';

const options = {
  sources: [
    {
      id: 's1',
      customTitle: 'Perfect Blue',
      type: 'EXTERNAL_LINK',
      creator: { slug: 'ada-writes', displayName: 'Ada Writes' },
    },
  ],
  targets: [{ slug: 'other-board', displayName: 'Other Board' }],
};

function renderPage(fetchImpl: typeof global.fetch) {
  global.fetch = fetchImpl;
  return render(
    <MemoryRouter>
      <CarryOver />
    </MemoryRouter>,
  );
}

const routes = (deliveries: unknown[] = [], onPost?: (body: unknown) => void) =>
  vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    if ((init?.method ?? 'GET') === 'POST') {
      onPost?.(JSON.parse(String(init?.body)));
      return { ok: true, status: 201, json: async () => ({ queued: 1 }) } as Response;
    }
    const body = path.endsWith('/options') ? options : deliveries;
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as unknown as typeof global.fetch;

describe('CarryOver', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('offers what you have suggested and where it could go', async () => {
    renderPage(routes());

    expect(await screen.findByRole('checkbox', { name: /Perfect Blue/ })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Other Board/ })).toBeInTheDocument();
  });

  it('will not send until both a source and a board are chosen', async () => {
    renderPage(routes());
    const send = await screen.findByRole('button', { name: /send these/i });
    expect(send).toBeDisabled();

    await userEvent.click(screen.getByRole('checkbox', { name: /Perfect Blue/ }));
    // A source with no board is not a request; neither is a board with nothing to send.
    expect(send).toBeDisabled();

    await userEvent.click(screen.getByRole('checkbox', { name: /Other Board/ }));
    expect(send).toBeEnabled();
  });

  it('sends the chosen sources and boards', async () => {
    const posted: unknown[] = [];
    renderPage(routes([], (body) => posted.push(body)));

    await userEvent.click(await screen.findByRole('checkbox', { name: /Perfect Blue/ }));
    await userEvent.click(screen.getByRole('checkbox', { name: /Other Board/ }));
    await userEvent.click(screen.getByRole('button', { name: /send these/i }));

    await waitFor(() =>
      expect(posted).toEqual([{ sourceIds: ['s1'], creatorSlugs: ['other-board'] }]),
    );
  });

  it('says they are on their way rather than claiming they arrived', async () => {
    // They drain at each board's own rate. Claiming otherwise has people refreshing a list that
    // is working exactly as intended.
    renderPage(routes());
    await userEvent.click(await screen.findByRole('checkbox', { name: /Perfect Blue/ }));
    await userEvent.click(screen.getByRole('checkbox', { name: /Other Board/ }));

    await userEvent.click(screen.getByRole('button', { name: /send these/i }));

    expect(await screen.findByText(/on the way/i)).toBeInTheDocument();
  });

  it('explains each outcome in the reader’s terms, not the enum’s', async () => {
    renderPage(
      routes([
        {
          id: 'd1',
          outcome: 'REFUSED_BEFORE',
          resultRecommendationId: null,
          createdAt: '2026-08-27T10:00:00.000Z',
          creator: { slug: 'other-board', displayName: 'Other Board' },
          source: { id: 's1', customTitle: 'Perfect Blue' },
        },
      ]),
    );

    expect(await screen.findByText(/turned this down before/i)).toBeInTheDocument();
    expect(screen.queryByText('REFUSED_BEFORE')).not.toBeInTheDocument();
  });

  it('explains a refusal rather than crashing', async () => {
    renderPage(
      vi.fn(async () => ({
        ok: false,
        status: 402,
        json: async () => ({}),
      })) as unknown as typeof global.fetch,
    );

    expect(await screen.findByText(/could not load/i)).toBeInTheDocument();
  });
});
