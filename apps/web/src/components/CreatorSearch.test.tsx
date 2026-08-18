import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { CreatorSearch } from './CreatorSearch';
import { fakeApi } from '../test-support';

const results = {
  items: [
    { id: 'c1', slug: 'movie-club', displayName: 'Movie Club', favorited: true, supported: false },
    {
      id: 'c2',
      slug: 'movie-night',
      displayName: 'Movie Night',
      favorited: false,
      supported: true,
    },
    { id: 'c3', slug: 'movie-hour', displayName: 'Movie Hour', favorited: false, supported: false },
  ],
};

describe('CreatorSearch', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const setup = (signedIn = true) =>
    render(
      <MemoryRouter>
        <CreatorSearch signedIn={signedIn} />
      </MemoryRouter>,
    );

  it('searches after a pause and links each result to its board', async () => {
    global.fetch = fakeApi({ 'GET /api/v1/creators': results });
    setup();

    await userEvent.type(screen.getByLabelText(/find a creator/i), 'movie');

    expect(await screen.findByRole('link', { name: /Movie Club/ })).toHaveAttribute(
      'href',
      '/c/movie-club',
    );
  });

  it('says which boards the reader already has a relationship with', async () => {
    global.fetch = fakeApi({ 'GET /api/v1/creators': results });
    setup();

    await userEvent.type(screen.getByLabelText(/find a creator/i), 'movie');
    await screen.findByRole('link', { name: /Movie Club/ });

    // The ranking is already meaningful; saying why it is ordered that way costs one word each.
    expect(screen.getByText(/favourite/i)).toBeInTheDocument();
    expect(screen.getByText(/you support/i)).toBeInTheDocument();
  });

  it('asks for nothing until there is enough to search for', async () => {
    const fetchMock = fakeApi({ 'GET /api/v1/creators': results });
    global.fetch = fetchMock;
    setup();

    await userEvent.type(screen.getByLabelText(/find a creator/i), 'm');

    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('says so when nothing matches', async () => {
    global.fetch = fakeApi({ 'GET /api/v1/creators': { items: [] } });
    setup();

    await userEvent.type(screen.getByLabelText(/find a creator/i), 'nobody');

    expect(await screen.findByText(/no creators match/i)).toBeInTheDocument();
  });

  it('lets a signed-in reader favourite a board from the results', async () => {
    const calls: string[] = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      if ((init?.method ?? 'GET') !== 'GET') {
        calls.push(`${init?.method} ${url.pathname}`);
        return { ok: true, status: 204 } as Response;
      }
      return { ok: true, status: 200, json: async () => results } as Response;
    });
    setup();

    await userEvent.type(screen.getByLabelText(/find a creator/i), 'movie');
    await screen.findByRole('link', { name: /Movie Hour/ });
    await userEvent.click(screen.getByRole('button', { name: /favourite Movie Hour/i }));

    await waitFor(() => expect(calls).toEqual(['POST /api/v1/creators/movie-hour/favorite']));
  });

  it('offers no favourite control to a signed-out reader', async () => {
    global.fetch = fakeApi({ 'GET /api/v1/creators': results });
    setup(false);

    await userEvent.type(screen.getByLabelText(/find a creator/i), 'movie');
    await screen.findByRole('link', { name: /Movie Club/ });

    // The endpoint would 401, so offering the button would be an invitation to a dead end.
    expect(screen.queryByRole('button', { name: /favourite/i })).not.toBeInTheDocument();
  });
});
