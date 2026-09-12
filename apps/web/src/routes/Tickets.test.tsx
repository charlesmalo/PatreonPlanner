import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Tickets } from './Tickets';
import { fakeApi } from '../test-support';

/**
 * The moderator's inbox.
 *
 * This route was 157 statements at **0% coverage** — no test file at all — and passed, because
 * the coverage gate is global and the global was 91%. One e2e journey walks its happy path
 * (pick "Confirm", send a reply); nothing exercised the load failure, the empty state, the
 * resolved rendering, the status filter, or the rule that decides whether picking a different
 * resolution overwrites what a moderator has typed.
 *
 * That last one is the behaviour most worth pinning: it is the only real logic on the page, and
 * it is the kind that stays wrong quietly, because both outcomes look plausible on screen.
 */
const openTicket = {
  id: 'tk1',
  body: 'Season 3 is missing from the board.',
  status: 'OPEN',
  resolution: null,
  reply: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  raisedBy: { id: 'u1', fullName: 'Grace' },
  subject: { id: 'rec-1', customTitle: 'Spirited Away' },
};

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/c/ada-writes/tickets']}>
      <Routes>
        <Route path="/c/:slug/tickets" element={<Tickets />} />
      </Routes>
    </MemoryRouter>,
  );

describe('Tickets', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const withTickets = (items: unknown[], extra: object = {}) => {
    global.fetch = fakeApi({
      'GET /api/v1/creators/ada-writes/tickets': { items },
      ...extra,
    });
  };

  it('lists an open message with who raised it and what it is about', async () => {
    withTickets([openTicket]);
    renderPage();

    expect(await screen.findByText(/season 3 is missing/i)).toBeInTheDocument();
    expect(screen.getByText(/grace/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Spirited Away' })).toHaveAttribute(
      'href',
      '/c/ada-writes/e/rec-1',
    );
  });

  it('says a message came from someone not signed in when nobody is named', async () => {
    // `raisedBy` is nullable: the contact form is open to a signed-out reader on a public board.
    withTickets([{ ...openTicket, raisedBy: null }]);
    renderPage();

    expect(await screen.findByText(/someone not signed in/i)).toBeInTheDocument();
  });

  it('says a message is about the board when it points at no entry', async () => {
    withTickets([{ ...openTicket, subject: null }]);
    renderPage();

    expect(await screen.findByText(/about the board/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Spirited Away' })).not.toBeInTheDocument();
  });

  it('says nothing is here rather than showing an empty list', async () => {
    withTickets([]);
    renderPage();

    expect(await screen.findByText(/nothing here/i)).toBeInTheDocument();
  });

  it('reports a failure to load rather than looking empty', async () => {
    // The distinction the empty state cannot make on its own: no messages, versus no answer.
    global.fetch = fakeApi({
      'GET /api/v1/creators/ada-writes/tickets': new Error('500'),
    });
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not load messages/i);
    expect(screen.queryByText(/nothing here/i)).toBeInTheDocument();
  });

  it('shows a resolved message as its decision and reply, with no controls', async () => {
    withTickets([
      { ...openTicket, status: 'RESOLVED', resolution: 'DENIED', reply: 'Leaving it as is.' },
    ]);
    renderPage();

    expect(await screen.findByText(/DENIED/)).toBeInTheDocument();
    expect(screen.getByText(/leaving it as is/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /send reply/i })).not.toBeInTheDocument();
  });

  it('asks for resolved messages when the filter is switched', async () => {
    const fetch = fakeApi({
      'GET /api/v1/creators/ada-writes/tickets': (url: URL) =>
        url.searchParams.get('status') === 'RESOLVED'
          ? { items: [{ ...openTicket, status: 'RESOLVED', resolution: 'CLOSED', reply: null }] }
          : { items: [openTicket] },
    });
    global.fetch = fetch;
    renderPage();

    expect(await screen.findByRole('button', { name: /send reply/i })).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText(/show/i), 'RESOLVED');

    expect(await screen.findByText(/CLOSED/)).toBeInTheDocument();
  });

  it('swaps the canned reply when a different resolution is picked', async () => {
    withTickets([openTicket]);
    renderPage();

    const reply = await screen.findByLabelText(/reply to this message/i);
    expect(reply).toHaveValue(
      'You were right — thank you for flagging it. We have made the change.',
    );

    await userEvent.click(screen.getByRole('radio', { name: /^deny$/i }));
    expect(reply).toHaveValue(
      'Thank you for writing. We have looked and are leaving this as it is.',
    );
  });

  it('keeps what a moderator wrote when they then pick a different resolution', async () => {
    // The rule the page is built around, and the one a screenshot cannot tell from its opposite.
    withTickets([openTicket]);
    renderPage();

    const reply = await screen.findByLabelText(/reply to this message/i);
    await userEvent.clear(reply);
    await userEvent.type(reply, 'Added it, thank you.');

    await userEvent.click(screen.getByRole('radio', { name: /^close$/i }));
    expect(reply).toHaveValue('Added it, thank you.');
  });

  it('sends the chosen resolution and the reply, then reloads', async () => {
    const fetch = fakeApi({
      'GET /api/v1/creators/ada-writes/tickets': { items: [openTicket] },
      'PATCH /api/v1/creators/ada-writes/tickets/tk1': {},
    });
    global.fetch = fetch;
    renderPage();

    await userEvent.click(await screen.findByRole('radio', { name: /link to existing/i }));
    await userEvent.click(screen.getByRole('button', { name: /send reply/i }));

    await waitFor(() => {
      const patch = fetch.mock.calls.find(([, init]) => init?.method === 'PATCH');
      expect(patch).toBeDefined();
      expect(JSON.parse(String(patch?.[1]?.body))).toEqual({
        resolution: 'LINKED',
        reply: 'Thank you — we have linked this to the existing entry.',
      });
    });
  });

  it('omits the reply entirely when the moderator clears it', async () => {
    // `reply` is optional on the API. Sending `""` and sending nothing are different rows, and
    // an empty quoted reply reads worse to the person who wrote in than no reply at all.
    const fetch = fakeApi({
      'GET /api/v1/creators/ada-writes/tickets': { items: [openTicket] },
      'PATCH /api/v1/creators/ada-writes/tickets/tk1': {},
    });
    global.fetch = fetch;
    renderPage();

    await userEvent.clear(await screen.findByLabelText(/reply to this message/i));
    await userEvent.click(screen.getByRole('button', { name: /send reply/i }));

    await waitFor(() => {
      const patch = fetch.mock.calls.find(([, init]) => init?.method === 'PATCH');
      expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ resolution: 'CONFIRMED' });
    });
  });

  it('reports a send that failed rather than appearing to have worked', async () => {
    global.fetch = fakeApi({
      'GET /api/v1/creators/ada-writes/tickets': { items: [openTicket] },
      'PATCH /api/v1/creators/ada-writes/tickets/tk1': new Error('403'),
    });
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: /send reply/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not send that/i);
  });

  it('offers a way back to the board', async () => {
    withTickets([openTicket]);
    renderPage();

    expect(await screen.findByRole('link', { name: /back to the board/i })).toHaveAttribute(
      'href',
      '/c/ada-writes',
    );
  });
});
