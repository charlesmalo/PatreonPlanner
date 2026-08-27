import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
          permissions={[]}
          isPremium={false}
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

  describe('dragging', () => {
    /** jsdom has no real drag, so the transfer is a stub carrying what a card would set. */
    const transfer = (payload?: object) => ({
      getData: () => (payload ? JSON.stringify(payload) : ''),
      setData: vi.fn(),
      dropEffect: '',
      effectAllowed: '',
    });

    function calls() {
      const seen: string[] = [];
      global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input), 'http://localhost').pathname;
        const method = init?.method ?? 'GET';
        if (method === 'GET') {
          return {
            ok: true,
            status: 200,
            json: async () => ({ items: [entry], nextCursor: null }),
          } as Response;
        }
        seen.push(`${method} ${path}`);
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      });
      return seen;
    }

    it('changes status when a card is dropped from another column', async () => {
      const seen = calls();
      setup({ status: 'ACCEPTED', label: 'Accepted', canModerate: true });
      await screen.findByText('Spirited Away');

      fireEvent.drop(screen.getByRole('region', { name: 'Accepted' }), {
        dataTransfer: transfer({ id: 'rec-9', status: 'PENDING' }),
      });

      await waitFor(() =>
        expect(seen).toEqual(['POST /api/v1/creators/ada-writes/recommendations/rec-9/status']),
      );
    });

    it('does nothing when a card is dropped back on its own column', async () => {
      const seen = calls();
      setup({ canModerate: true });
      await screen.findByText('Spirited Away');

      fireEvent.drop(screen.getByRole('region', { name: 'Suggestions' }), {
        dataTransfer: transfer({ id: 'rec-9', status: 'PENDING' }),
      });

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(seen).toEqual([]);
    });

    it('ignores something that is not one of our cards', async () => {
      // A file, a link, a text selection — the board is a drop target for its own cards only.
      const seen = calls();
      setup({ status: 'ACCEPTED', label: 'Accepted', canModerate: true });
      await screen.findByText('Spirited Away');

      fireEvent.drop(screen.getByRole('region', { name: 'Accepted' }), {
        dataTransfer: transfer(),
      });

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(seen).toEqual([]);
    });

    it('does not accept drops from a reader who cannot moderate', async () => {
      const seen = calls();
      setup({ status: 'ACCEPTED', label: 'Accepted', canModerate: false });
      await screen.findByText('Spirited Away');

      fireEvent.drop(screen.getByRole('region', { name: 'Accepted' }), {
        dataTransfer: transfer({ id: 'rec-9', status: 'PENDING' }),
      });

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(seen).toEqual([]);
    });

    it('keeps the chosen sort when the column refetches after a move', async () => {
      // A move refetches by remounting, so a sort held only in component state was silently
      // thrown away by the very action that needed it — a hand-arranged order that vanishes the
      // moment you arrange something.
      const queries = stub();
      const { unmount } = setup({ canModerate: true });
      await screen.findByText('Spirited Away');
      await userEvent.selectOptions(screen.getByLabelText(/sort suggestions/i), 'manual');
      await waitFor(() => expect(queries.at(-1)).toMatch(/sort=manual/));
      unmount();

      stub();
      setup({ canModerate: true });

      expect(await screen.findByLabelText(/sort suggestions/i)).toHaveValue('manual');
    });

    it('offers a hand-arranged order only as one sort among several', async () => {
      stub();
      setup({ canModerate: true });
      await screen.findByText('Spirited Away');

      expect(screen.getByRole('option', { name: /in the order you arrange/i })).toBeInTheDocument();
      // Not the default: the board is a demand signal first.
      expect(screen.getByLabelText(/sort suggestions/i)).toHaveValue('');
    });
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
