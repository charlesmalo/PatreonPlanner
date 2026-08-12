import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ReviewQueue } from './ReviewQueue';
import { creator, fakeApi } from '../test-support';

function queueItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rec-1',
    customTitle: 'Spirited Away',
    description: 'A classic.',
    status: 'PENDING',
    upvoteCount: 3,
    createdAt: new Date().toISOString(),
    submittedBy: { id: 'user-1', fullName: 'Grace', avatarUrl: null },
    openFlagCount: 0,
    flags: [],
    watchOrderItems: [],
    ...overrides,
  };
}

function renderQueue() {
  return render(
    <MemoryRouter initialEntries={['/c/ada-writes/review']}>
      <Routes>
        <Route path="/c/:slug/review" element={<ReviewQueue />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ReviewQueue', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const moderator = { view: true, upvote: true, submit: true, moderate: true };

  it('shows each entry with its flag reasons and notes', async () => {
    global.fetch = fakeApi({
      'GET /api/v1/creators/ada-writes': creator,
      'GET /api/v1/creators/ada-writes/capabilities': moderator,
      'GET /api/v1/creators/ada-writes/review-queue': {
        items: [
          queueItem({
            openFlagCount: 1,
            flags: [
              {
                id: 'flag-1',
                reason: 'SPAM',
                note: 'link farm',
                createdAt: new Date().toISOString(),
                flaggedBy: { id: 'user-2', fullName: 'Ada' },
              },
            ],
          }),
        ],
        nextOffset: null,
      },
    });
    renderQueue();
    expect(await screen.findByText('Spirited Away')).toBeInTheDocument();
    expect(screen.getByText(/spam or advertising/i)).toBeInTheDocument();
    expect(screen.getByText('link farm')).toBeInTheDocument();
  });

  it('shows a watch order steps so they can be moderated', async () => {
    // The API returns them; a queue that dropped them would review a title and nothing else.
    global.fetch = fakeApi({
      'GET /api/v1/creators/ada-writes': creator,
      'GET /api/v1/creators/ada-writes/capabilities': moderator,
      'GET /api/v1/creators/ada-writes/review-queue': {
        items: [
          queueItem({
            customTitle: 'An order',
            watchOrderItems: [
              { position: 0, customTitle: 'First thing', note: 'start here', title: null },
            ],
          }),
        ],
        nextOffset: null,
      },
    });
    renderQueue();
    expect(await screen.findByText('First thing')).toBeInTheDocument();
    expect(screen.getByText('start here')).toBeInTheDocument();
  });

  it('shows an empty state rather than a blank page', async () => {
    global.fetch = fakeApi({
      'GET /api/v1/creators/ada-writes': creator,
      'GET /api/v1/creators/ada-writes/capabilities': moderator,
      'GET /api/v1/creators/ada-writes/review-queue': { items: [], nextOffset: null },
    });
    renderQueue();
    expect(await screen.findByText(/nothing to review/i)).toBeInTheDocument();
  });

  it('explains a refusal rather than crashing', async () => {
    global.fetch = fakeApi({
      'GET /api/v1/creators/ada-writes': creator,
      'GET /api/v1/creators/ada-writes/capabilities': {
        view: true,
        upvote: false,
        submit: false,
        moderate: false,
      },
      'GET /api/v1/creators/ada-writes/review-queue': new Error('403'),
    });
    renderQueue();
    expect(await screen.findByText(/do not moderate this board/i)).toBeInTheDocument();
  });

  it('dismisses a flag and drops it from the list', async () => {
    global.fetch = fakeApi({
      'GET /api/v1/creators/ada-writes': creator,
      'GET /api/v1/creators/ada-writes/capabilities': moderator,
      'GET /api/v1/creators/ada-writes/review-queue': {
        items: [
          queueItem({
            openFlagCount: 1,
            flags: [
              {
                id: 'flag-1',
                reason: 'SPAM',
                note: null,
                createdAt: new Date().toISOString(),
                flaggedBy: { id: 'user-2', fullName: 'Ada' },
              },
            ],
          }),
        ],
        nextOffset: null,
      },
      'PATCH /api/v1/creators/ada-writes/flags/flag-1': { id: 'flag-1', status: 'DISMISSED' },
    });
    renderQueue();
    await userEvent.click(await screen.findByRole('button', { name: /dismiss/i }));
    expect(await screen.findByText(/no open reports/i)).toBeInTheDocument();
  });

  it('redacts text in place', async () => {
    const fetchMock = fakeApi({
      'GET /api/v1/creators/ada-writes': creator,
      'GET /api/v1/creators/ada-writes/capabilities': moderator,
      'GET /api/v1/creators/ada-writes/review-queue': {
        items: [queueItem()],
        nextOffset: null,
      },
      'PATCH /api/v1/creators/ada-writes/recommendations/rec-1': {
        id: 'rec-1',
        customTitle: 'Spirited Away',
        description: '[removed]',
        status: 'PENDING',
      },
    });
    global.fetch = fetchMock;
    renderQueue();
    await userEvent.click(await screen.findByRole('button', { name: /redact/i }));
    const field = screen.getByLabelText(/description/i);
    await userEvent.clear(field);
    await userEvent.type(field, '[removed]');
    await userEvent.click(screen.getByRole('button', { name: 'Save redaction' }));

    expect(await screen.findByText('[removed]')).toBeInTheDocument();
    expect(screen.queryByText('A classic.')).not.toBeInTheDocument();
  });

  it('renders submitter-controlled text as text, never as markup', async () => {
    global.fetch = fakeApi({
      'GET /api/v1/creators/ada-writes': creator,
      'GET /api/v1/creators/ada-writes/capabilities': moderator,
      'GET /api/v1/creators/ada-writes/review-queue': {
        items: [
          queueItem({
            customTitle: '<img src=x onerror=alert(1)>',
            flags: [
              {
                id: 'flag-1',
                reason: 'OTHER',
                note: '<script>alert(2)</script>',
                createdAt: new Date().toISOString(),
                flaggedBy: { id: 'user-2', fullName: null },
              },
            ],
            openFlagCount: 1,
          }),
        ],
        nextOffset: null,
      },
    });
    const { container } = renderQueue();
    expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(container.querySelector('img[src="x"]')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
  });
});
