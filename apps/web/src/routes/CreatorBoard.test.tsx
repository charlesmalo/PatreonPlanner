import { render, screen, waitFor } from '@testing-library/react';
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
