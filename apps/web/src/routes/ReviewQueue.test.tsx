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

  // Holding everything, because these cases exercise the controls on the queue and each one
  // requires its own permission. A moderator with only HANDLE_REPORTS can load this page and use
  // none of them — that is its own case below.
  const moderator = {
    view: true,
    upvote: true,
    submit: true,
    moderate: true,
    permissions: ['MOVE_ENTRIES', 'EDIT_ENTRIES', 'WRITE_NOTES', 'HANDLE_REPORTS'],
  };

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

  it('says when the system flagged an entry, and why', async () => {
    // The verdict was recorded and shown to nobody. This queue lists every entry on the board
    // ordered by open reports, so one the system judged sat among entries nobody had ever
    // questioned with nothing to tell them apart.
    global.fetch = fakeApi({
      'GET /api/v1/creators/ada-writes': creator,
      'GET /api/v1/creators/ada-writes/capabilities': moderator,
      'GET /api/v1/creators/ada-writes/review-queue': {
        items: [
          queueItem({
            moderation: {
              verdict: 'FLAG',
              categories: ['HARASSMENT'],
              source: 'WORDLIST',
              createdAt: new Date().toISOString(),
            },
          }),
        ],
        nextOffset: null,
      },
    });
    renderQueue();

    expect(await screen.findByText(/flagged by the word list/i)).toBeInTheDocument();
    expect(screen.getByText(/harassment/i)).toBeInTheDocument();
  });

  it('names the board own blocklist rather than calling it the word list', async () => {
    // Three sources can flag, and which one did is the difference between "the rules we ship"
    // and "a word this creator banned" — the second is the creator's own decision to revisit.
    global.fetch = fakeApi({
      'GET /api/v1/creators/ada-writes': creator,
      'GET /api/v1/creators/ada-writes/capabilities': moderator,
      'GET /api/v1/creators/ada-writes/review-queue': {
        items: [
          queueItem({
            moderation: {
              verdict: 'FLAG',
              categories: ['CREATOR_BLOCKLIST'],
              source: 'CREATOR',
              createdAt: new Date().toISOString(),
            },
          }),
        ],
        nextOffset: null,
      },
    });
    renderQueue();

    expect(await screen.findByText(/flagged by this board's blocklist/i)).toBeInTheDocument();
  });

  it('says nothing at all about an entry the system never judged', async () => {
    // A PASS is deliberately not recorded, so null means never judged — not judged and cleared.
    // Printing "not flagged" on every row would be noise that also happens to be a claim the
    // data cannot support.
    global.fetch = fakeApi({
      'GET /api/v1/creators/ada-writes': creator,
      'GET /api/v1/creators/ada-writes/capabilities': moderator,
      'GET /api/v1/creators/ada-writes/review-queue': {
        items: [queueItem({ moderation: null })],
        nextOffset: null,
      },
    });
    renderQueue();

    await screen.findByText('Spirited Away');
    expect(screen.queryByText(/flagged by/i)).not.toBeInTheDocument();
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

  it('tells somebody who does not moderate the board exactly that', async () => {
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

  it('tells a moderator without the permission that it is the permission', async () => {
    // The same 403, and a different sentence, because the two are different problems: one person
    // needs a staff row and the other already has one. Saying "you do not moderate this board" to
    // a moderator sends them looking for something they already have.
    global.fetch = fakeApi({
      'GET /api/v1/creators/ada-writes': creator,
      'GET /api/v1/creators/ada-writes/capabilities': {
        view: true,
        upvote: false,
        submit: false,
        moderate: true,
        permissions: ['MOVE_ENTRIES'],
      },
      'GET /api/v1/creators/ada-writes/review-queue': new Error('403'),
    });
    renderQueue();
    expect(await screen.findByText(/not one of your permissions/i)).toBeInTheDocument();
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

  it('offers no control a moderator cannot use', async () => {
    // Loading the queue takes HANDLE_REPORTS and nothing more, so this is exactly what an owner
    // narrowing a moderator produces: someone who can read the queue and act on none of it. Every
    // control here was offered anyway, and every one answered 403.
    global.fetch = fakeApi({
      'GET /api/v1/creators/ada-writes': creator,
      'GET /api/v1/creators/ada-writes/capabilities': {
        view: true,
        upvote: false,
        submit: false,
        moderate: true,
        permissions: ['HANDLE_REPORTS'],
      },
      'GET /api/v1/creators/ada-writes/review-queue': {
        items: [queueItem()],
        nextOffset: null,
      },
    });
    renderQueue();

    await screen.findByText('Spirited Away');
    expect(screen.queryByRole('button', { name: /redact/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Move/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /note/i })).not.toBeInTheDocument();
  });
});
