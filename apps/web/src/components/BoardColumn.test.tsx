import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { BoardColumn } from './BoardColumn';
import { recommendation } from '../test-support';

const entry = recommendation({ id: 'rec-1', customTitle: 'Spirited Away', status: 'PENDING' });

describe('BoardColumn', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    window.localStorage.clear();
  });

  function stub(items = [entry], nextCursor: string | null = null) {
    const queries: string[] = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      queries.push(url.search);
      return {
        ok: true,
        status: 200,
        json: async () => ({ items, nextCursor }),
      } as Response;
    });
    return queries;
  }

  const setup = (props: Partial<Parameters<typeof BoardColumn>[0]> = {}) =>
    render(
      <MemoryRouter>
        <BoardColumn
          slug="ada-writes"
          status="PENDING"
          label="Suggestions"
          theme={null}
          canUpvote={false}
          canModerate={false}
          onMoved={vi.fn()}
          {...props}
        />
      </MemoryRouter>,
    );

  it('asks only for its own column', async () => {
    const queries = stub();
    setup();

    await screen.findByText('Spirited Away');
    expect(queries[0]).toMatch(/status=PENDING/);
  });

  it('shows how many it is holding', async () => {
    stub();
    setup();

    // Waits for the entries, not the heading: the heading renders immediately and the count is
    // zero until the fetch lands, so asserting on it first is a race — one that passed locally
    // and failed in CI.
    await screen.findByText('Spirited Away');
    expect(screen.getByRole('heading', { name: 'Suggestions' })).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  it('says when it is empty rather than showing a bare heading', async () => {
    stub([]);
    setup();

    expect(await screen.findByText(/nothing here yet/i)).toBeInTheDocument();
  });

  it('collapses to its header, and back again', async () => {
    stub();
    setup();
    await screen.findByText('Spirited Away');

    await userEvent.click(screen.getByRole('button', { name: /collapse suggestions/i }));
    expect(screen.queryByText('Spirited Away')).not.toBeInTheDocument();
    // The count survives, so a collapsed column still says whether anything is in it.
    expect(screen.getByText('1')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /expand suggestions/i }));
    expect(screen.getByText('Spirited Away')).toBeInTheDocument();
  });

  it('remembers what the reader collapsed', async () => {
    stub();
    const { unmount } = setup();
    await screen.findByText('Spirited Away');
    await userEvent.click(screen.getByRole('button', { name: /collapse/i }));
    unmount();

    stub();
    setup();

    // Per reader and local: which columns are folded away is not board configuration.
    expect(await screen.findByRole('button', { name: /expand suggestions/i })).toBeInTheDocument();
    expect(screen.queryByText('Spirited Away')).not.toBeInTheDocument();
  });

  it('sorts by upvotes without being asked', async () => {
    const queries = stub();
    setup();

    await screen.findByText('Spirited Away');
    // The board is a demand signal, so its default order is the demand.
    expect(queries[0]).not.toMatch(/sort=/);
  });

  it('re-asks the server when the reader changes the sort', async () => {
    // Sorting a page already fetched would sort one page of a list that has more behind it.
    const queries = stub();
    setup();
    await screen.findByText('Spirited Away');

    await userEvent.selectOptions(screen.getByLabelText(/sort suggestions/i), 'newest');

    await waitFor(() => expect(queries.at(-1)).toMatch(/sort=newest/));
    expect(queries.at(-1)).toMatch(/status=PENDING/);
  });

  it('marks an entry the creator picked', async () => {
    stub([{ ...entry, isCreatorPick: true }]);
    setup();

    expect(await screen.findByText(/creator pick/i)).toBeInTheDocument();
  });

  it('loads the next page into the same column', async () => {
    const queries = stub([entry], 'cursor-2');
    setup();
    await screen.findByText('Spirited Away');

    await userEvent.click(screen.getByRole('button', { name: /load more/i }));

    await waitFor(() => expect(queries.at(-1)).toMatch(/cursor=cursor-2/));
    // Still its own column, so paging cannot drag in another status.
    expect(queries.at(-1)).toMatch(/status=PENDING/);
  });
});
