import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { BoardSearch } from './BoardSearch';
import { fakeApi, recommendation } from '../test-support';

const SEARCH = 'GET /api/v1/creators/ada-writes/recommendations/similar';

const renderSearch = (props: object = {}) =>
  render(
    <MemoryRouter>
      <BoardSearch
        slug="ada-writes"
        canUpvote={false}
        canModerate={false}
        onChanged={vi.fn()}
        {...props}
      />
    </MemoryRouter>,
  );

describe('BoardSearch', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    vi.useRealTimers();
  });

  it('asks for nothing until the query is long enough', async () => {
    // The server refuses anything shorter with a 400, and this endpoint carries a rate limit of
    // its own — a request per keystroke spends a reader's budget on prefixes.
    const fetch = fakeApi({ [SEARCH]: { items: [] } });
    global.fetch = fetch;
    renderSearch();

    await userEvent.type(screen.getByLabelText(/search this board/i), 'a');

    expect(await screen.findByText(/at least 2 characters/i)).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('finds entries and says how many', async () => {
    global.fetch = fakeApi({
      [SEARCH]: { items: [recommendation({ customTitle: 'Princess Mononoke' })] },
    });
    renderSearch();

    await userEvent.type(screen.getByLabelText(/search this board/i), 'mononoke');

    expect(await screen.findByText('1 result')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Princess Mononoke' })).toBeInTheDocument();
  });

  it('names the column each result is sitting in', async () => {
    // A card looks identical in all four columns, and search crosses all four. Without this a
    // reader cannot tell whether what they found is still waiting or already watched.
    global.fetch = fakeApi({
      [SEARCH]: {
        items: [
          recommendation({ id: 'a', customTitle: 'Still Waiting', status: 'PENDING' }),
          recommendation({ id: 'b', customTitle: 'Already Watched', status: 'COMPLETED' }),
        ],
      },
    });
    renderSearch();

    await userEvent.type(screen.getByLabelText(/search this board/i), 'thing');

    expect(await screen.findByText('Suggestions')).toBeInTheDocument();
    expect(screen.getByText('Completed')).toBeInTheDocument();
  });

  it('says plainly when a board has nothing matching', async () => {
    // An empty area under a filled-in box reads as a broken search rather than an honest answer.
    global.fetch = fakeApi({ [SEARCH]: { items: [] } });
    renderSearch();

    await userEvent.type(screen.getByLabelText(/search this board/i), 'zzzz');

    expect(await screen.findByText(/nothing on this board matches/i)).toBeInTheDocument();
  });

  it('reports a failure rather than looking like an empty board', async () => {
    global.fetch = fakeApi({ [SEARCH]: new Error('500') });
    renderSearch();

    await userEvent.type(screen.getByLabelText(/search this board/i), 'mononoke');

    expect(await screen.findByText(/could not search this board/i)).toBeInTheDocument();
    expect(screen.queryByText(/nothing on this board matches/i)).not.toBeInTheDocument();
  });

  it('tells a rate-limited reader to wait, not to retry', async () => {
    // 429 is the one failure where trying again does work — but only later. Offering "try again"
    // invites the press that gets refused too.
    // `fakeApi` signals a status by *returning* an Error whose message is the code — a thrown
    // one escapes as a raw throw and never becomes an ApiError, so the status is lost.
    global.fetch = fakeApi({ [SEARCH]: new Error('429') });
    renderSearch();

    await userEvent.type(screen.getByLabelText(/search this board/i), 'mononoke');

    expect(await screen.findByText(/wait a moment/i)).toBeInTheDocument();
  });

  it('clears back to the board', async () => {
    global.fetch = fakeApi({
      [SEARCH]: { items: [recommendation({ customTitle: 'Princess Mononoke' })] },
    });
    renderSearch();
    const input = screen.getByLabelText(/search this board/i);
    await userEvent.type(input, 'mononoke');
    expect(await screen.findByText('1 result')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /clear/i }));

    // Not merely hidden: stale results under an empty box read as a board filtered by something
    // invisible.
    await waitFor(() => expect(screen.queryByText('1 result')).not.toBeInTheDocument());
    expect(screen.queryByRole('heading', { name: 'Princess Mononoke' })).not.toBeInTheDocument();
    expect(input).toHaveValue('');
  });

  it('offers no Clear button before anything is typed', async () => {
    renderSearch();

    expect(screen.queryByRole('button', { name: /clear/i })).not.toBeInTheDocument();
  });

  it('announces the outcome to a screen reader', async () => {
    global.fetch = fakeApi({ [SEARCH]: { items: [] } });
    renderSearch();

    await userEvent.type(screen.getByLabelText(/search this board/i), 'zzzz');

    const status = await screen.findByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
  });
});
