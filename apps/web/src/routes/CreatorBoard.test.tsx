import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { CreatorBoard } from './CreatorBoard';
import { allCapabilities, creator, fakeApi, recommendation, viewOnly } from '../test-support';

function renderBoard() {
  return render(
    <MemoryRouter initialEntries={['/c/ada-writes']}>
      <Routes>
        <Route path="/c/:slug" element={<CreatorBoard />} />
      </Routes>
    </MemoryRouter>,
  );
}

/**
 * The board asks for one column at a time, so a fake that ignores the status query hands every
 * column every entry — which is not what the server does and not what the page renders.
 */
function byColumn<T extends { status?: string }>(url: URL, items: T[]): T[] {
  const status = url.searchParams.get('status');
  return status ? items.filter((item) => (item.status ?? 'PENDING') === status) : items;
}

describe('CreatorBoard', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    window.localStorage.clear();
  });

  it('shows a loading state, then the creator and its entries', async () => {
    global.fetch = fakeApi({
      'GET /api/v1/creators/ada-writes/capabilities': viewOnly,
      'GET /api/v1/creators/ada-writes/recommendations': (url: URL) => ({
        items: byColumn(url, [recommendation()]),
        nextCursor: null,
      }),
      'GET /api/v1/creators/ada-writes': creator,
    });
    renderBoard();
    expect(screen.getByRole('status')).toHaveTextContent(/loading/i);

    expect(await screen.findByRole('heading', { name: 'Ada Writes' })).toBeInTheDocument();
    expect(await screen.findByText('Spirited Away')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /3 upvotes/i })).toBeInTheDocument();
  });

  it('shows an empty state when there is nothing yet', async () => {
    global.fetch = fakeApi({
      'GET /api/v1/creators/ada-writes/capabilities': viewOnly,
      'GET /api/v1/creators/ada-writes/recommendations': { items: [], nextCursor: null },
      'GET /api/v1/creators/ada-writes': creator,
    });
    renderBoard();
    expect(await screen.findByText(/nothing suggested yet/i)).toBeInTheDocument();
  });

  it.each([
    [404, /no creator with that address/i],
    [401, /sign in to see this board/i],
    [403, /for the creator’s patrons/i],
  ])('explains a %i rather than rendering blank', async (status, expected) => {
    global.fetch = fakeApi({ 'GET /api/v1/creators/ada-writes': new Error(String(status)) });
    renderBoard();
    expect(await screen.findByText(expected)).toBeInTheDocument();
  });

  it('renders a title containing markup as text, never as HTML', async () => {
    global.fetch = fakeApi({
      'GET /api/v1/creators/ada-writes/capabilities': viewOnly,
      'GET /api/v1/creators/ada-writes/recommendations': (url: URL) => ({
        items: byColumn(url, [recommendation({ customTitle: '<img src=x onerror=alert(1)>' })]),
        nextCursor: null,
      }),
      'GET /api/v1/creators/ada-writes': creator,
    });
    const { container } = renderBoard();
    expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    // The whole point: submitter-controlled text must never become an element.
    expect(container.querySelector('img')).toBeNull();
  });

  it('opens external links safely', async () => {
    global.fetch = fakeApi({
      'GET /api/v1/creators/ada-writes/capabilities': viewOnly,
      'GET /api/v1/creators/ada-writes/recommendations': (url: URL) => ({
        items: byColumn(url, [
          recommendation({
            links: [
              { id: 'link-1', url: 'https://example.com/x', label: 'Trailer', isPreferred: false },
            ],
          }),
        ]),
        nextCursor: null,
      }),
      'GET /api/v1/creators/ada-writes': creator,
    });
    renderBoard();
    const link = await screen.findByRole('link', { name: 'Trailer' });
    // The URL is attacker-chosen, so the opened page must not get a handle on this one.
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('appends the next page and stops offering more', async () => {
    let call = 0;
    global.fetch = fakeApi({
      'GET /api/v1/creators/ada-writes/capabilities': viewOnly,
      'GET /api/v1/creators/ada-writes/recommendations': (url: URL) => {
        // Only the Suggestions column pages here; the others answer empty, so "Load more" belongs
        // to one column rather than to the board.
        if (url.searchParams.get('status') !== 'PENDING') return { items: [], nextCursor: null };
        call += 1;
        return call === 1
          ? { items: [recommendation({ id: 'a', customTitle: 'First' })], nextCursor: 'cur' }
          : { items: [recommendation({ id: 'b', customTitle: 'Second' })], nextCursor: null };
      },
      'GET /api/v1/creators/ada-writes': creator,
    });
    renderBoard();
    await screen.findByText('First');
    await userEvent.click(screen.getByRole('button', { name: /load more/i }));

    expect(await screen.findByText('Second')).toBeInTheDocument();
    expect(screen.getByText('First')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument(),
    );
  });

  it('hides the submit form when the viewer cannot submit', async () => {
    global.fetch = fakeApi({
      'GET /api/v1/creators/ada-writes/capabilities': viewOnly,
      'GET /api/v1/creators/ada-writes/recommendations': { items: [], nextCursor: null },
      'GET /api/v1/creators/ada-writes': creator,
    });
    renderBoard();
    await screen.findByRole('heading', { name: 'Ada Writes' });
    expect(screen.queryByRole('heading', { name: /suggest something/i })).not.toBeInTheDocument();
  });

  it('shows the submit form when the viewer can submit', async () => {
    global.fetch = fakeApi({
      'GET /api/v1/creators/ada-writes/capabilities': allCapabilities,
      'GET /api/v1/creators/ada-writes/recommendations': { items: [], nextCursor: null },
      'GET /api/v1/creators/ada-writes': creator,
    });
    renderBoard();
    expect(await screen.findByRole('heading', { name: /suggest something/i })).toBeInTheDocument();
  });
});

describe('CreatorBoard columns', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    window.localStorage.clear();
  });

  const moderator = { view: true, upvote: true, submit: true, moderate: true };

  function boardWith(items: Array<{ status?: string }>, capabilities: unknown = viewOnly) {
    global.fetch = fakeApi({
      'GET /api/v1/creators/ada-writes': creator,
      'GET /api/v1/creators/ada-writes/capabilities': capabilities,
      'GET /api/v1/creators/ada-writes/recommendations': (url: URL) => ({
        items: byColumn(url, items),
        nextCursor: null,
      }),
    });
  }

  it('groups entries under the lifecycle columns', async () => {
    boardWith([
      recommendation({ id: 'a', customTitle: 'Pending One', status: 'PENDING' }),
      recommendation({ id: 'b', customTitle: 'Accepted One', status: 'ACCEPTED' }),
      recommendation({ id: 'c', customTitle: 'Playing One', status: 'ACTIVE' }),
      recommendation({ id: 'd', customTitle: 'Done One', status: 'COMPLETED' }),
    ]);
    renderBoard();

    // Each entry sits under its own status. The columns are tabbed now, so three of the four are
    // off-screen — mounted, which is what lets a card be dropped into one that is not showing.
    expect(await screen.findByRole('heading', { name: 'Suggestions' })).toBeInTheDocument();
    for (const [label, title] of [
      ['Accepted', 'Accepted One'],
      ['Now Playing', 'Playing One'],
      ['Completed', 'Done One'],
    ]) {
      const column = screen.getByRole('region', {
        name: new RegExp(`^${label}`, 'i'),
        hidden: true,
      });
      expect(within(column).getByText(title)).toBeInTheDocument();
    }
  });

  it('shows the weight alongside the headcount when they differ', async () => {
    // Two different questions: how much support, and from how many people. A creator deciding
    // what to watch next wants both, and 'twenty points' hides whether that is four patrons or
    // one.
    boardWith([recommendation({ id: 'a', status: 'PENDING', upvoteCount: 2, weightedScore: 20 })]);
    renderBoard();

    expect(await screen.findByText(/20 points from 2 patrons/i)).toBeInTheDocument();
  });

  it('shows one number when the board does not weight its tiers', async () => {
    boardWith([recommendation({ id: 'a', status: 'PENDING', upvoteCount: 2, weightedScore: 2 })]);
    renderBoard();

    await screen.findByText('Spirited Away');
    expect(screen.queryByText(/points from/i)).not.toBeInTheDocument();
  });

  it('hides moderator controls when the reader looks as a patron', async () => {
    boardWith([recommendation({ id: 'a', status: 'PENDING' })], moderator);
    renderBoard();
    await screen.findByRole('button', { name: /move “Spirited Away”/i });

    await userEvent.selectOptions(screen.getByLabelText(/viewing as/i), 'patron');

    expect(screen.queryByRole('button', { name: /move “Spirited Away”/i })).not.toBeInTheDocument();
    // Named, since a column's loading state is also a status.
    expect(screen.getByText(/viewing as a/i)).toBeInTheDocument();
  });

  it('offers the switch only to someone with moderator powers', async () => {
    boardWith([recommendation({ id: 'a', status: 'PENDING' })]);
    renderBoard();
    await screen.findByText('Spirited Away');

    expect(screen.queryByLabelText(/viewing as/i)).not.toBeInTheDocument();
  });

  it('keeps offering the switch itself while in patron view', async () => {
    // Otherwise the way back is gone, and the reader is stuck until they clear storage.
    boardWith([recommendation({ id: 'a', status: 'PENDING' })], moderator);
    renderBoard();
    await screen.findByLabelText(/viewing as/i);

    await userEvent.selectOptions(screen.getByLabelText(/viewing as/i), 'patron');

    expect(screen.getByLabelText(/viewing as/i)).toBeInTheDocument();
  });

  it('keeps every column, including the empty ones', async () => {
    // The guarantee outlived the layout. Columns are tabbed now rather than side by side, but a
    // column that vanishes when it empties still takes the board's shape with it and leaves
    // nowhere to move a card to. Every one exists as a tab, and every panel stays mounted —
    // off-screen, not absent.
    boardWith([recommendation({ id: 'a', status: 'PENDING' })]);
    renderBoard();

    expect(await screen.findByRole('tab', { name: 'Suggestions' })).toBeInTheDocument();
    for (const label of ['Accepted', 'Now Playing', 'Completed']) {
      expect(screen.getByRole('tab', { name: label })).toBeInTheDocument();
    }
    const empty = screen.getByRole('region', { name: /now playing/i, hidden: true });
    expect(within(empty).getByText(/nothing here yet/i)).toBeInTheDocument();
  });

  it('offers moderator controls only when the viewer moderates', async () => {
    boardWith([recommendation({ id: 'a', status: 'PENDING' })], moderator);
    renderBoard();
    expect(
      await screen.findByRole('button', { name: /move “Spirited Away”/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /review queue/i })).toBeInTheDocument();
  });

  it('hides moderator controls from a patron', async () => {
    boardWith([recommendation({ id: 'a', status: 'PENDING' })], allCapabilities);
    renderBoard();
    await screen.findByText('Spirited Away');
    expect(screen.queryByRole('button', { name: /move “/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /review queue/i })).not.toBeInTheDocument();
  });

  it('moves a card to its new column when a moderator changes the status', async () => {
    let status = 'PENDING';
    global.fetch = fakeApi({
      'GET /api/v1/creators/ada-writes': creator,
      'GET /api/v1/creators/ada-writes/capabilities': moderator,
      'GET /api/v1/creators/ada-writes/recommendations': (url: URL) => ({
        items: byColumn(url, [recommendation({ id: 'a', status })]),
        nextCursor: null,
      }),
      'POST /api/v1/creators/ada-writes/recommendations/a/status': () => {
        // The fake has to move the entry too, or the columns refetch and find it where it was.
        status = 'ACCEPTED';
        return { id: 'a', status };
      },
    });
    renderBoard();
    await userEvent.click(await screen.findByRole('button', { name: /move “Spirited Away”/i }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Accepted' }));

    // The card leaves the column it was in and turns up in the one it moved to. Both columns
    // stay on screen — a kanban keeps its shape whether or not a column is holding anything.
    const suggestions = screen.getByRole('region', { name: /suggestions/i });
    const accepted = screen.getByRole('region', { name: /^accepted/i, hidden: true });
    await waitFor(() => expect(within(accepted).getByText('Spirited Away')).toBeInTheDocument());
    expect(within(suggestions).queryByText('Spirited Away')).not.toBeInTheDocument();
  });

  // Shown to everyone rather than gated on a session the board does not fetch: FlagButton
  // answers a 401 with "sign in to report", which is more useful than a missing control.
  it('offers a report control on every card', async () => {
    boardWith([recommendation({ id: 'a', status: 'PENDING' })], allCapabilities);
    renderBoard();
    expect(
      await screen.findByRole('button', { name: /report “Spirited Away”/i }),
    ).toBeInTheDocument();
  });
});

describe('CreatorBoard nesting and themes', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    window.localStorage.clear();
  });

  function boardWith(items: Array<{ status?: string }>, themes: unknown[] = []) {
    global.fetch = fakeApi({
      'GET /api/v1/creators/ada-writes': creator,
      'GET /api/v1/creators/ada-writes/capabilities': viewOnly,
      'GET /api/v1/creators/ada-writes/recommendations': (url: URL) => ({
        items: byColumn(url, items),
        nextCursor: null,
      }),
      'GET /api/v1/creators/ada-writes/themes': { items: themes },
    });
  }

  it('renders a child inside its parent as a nested list', async () => {
    // Nested markup, not a margin: the containment has to be there for a screen reader too.
    boardWith([
      recommendation({ id: 'p', customTitle: 'A Show', status: 'PENDING' }),
      recommendation({ id: 'c', customTitle: 'Season 2', status: 'PENDING', parentId: 'p' }),
    ]);
    renderBoard();

    const parent = (await screen.findByText('A Show')).closest('li') as HTMLElement;
    expect(within(parent).getByText('Season 2')).toBeInTheDocument();
  });

  it('renders a child at top level when its parent is absent from the page', async () => {
    boardWith([
      recommendation({ id: 'c', customTitle: 'Season 2', status: 'PENDING', parentId: 'missing' }),
    ]);
    renderBoard();
    const child = (await screen.findByText('Season 2')).closest('li') as HTMLElement;
    expect(child.parentElement?.closest('li')).toBeNull();
  });

  it('renders a child under a parent in a different column at top level', async () => {
    // Columns are the lifecycle; nesting a pending entry inside an accepted one would move it
    // out of the column its status says it belongs to.
    boardWith([
      recommendation({ id: 'p', customTitle: 'A Show', status: 'ACCEPTED' }),
      recommendation({ id: 'c', customTitle: 'Season 2', status: 'PENDING', parentId: 'p' }),
    ]);
    renderBoard();
    const child = (await screen.findByText('Season 2')).closest('li') as HTMLElement;
    expect(child.parentElement?.closest('li')).toBeNull();
  });

  it('shows each entry themes as chips', async () => {
    boardWith([recommendation({ id: 'a', themes: [{ id: 't1', name: 'Anime' }] })]);
    renderBoard();
    expect(await screen.findByText('Anime')).toBeInTheDocument();
  });

  it('filters the board by a theme', async () => {
    const fetchMock = fakeApi({
      'GET /api/v1/creators/ada-writes': creator,
      'GET /api/v1/creators/ada-writes/capabilities': viewOnly,
      'GET /api/v1/creators/ada-writes/recommendations': (url: URL) => ({
        items: byColumn(url, [recommendation()]),
        nextCursor: null,
      }),
      'GET /api/v1/creators/ada-writes/themes': {
        items: [{ id: 't1', name: 'Anime', entryCount: 1 }],
      },
    });
    global.fetch = fetchMock;
    renderBoard();

    await userEvent.click(await screen.findByRole('button', { name: /Anime \(1\)/ }));
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map(([input]) => String(input));
      expect(urls.some((u) => u.includes('theme=t1'))).toBe(true);
    });
  });

  it('renders the filtered response rather than the unfiltered one', async () => {
    // Asserting only that the URL carried `theme=` would pass even if the response were ignored:
    // the fake routes by pathname, so both requests return the same body.
    let filtered = false;
    global.fetch = fakeApi({
      'GET /api/v1/creators/ada-writes': creator,
      'GET /api/v1/creators/ada-writes/capabilities': viewOnly,
      'GET /api/v1/creators/ada-writes/recommendations': (url: URL) => ({
        items: byColumn(
          url,
          filtered
            ? [recommendation({ id: 'b', customTitle: 'Only Themed' })]
            : [recommendation({ id: 'a', customTitle: 'Everything' })],
        ),
        nextCursor: null,
      }),
      'GET /api/v1/creators/ada-writes/themes': {
        items: [{ id: 't1', name: 'Anime', entryCount: 1 }],
      },
    });
    renderBoard();

    expect(await screen.findByText('Everything')).toBeInTheDocument();
    filtered = true;
    await userEvent.click(screen.getByRole('button', { name: /Anime \(1\)/ }));

    expect(await screen.findByText('Only Themed')).toBeInTheDocument();
    expect(screen.queryByText('Everything')).not.toBeInTheDocument();
  });
});

describe('CreatorBoard nesting resilience', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    window.localStorage.clear();
  });

  function boardWith(items: Array<{ status?: string }>) {
    global.fetch = fakeApi({
      'GET /api/v1/creators/ada-writes': creator,
      'GET /api/v1/creators/ada-writes/capabilities': viewOnly,
      'GET /api/v1/creators/ada-writes/recommendations': (url: URL) => ({
        items: byColumn(url, items),
        nextCursor: null,
      }),
      'GET /api/v1/creators/ada-writes/themes': { items: [] },
    });
  }

  it('renders a grandchild rather than dropping it', async () => {
    // Only roots and their direct children were rendered, so anything deeper vanished from the
    // board entirely — a far worse failure than rendering it flat.
    boardWith([
      recommendation({ id: 'a', customTitle: 'Franchise' }),
      recommendation({ id: 'b', customTitle: 'Show', parentId: 'a' }),
      recommendation({ id: 'c', customTitle: 'Season 2', parentId: 'b' }),
    ]);
    renderBoard();
    expect(await screen.findByText('Franchise')).toBeInTheDocument();
    expect(screen.getByText('Show')).toBeInTheDocument();
    expect(screen.getByText('Season 2')).toBeInTheDocument();
  });

  it('renders every entry even if the relations form a cycle', async () => {
    // A cycle left no roots, so the column was filtered away and the board read as empty.
    boardWith([
      recommendation({ id: 'a', customTitle: 'One', parentId: 'b' }),
      recommendation({ id: 'b', customTitle: 'Two', parentId: 'a' }),
    ]);
    renderBoard();
    expect(await screen.findByText('One')).toBeInTheDocument();
    expect(screen.getByText('Two')).toBeInTheDocument();
  });
});

describe('CreatorBoard admin link', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    window.localStorage.clear();
  });

  function boardWith(capabilities: unknown) {
    global.fetch = fakeApi({
      'GET /api/v1/creators/ada-writes': creator,
      'GET /api/v1/creators/ada-writes/capabilities': capabilities,
      'GET /api/v1/creators/ada-writes/recommendations': { items: [], nextCursor: null },
      'GET /api/v1/creators/ada-writes/themes': { items: [] },
    });
  }

  it('offers the moderators page to an owner', async () => {
    boardWith({ ...viewOnly, moderate: true, administer: true });
    renderBoard();
    expect(await screen.findByRole('link', { name: 'Moderators' })).toHaveAttribute(
      'href',
      '/c/ada-writes/staff',
    );
  });

  it('hides it from a moderator', async () => {
    // Staff management is owner-only; a link that 403s is a lie. Nothing covered this, so
    // swapping the gate to `moderate` — or deleting it — left the suite green.
    boardWith({ ...viewOnly, moderate: true, administer: false });
    renderBoard();
    await screen.findByRole('link', { name: /review queue/i });
    expect(screen.queryByRole('link', { name: 'Moderators' })).not.toBeInTheDocument();
  });

  it('hides it from a patron', async () => {
    boardWith(viewOnly);
    renderBoard();
    await screen.findByRole('heading', { name: 'Ada Writes' });
    expect(screen.queryByRole('link', { name: 'Moderators' })).not.toBeInTheDocument();
  });

  describe('the contact form', () => {
    /**
     * A write control offered to somebody who cannot write.
     *
     * The board drew this behind `view`, which is true for any anonymous reader of a public
     * board. The server refused them — correctly, and only after they had written the message.
     * Offering a form that cannot be submitted is worse than not offering one.
     */
    it('is absent for a reader who may not open a ticket', async () => {
      global.fetch = fakeApi({
        'GET /api/v1/creators/ada-writes': creator,
        'GET /api/v1/creators/ada-writes/capabilities': viewOnly,
        'GET /api/v1/creators/ada-writes/recommendations': { items: [], nextCursor: null },
      });
      renderBoard();

      // Waits for the board to settle first, so this cannot pass merely by being early.
      await screen.findByRole('heading', { name: /ada writes/i });
      expect(screen.queryByLabelText(/message the moderators/i)).not.toBeInTheDocument();
    });

    it('is offered to a reader who may', async () => {
      global.fetch = fakeApi({
        'GET /api/v1/creators/ada-writes': creator,
        'GET /api/v1/creators/ada-writes/capabilities': { ...viewOnly, contact: true },
        'GET /api/v1/creators/ada-writes/recommendations': { items: [], nextCursor: null },
      });
      renderBoard();

      expect(await screen.findByLabelText(/message the moderators/i)).toBeInTheDocument();
    });
  });
});
