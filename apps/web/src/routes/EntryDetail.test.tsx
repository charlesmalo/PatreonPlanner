import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { EntryDetail } from './EntryDetail';
import { fakeApi, recommendation } from '../test-support';

const entry = recommendation({
  id: 'rec-1',
  customTitle: 'Cowboy Bebop',
  description: 'Bounty hunters, jazz, and regret.',
  status: 'ACCEPTED',
});

function renderAt(path = '/c/ada-writes/e/rec-1') {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/c/:slug/e/:id" element={<EntryDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('EntryDetail', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const routes = (overrides: Record<string, unknown> = {}) => ({
    'GET /api/v1/creators/ada-writes': {
      id: 'c1',
      slug: 'ada-writes',
      displayName: 'Ada Writes',
      baseUrl: null,
      tiers: [],
    },
    'GET /api/v1/creators/ada-writes/capabilities': {
      view: true,
      upvote: true,
      submit: true,
      moderate: false,
      administer: false,
    },
    'GET /api/v1/creators/ada-writes/recommendations/rec-1': entry,
    ...overrides,
  });

  it('shows the entry with the detail a card leaves out', async () => {
    global.fetch = fakeApi(routes());
    renderAt();

    expect(await screen.findByRole('heading', { name: 'Cowboy Bebop' })).toBeInTheDocument();
    expect(screen.getByText(/bounty hunters, jazz/i)).toBeInTheDocument();
  });

  it('offers a way back to the board it came from', async () => {
    global.fetch = fakeApi(routes());
    renderAt();

    expect(await screen.findByRole('link', { name: /Ada Writes/ })).toHaveAttribute(
      'href',
      '/c/ada-writes',
    );
  });

  it('says plainly when the entry is not there', async () => {
    // A shareable URL will be shared after the entry is gone, or with someone who cannot see it.
    global.fetch = fakeApi(
      routes({
        'GET /api/v1/creators/ada-writes/recommendations/rec-1': new Error('404'),
      }),
    );
    renderAt();

    expect(await screen.findByText(/not found/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to/i })).toBeInTheDocument();
  });

  it('shows the count to a reader who may not upvote, disabled rather than hidden', async () => {
    global.fetch = fakeApi(
      routes({
        'GET /api/v1/creators/ada-writes/capabilities': {
          view: true,
          upvote: false,
          submit: false,
          moderate: false,
          administer: false,
        },
      }),
    );
    renderAt();

    await screen.findByRole('heading', { name: 'Cowboy Bebop' });
    // Disabled, not absent: the board does the same, so the count is still readable and the
    // control says why it cannot be used rather than vanishing without explanation.
    await waitFor(() => expect(screen.getByRole('button', { name: /upvote/i })).toBeDisabled());
  });
});
