import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { TicketDetail } from './TicketDetail';
import { allCapabilities, creator, fakeApi } from '../test-support';
import type { Capabilities, Ticket } from '../api/types';

/**
 * One message, which is where a ticket notification now lands.
 *
 * Two readers arrive here and they are not the same reader: staff who would answer it, and the
 * person who wrote it — who holds no moderator permission and whom the inbox refuses outright.
 * Until this page existed, every TICKET_RESOLVED notification sent its reader to that refusal.
 */
const openTicket: Ticket = {
  id: 'tk1',
  body: 'Season 3 is missing from the board.',
  status: 'OPEN',
  resolution: null,
  reply: null,
  subjectId: 'rec-1',
  createdAt: '2026-09-01T00:00:00.000Z',
  resolvedAt: null,
  raisedBy: { id: 'u1', fullName: 'Grace', avatarUrl: null },
  subject: { id: 'rec-1', customTitle: 'Spirited Away', status: 'PENDING' },
};

const resolvedTicket: Ticket = {
  ...openTicket,
  status: 'RESOLVED',
  resolution: 'CONFIRMED',
  reply: 'Added it, thank you.',
  resolvedAt: '2026-09-02T00:00:00.000Z',
};

const handler: Capabilities = {
  ...allCapabilities,
  moderate: true,
  permissions: ['HANDLE_REPORTS'],
};

/** Staff, but not of this inbox: the same reader the board hides the Messages link from. */
const staffWithoutReports: Capabilities = {
  ...allCapabilities,
  moderate: true,
  permissions: ['WRITE_NOTES'],
};

const stub = (
  capabilities: Capabilities,
  ticket: Ticket | Error | ((url: URL) => unknown),
  extra: object = {},
) =>
  fakeApi({
    'GET /api/v1/creators/ada-writes': creator,
    'GET /api/v1/creators/ada-writes/capabilities': capabilities,
    'GET /api/v1/creators/ada-writes/tickets/tk1': ticket,
    ...extra,
  });

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/c/ada-writes/tickets/tk1']}>
      <Routes>
        <Route path="/c/:slug/tickets/:id" element={<TicketDetail />} />
      </Routes>
    </MemoryRouter>,
  );

describe('TicketDetail', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('shows the one message the notification named', async () => {
    global.fetch = stub(handler, openTicket);
    renderPage();

    expect(await screen.findByText(/season 3 is missing/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Spirited Away' })).toHaveAttribute(
      'href',
      '/c/ada-writes/e/rec-1',
    );
  });

  it('offers the answer controls to a moderator who may answer', async () => {
    global.fetch = stub(handler, openTicket);
    renderPage();

    expect(await screen.findByRole('button', { name: /send reply/i })).toBeInTheDocument();
  });

  it('shows the reader who wrote it what the moderators answered', async () => {
    // The audience of a TICKET_RESOLVED notification: an ordinary reader of the board, and the
    // reply is the reason they opened it.
    global.fetch = stub(allCapabilities, resolvedTicket);
    renderPage();

    expect(await screen.findByText(/added it, thank you/i)).toBeInTheDocument();
    expect(screen.getByText(/CONFIRMED/)).toBeInTheDocument();
  });

  it('withholds the controls from the reader who wrote it, and says nothing is decided yet', async () => {
    // An **open** ticket on purpose. Asserting "no controls" against a resolved one proves
    // nothing: a resolved message shows its answer instead of a form for everybody, so that
    // version of this test passed with the permission check deleted.
    global.fetch = stub(allCapabilities, openTicket);
    renderPage();

    expect(await screen.findByText(/no answer yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /send reply/i })).not.toBeInTheDocument();
  });

  it('offers no second answer on a message already resolved', async () => {
    // A different rule from the one above, with a different reason to exist: the status closes
    // the form, for staff who would otherwise overwrite an answer already sent.
    global.fetch = stub(handler, resolvedTicket);
    renderPage();

    expect(await screen.findByText(/added it, thank you/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /send reply/i })).not.toBeInTheDocument();
  });

  it('withholds the controls from staff who lack the inbox permission', async () => {
    // MODERATE is not the gate; HANDLE_REPORTS is. Drawing the form for them would offer a
    // reply the server refuses, after it had been written.
    global.fetch = stub(staffWithoutReports, openTicket);
    renderPage();

    await screen.findByText(/season 3 is missing/i);
    expect(screen.queryByRole('button', { name: /send reply/i })).not.toBeInTheDocument();
  });

  it('says not found rather than looking empty when the reader may not see it', async () => {
    // The API answers 404 for a message that is gone and for one that was never theirs, so this
    // page says the same thing for both.
    global.fetch = stub(handler, new Error('404'));
    renderPage();

    expect(await screen.findByRole('heading', { name: /not found/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to ada writes/i })).toHaveAttribute(
      'href',
      '/c/ada-writes',
    );
  });

  it('sends the chosen answer and re-reads the message', async () => {
    let sent = false;
    const fetch = stub(handler, () => (sent ? resolvedTicket : openTicket), {
      'PATCH /api/v1/creators/ada-writes/tickets/tk1': () => {
        sent = true;
        return {};
      },
    });
    global.fetch = fetch;
    renderPage();

    await userEvent.click(await screen.findByRole('radio', { name: /link to existing/i }));
    await userEvent.click(screen.getByRole('button', { name: /send reply/i }));

    await waitFor(() => {
      const patch = fetch.mock.calls.find(([, init]) => init?.method === 'PATCH');
      expect(JSON.parse(String(patch?.[1]?.body))).toEqual({
        resolution: 'LINKED',
        reply: 'Thank you — we have linked this to the existing entry.',
      });
    });
    // Re-read rather than patched in place: the stored row is what the reader is shown.
    expect(await screen.findByText(/added it, thank you/i)).toBeInTheDocument();
  });

  it('reports a send that failed rather than appearing to have worked', async () => {
    global.fetch = stub(handler, openTicket, {
      'PATCH /api/v1/creators/ada-writes/tickets/tk1': new Error('403'),
    });
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: /send reply/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not send that/i);
  });

  it('offers a moderator the rest of the inbox', async () => {
    global.fetch = stub(handler, openTicket);
    renderPage();

    expect(await screen.findByRole('link', { name: /all messages/i })).toHaveAttribute(
      'href',
      '/c/ada-writes/tickets',
    );
  });

  it('does not offer the reader who wrote it an inbox they would be refused', async () => {
    global.fetch = stub(allCapabilities, openTicket);
    renderPage();

    await screen.findByText(/season 3 is missing/i);
    expect(screen.queryByRole('link', { name: /all messages/i })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to ada writes/i })).toBeInTheDocument();
  });

  it('waits for the reader’s permissions before deciding what to draw', async () => {
    // The message arrives from one request and the permissions from another. Rendering on the
    // first alone shows a moderator a read-only page that then sprouts controls — and would show
    // the reader who wrote it a form, briefly, if the default ever flipped.
    let release: (value: Capabilities) => void = () => {};
    const pending = new Promise<Capabilities>((resolve) => {
      release = resolve;
    });
    global.fetch = fakeApi({
      'GET /api/v1/creators/ada-writes': creator,
      'GET /api/v1/creators/ada-writes/capabilities': () => pending,
      'GET /api/v1/creators/ada-writes/tickets/tk1': openTicket,
    });
    renderPage();

    expect(await screen.findByRole('status')).toHaveTextContent(/loading/i);
    expect(screen.queryByText(/season 3 is missing/i)).not.toBeInTheDocument();

    release(handler);

    expect(await screen.findByRole('button', { name: /send reply/i })).toBeInTheDocument();
  });
});
