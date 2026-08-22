import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { MyVotes } from './MyVotes';

const payload = (overrides = {}) => ({
  items: [
    { recommendationId: 'r1', title: 'Akira', status: 'PENDING', worth: 2 },
    { recommendationId: 'r2', title: 'Ponyo', status: 'PENDING', worth: 20 },
  ],
  currentWorth: 20,
  couldImprove: 1,
  ...overrides,
});

function setup(routes: Record<string, unknown>) {
  const calls: string[] = [];
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    const key = `${init?.method ?? 'GET'} ${path}`;
    calls.push(key);
    const value = routes[key];
    if (value instanceof Error) return { ok: false, status: Number(value.message) } as Response;
    return { ok: true, status: 200, json: async () => value } as Response;
  });
  render(
    <MemoryRouter initialEntries={['/c/ada-writes/my-votes']}>
      <Routes>
        <Route path="/c/:slug/my-votes" element={<MyVotes />} />
      </Routes>
    </MemoryRouter>,
  );
  return calls;
}

describe('MyVotes', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('lists the votes and what each is worth', async () => {
    setup({ 'GET /api/v1/creators/ada-writes/my-votes': payload() });

    expect(await screen.findByText('Akira')).toBeInTheDocument();
    expect(screen.getByText(/worth 2 — below your tier/i)).toBeInTheDocument();
  });

  it('offers to lift the ones cast lower', async () => {
    const calls = setup({
      'GET /api/v1/creators/ada-writes/my-votes': payload(),
      'POST /api/v1/creators/ada-writes/my-votes/refresh': { updated: 1 },
    });
    await screen.findByText('Akira');

    await userEvent.click(screen.getByRole('button', { name: /bring them up to date/i }));

    await waitFor(() => expect(screen.getByText(/updated 1 vote/i)).toBeInTheDocument());
    expect(calls).toContain('POST /api/v1/creators/ada-writes/my-votes/refresh');
  });

  it('offers nothing when every vote already matches the tier', async () => {
    setup({
      'GET /api/v1/creators/ada-writes/my-votes': payload({ couldImprove: 0 }),
    });
    await screen.findByText('Akira');

    expect(
      screen.queryByRole('button', { name: /bring them up to date/i }),
    ).not.toBeInTheDocument();
  });

  it('says so when the board has switched it off', async () => {
    setup({
      'GET /api/v1/creators/ada-writes/my-votes': payload(),
      'POST /api/v1/creators/ada-writes/my-votes/refresh': new Error('403'),
    });
    await screen.findByText('Akira');

    await userEvent.click(screen.getByRole('button', { name: /bring them up to date/i }));

    expect(await screen.findByText(/does not update votes to a new tier/i)).toBeInTheDocument();
  });

  it('says when there is nothing here yet', async () => {
    setup({
      'GET /api/v1/creators/ada-writes/my-votes': payload({ items: [], couldImprove: 0 }),
    });

    expect(await screen.findByText(/have not voted here yet/i)).toBeInTheDocument();
  });
});
