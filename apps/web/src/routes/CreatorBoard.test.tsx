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

describe('CreatorBoard', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('shows a loading state, then the creator and its entries', async () => {
    global.fetch = fakeApi({
      'GET /api/v1/creators/ada-writes/capabilities': viewOnly,
      'GET /api/v1/creators/ada-writes/recommendations': {
        items: [recommendation()],
        nextCursor: null,
      },
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
      'GET /api/v1/creators/ada-writes/recommendations': {
        items: [recommendation({ customTitle: '<img src=x onerror=alert(1)>' })],
        nextCursor: null,
      },
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
      'GET /api/v1/creators/ada-writes/recommendations': {
        items: [recommendation({ links: [{ url: 'https://example.com/x', label: 'Trailer' }] })],
        nextCursor: null,
      },
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
      'GET /api/v1/creators/ada-writes/recommendations': () => {
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
  });

  const moderator = { view: true, upvote: true, submit: true, moderate: true };

  function boardWith(items: unknown[], capabilities: unknown = viewOnly) {
    global.fetch = fakeApi({
      'GET /api/v1/creators/ada-writes': creator,
      'GET /api/v1/creators/ada-writes/capabilities': capabilities,
      'GET /api/v1/creators/ada-writes/recommendations': { items, nextCursor: null },
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

    expect(await screen.findByRole('heading', { name: 'Suggestions' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Accepted' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Now Playing' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Completed' })).toBeInTheDocument();
  });

  it('does not render a heading for an empty column', async () => {
    boardWith([recommendation({ id: 'a', status: 'PENDING' })]);
    renderBoard();
    expect(await screen.findByRole('heading', { name: 'Suggestions' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Now Playing' })).not.toBeInTheDocument();
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
    global.fetch = fakeApi({
      'GET /api/v1/creators/ada-writes': creator,
      'GET /api/v1/creators/ada-writes/capabilities': moderator,
      'GET /api/v1/creators/ada-writes/recommendations': {
        items: [recommendation({ id: 'a', status: 'PENDING' })],
        nextCursor: null,
      },
      'POST /api/v1/creators/ada-writes/recommendations/a/status': { id: 'a', status: 'ACCEPTED' },
    });
    renderBoard();
    await userEvent.click(await screen.findByRole('button', { name: /move “Spirited Away”/i }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Accepted' }));

    expect(await screen.findByRole('heading', { name: 'Accepted' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Suggestions' })).not.toBeInTheDocument();
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
  });

  function boardWith(items: unknown[], themes: unknown[] = []) {
    global.fetch = fakeApi({
      'GET /api/v1/creators/ada-writes': creator,
      'GET /api/v1/creators/ada-writes/capabilities': viewOnly,
      'GET /api/v1/creators/ada-writes/recommendations': { items, nextCursor: null },
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
      'GET /api/v1/creators/ada-writes/recommendations': {
        items: [recommendation()],
        nextCursor: null,
      },
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
      'GET /api/v1/creators/ada-writes/recommendations': () => ({
        items: filtered
          ? [recommendation({ id: 'b', customTitle: 'Only Themed' })]
          : [recommendation({ id: 'a', customTitle: 'Everything' })],
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
  });

  function boardWith(items: unknown[]) {
    global.fetch = fakeApi({
      'GET /api/v1/creators/ada-writes': creator,
      'GET /api/v1/creators/ada-writes/capabilities': viewOnly,
      'GET /api/v1/creators/ada-writes/recommendations': { items, nextCursor: null },
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
});
