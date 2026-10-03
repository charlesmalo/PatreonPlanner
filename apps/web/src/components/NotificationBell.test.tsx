import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { NotificationBell } from './NotificationBell';
import type { Notification } from '../api/types';

const statusChange = (overrides: Partial<Notification> = {}): Notification => ({
  id: 'n1',
  type: 'ENTRY_STATUS_CHANGED',
  groupCount: 1,
  readAt: null,
  createdAt: '2026-08-24T10:00:00.000Z',
  payload: {
    recommendationId: 'rec-1',
    title: 'Cowboy Bebop',
    creatorSlug: 'ada-writes',
    creatorName: 'Ada Writes',
    status: 'ACCEPTED',
  },
  ...overrides,
});

const flagged = (): Notification => ({
  id: 'n2',
  type: 'ENTRY_FLAGGED',
  groupCount: 1,
  readAt: null,
  createdAt: '2026-08-24T11:00:00.000Z',
  payload: {
    recommendationId: 'rec-2',
    title: 'Some Entry',
    creatorSlug: 'ada-writes',
    creatorName: 'Ada Writes',
    reason: 'SPAM',
  },
});

function renderBell(props: Partial<Parameters<typeof NotificationBell>[0]> = {}) {
  const onOpen = vi.fn();
  render(
    <MemoryRouter>
      <NotificationBell unreadCount={0} items={[]} loading={false} onOpen={onOpen} {...props} />
    </MemoryRouter>,
  );
  return { onOpen };
}

const followedBoard = (groupCount: number): Notification => ({
  id: 'n3',
  type: 'ENTRY_MOVED',
  groupCount,
  readAt: null,
  createdAt: '2026-08-24T10:00:00.000Z',
  payload: {
    recommendationId: 'rec-3',
    title: 'Nausicaa',
    creatorSlug: 'ada-writes',
    creatorName: 'Ada Writes',
    status: 'ACTIVE',
  },
});

describe('NotificationBell', () => {
  it('announces how many are unread', () => {
    // The count belongs in the accessible name: a bare badge tells a screen reader nothing.
    renderBell({ unreadCount: 3 });
    expect(screen.getByRole('button', { name: /3 unread/i })).toBeInTheDocument();
  });

  it('still offers the list when nothing is unread', () => {
    renderBell({ unreadCount: 0 });
    expect(screen.getByRole('button', { name: /no unread/i })).toBeInTheDocument();
  });

  it('loads and shows the list when opened', async () => {
    const { onOpen } = renderBell({ unreadCount: 1, items: [statusChange()] });

    await userEvent.click(screen.getByRole('button', { name: /unread/i }));

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Cowboy Bebop/)).toBeInTheDocument();
    expect(screen.getByText(/accepted/i)).toBeInTheDocument();
  });

  it('says which board a flag notification came from', async () => {
    renderBell({ unreadCount: 1, items: [flagged()] });

    await userEvent.click(screen.getByRole('button', { name: /unread/i }));

    expect(screen.getByText(/reported/i)).toBeInTheDocument();
    expect(screen.getByText(/Ada Writes/)).toBeInTheDocument();
  });

  it('takes a report to the queue where it is acted on', async () => {
    // A moderator hearing about a report wants the queue, not the board — the board is where the
    // entry is read, the queue is where something can be done about it.
    renderBell({ unreadCount: 1, items: [flagged()] });

    await userEvent.click(screen.getByRole('button', { name: /unread/i }));

    expect(screen.getByRole('link', { name: /Some Entry/ })).toHaveAttribute(
      'href',
      '/c/ada-writes/review',
    );
  });

  it('takes a status change to the entry it happened to', async () => {
    // Its own page exists now and says so plainly when the entry has since gone, so this no
    // longer has to settle for the board.
    renderBell({ unreadCount: 1, items: [statusChange()] });

    await userEvent.click(screen.getByRole('button', { name: /unread/i }));

    expect(screen.getByRole('link', { name: /Cowboy Bebop/ })).toHaveAttribute(
      'href',
      '/c/ada-writes/e/rec-1',
    );
  });

  it('closes again on a second click', async () => {
    renderBell({ unreadCount: 1, items: [statusChange()] });
    const button = screen.getByRole('button', { name: /unread/i });

    await userEvent.click(button);
    expect(screen.getByText(/Cowboy Bebop/)).toBeInTheDocument();

    await userEvent.click(button);
    expect(screen.queryByText(/Cowboy Bebop/)).not.toBeInTheDocument();
  });

  it('offers the full list, which is where filtering and sorting live', async () => {
    renderBell({ unreadCount: 1, items: [statusChange()] });

    await userEvent.click(screen.getByRole('button', { name: /unread/i }));

    expect(screen.getByRole('link', { name: /see all/i })).toHaveAttribute(
      'href',
      '/notifications',
    );
  });

  it('offers the full list even when the panel is empty', async () => {
    // Read notifications are still there; an empty panel does not mean an empty history.
    renderBell({ items: [] });

    await userEvent.click(screen.getByRole('button', { name: /notification/i }));

    expect(screen.getByRole('link', { name: /see all/i })).toBeInTheDocument();
  });

  it('says so when there is nothing to show', async () => {
    renderBell({ items: [] });

    await userEvent.click(screen.getByRole('button', { name: /notification/i }));

    expect(screen.getByText(/nothing yet/i)).toBeInTheDocument();
  });

  it('marks an already-read row differently from an unread one', async () => {
    renderBell({
      unreadCount: 1,
      items: [statusChange(), statusChange({ id: 'n3', readAt: '2026-08-24T12:00:00.000Z' })],
    });

    await userEvent.click(screen.getByRole('button', { name: /unread/i }));

    // One of the two carries the unread marker, not both and not neither.
    expect(screen.getAllByTestId('unread-marker')).toHaveLength(1);
  });

  it('renders a single move exactly as it renders any other one', async () => {
    renderBell({ unreadCount: 1, items: [followedBoard(1)] });
    await userEvent.click(screen.getByRole('button', { name: /unread/i }));

    expect(screen.getByText(/Nausicaa/)).toBeInTheDocument();
    expect(screen.queryByText(/other change/i)).not.toBeInTheDocument();
  });

  it('says how many moves a folded notification stands for', async () => {
    // The payload describes the newest move. Saying only that would quietly drop the other five,
    // which is the difference between a summary and a lie.
    renderBell({ unreadCount: 1, items: [followedBoard(6)] });
    await userEvent.click(screen.getByRole('button', { name: /unread/i }));

    expect(screen.getByText(/5 other changes/i)).toBeInTheDocument();
  });

  it('names one folded notification correctly in the singular', async () => {
    renderBell({ unreadCount: 1, items: [followedBoard(2)] });
    await userEvent.click(screen.getByRole('button', { name: /unread/i }));

    expect(screen.getByText(/1 other change(?!s)/i)).toBeInTheDocument();
  });

  describe('a message to the moderators', () => {
    // The API emits TICKET_RAISED and TICKET_RESOLVED, ranks TICKET_RAISED above everything else,
    // and the web type union did not list either. They fell through to the status branch and read
    // "was updated on Ada Writes", pointing at the board.
    const ticket = (over: Partial<Notification> = {}): Notification => ({
      id: 'n9',
      type: 'TICKET_RAISED',
      groupCount: 1,
      readAt: null,
      createdAt: '2026-09-08T10:00:00.000Z',
      payload: {
        recommendationId: '',
        title: 'the board',
        creatorSlug: 'ada-writes',
        creatorName: 'Ada Writes',
        ticketId: 't1',
      },
      ...over,
    });

    it('says a message was sent, not that something was updated', async () => {
      renderBell({ items: [ticket()], unreadCount: 1 });
      await userEvent.click(screen.getByRole('button', { name: /notifications/i }));

      expect(screen.getByText(/message to the moderators/i)).toBeInTheDocument();
      expect(screen.queryByText(/was updated on/i)).not.toBeInTheDocument();
    });

    it('sends a moderator to the message a notification is about, not to the pile', async () => {
      renderBell({ items: [ticket()], unreadCount: 1 });
      await userEvent.click(screen.getByRole('button', { name: /notifications/i }));

      expect(screen.getByRole('link', { name: /the board/i })).toHaveAttribute(
        'href',
        '/c/ada-writes/tickets/t1',
      );
    });

    it('shows the reply when a message is answered', async () => {
      // The whole point of resolving a ticket. The payload carried the reply and the resolution
      // and neither was ever rendered, so the reader was told only that something happened.
      renderBell({
        items: [
          ticket({
            id: 'n10',
            type: 'TICKET_RESOLVED',
            payload: {
              recommendationId: '',
              title: 'your message',
              creatorSlug: 'ada-writes',
              creatorName: 'Ada Writes',
              ticketId: 't1',
              resolution: 'ACTIONED',
              reply: 'Removed it, thanks for flagging.',
            },
          }),
        ],
        unreadCount: 1,
      });
      await userEvent.click(screen.getByRole('button', { name: /notifications/i }));

      expect(screen.getByText(/removed it, thanks for flagging/i)).toBeInTheDocument();
    });

    it('says the outcome even when there is no reply', async () => {
      // `resolution` is always set; `reply` is optional, because "handled internally" is a
      // legitimate answer. Rendering only the reply leaves those readers told that something
      // happened and nothing about what.
      renderBell({
        items: [
          ticket({
            id: 'n11',
            type: 'TICKET_RESOLVED',
            payload: {
              recommendationId: '',
              title: 'your message',
              creatorSlug: 'ada-writes',
              creatorName: 'Ada Writes',
              ticketId: 't1',
              resolution: 'DENIED',
            },
          }),
        ],
        unreadCount: 1,
      });
      await userEvent.click(screen.getByRole('button', { name: /notifications/i }));

      expect(screen.getByText(/declined by the moderators/i)).toBeInTheDocument();
    });

    it('stays readable if the API adds a resolution this build has never heard of', async () => {
      // A new enum value must not render "undefined by the moderators of Ada Writes".
      renderBell({
        items: [
          ticket({
            id: 'n12',
            type: 'TICKET_RESOLVED',
            payload: {
              recommendationId: '',
              title: 'your message',
              creatorSlug: 'ada-writes',
              creatorName: 'Ada Writes',
              ticketId: 't1',
              resolution: 'ESCALATED_TO_SOMETHING_NEW',
            },
          }),
        ],
        unreadCount: 1,
      });
      await userEvent.click(screen.getByRole('button', { name: /notifications/i }));

      expect(screen.getByText(/answered by the moderators/i)).toBeInTheDocument();
      expect(screen.queryByText(/undefined/i)).not.toBeInTheDocument();
    });
  });
});
