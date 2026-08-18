import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { NotificationBell } from './NotificationBell';
import type { Notification } from '../api/types';

const statusChange = (overrides: Partial<Notification> = {}): Notification => ({
  id: 'n1',
  type: 'ENTRY_STATUS_CHANGED',
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
});
