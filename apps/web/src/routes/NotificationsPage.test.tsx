import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { NotificationsPage } from './NotificationsPage';
import type { Notification } from '../api/types';

const report = (id: string, title: string, reason = 'SPAM'): Notification => ({
  id,
  type: 'ENTRY_FLAGGED',
  groupCount: 1,
  readAt: null,
  createdAt: '2026-08-24T10:00:00.000Z',
  payload: {
    recommendationId: 'rec-1',
    title,
    creatorSlug: 'ada-writes',
    creatorName: 'Ada Writes',
    reason,
  },
});

describe('NotificationsPage', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  /** Records what the page asked for, so the controls are tested by their effect. */
  // Typed rather than inferred from the default: inference narrowed it to the report's exact
  // shape, so passing any other notification type failed to compile — which the test run alone
  // would not have told us, since vitest does not typecheck.
  function stubApi(items: Notification[] = [report('n1', 'Reported entry')]) {
    const queries: string[] = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      queries.push(url.search);
      return {
        ok: true,
        status: 200,
        json: async () => ({ items, nextCursor: null }),
      } as Response;
    });
    return queries;
  }

  const setup = () =>
    render(
      <MemoryRouter>
        <NotificationsPage />
      </MemoryRouter>,
    );

  it('lists what the reader has been told', async () => {
    stubApi();
    setup();

    expect(await screen.findByText(/Reported entry/)).toBeInTheDocument();
  });

  it('asks for newest first without being told to', async () => {
    const queries = stubApi();
    setup();

    await screen.findByText(/Reported entry/);
    // The default the dropdown uses too, so the page opens showing the same order.
    expect(queries[0]).not.toMatch(/sort=/);
  });

  it('narrows to reports when asked', async () => {
    const queries = stubApi();
    setup();
    await screen.findByText(/Reported entry/);

    await userEvent.selectOptions(screen.getByLabelText(/show/i), 'ENTRY_FLAGGED');

    await waitFor(() => expect(queries.at(-1)).toMatch(/type=ENTRY_FLAGGED/));
  });

  it('ranks by severity when asked, which is what a backlog needs', async () => {
    const queries = stubApi();
    setup();
    await screen.findByText(/Reported entry/);

    await userEvent.selectOptions(screen.getByLabelText(/sort/i), 'severity');

    await waitFor(() => expect(queries.at(-1)).toMatch(/sort=severity/));
  });

  it('narrows to unread when asked', async () => {
    const queries = stubApi();
    setup();
    await screen.findByText(/Reported entry/);

    await userEvent.click(screen.getByLabelText(/unread only/i));

    await waitFor(() => expect(queries.at(-1)).toMatch(/unreadOnly=true/));
  });

  it('says so when there is nothing to show', async () => {
    stubApi([]);
    setup();

    expect(await screen.findByText(/nothing here/i)).toBeInTheDocument();
  });

  it('shows why a report was raised, since that is what ranks it', async () => {
    stubApi([report('n1', 'Reported entry', 'HARASSMENT')]);
    setup();

    expect(await screen.findByText(/harassment/i)).toBeInTheDocument();
  });

  describe('messages to the moderators', () => {
    const resolved: Notification = {
      id: 'n9',
      type: 'TICKET_RESOLVED',
      groupCount: 1,
      readAt: null,
      createdAt: '2026-09-08T10:00:00.000Z',
      payload: {
        recommendationId: '',
        title: 'your message',
        creatorSlug: 'ada-writes',
        creatorName: 'Ada Writes',
        ticketId: 't1',
        resolution: 'ACTIONED',
        reply: 'Removed it, thanks for flagging.',
      },
    };

    it('shows what the moderator wrote back', async () => {
      // It was in the payload from the day tickets shipped and rendered nowhere.
      stubApi([resolved]);
      setup();

      expect(await screen.findByText(/removed it, thanks for flagging/i)).toBeInTheDocument();
    });

    it('does not describe a message as a status change', async () => {
      stubApi([resolved]);
      setup();

      await screen.findByText(/removed it, thanks/i);
      expect(screen.queryByText(/was updated on/i)).not.toBeInTheDocument();
    });

    it('links to the tickets page, where the message lives', async () => {
      stubApi([resolved]);
      setup();

      expect(await screen.findByRole('link', { name: /your message/i })).toHaveAttribute(
        'href',
        '/c/ada-writes/tickets',
      );
    });

    it('can be filtered to just messages', async () => {
      const queries = stubApi([resolved]);
      setup();
      await screen.findByText(/removed it, thanks/i);

      await userEvent.selectOptions(screen.getByLabelText(/show/i), 'TICKET_RAISED');

      await waitFor(() => expect(queries.at(-1)).toContain('type=TICKET_RAISED'));
    });
  });
});
