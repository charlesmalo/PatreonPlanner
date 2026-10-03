import { destinationFor } from './notification-destination';
import type { Notification } from './types';

/**
 * The rule two surfaces used to carry a copy of each.
 *
 * Tested here rather than only through the two components, because the thing worth pinning is the
 * mapping itself — six types to five destinations — and asserting it through a rendered dropdown
 * costs a click per case and says nothing extra.
 */
const notification = (over: Partial<Notification> = {}): Notification => ({
  id: 'n1',
  type: 'ENTRY_STATUS_CHANGED',
  groupCount: 1,
  readAt: null,
  createdAt: '2026-09-08T10:00:00.000Z',
  payload: {
    recommendationId: 'rec-1',
    title: 'Spirited Away',
    creatorSlug: 'ada-writes',
    creatorName: 'Ada Writes',
  },
  ...over,
});

const payload = (over: Partial<Notification['payload']>): Partial<Notification> => ({
  payload: { ...notification().payload, ...over },
});

describe('destinationFor', () => {
  it('sends a status change to the entry that changed', () => {
    expect(destinationFor(notification())).toBe('/c/ada-writes/e/rec-1');
  });

  it('falls back to the board when the entry never existed', () => {
    // Content refused before it was created carries no id, and there is nothing else to open.
    expect(destinationFor(notification(payload({ recommendationId: '' })))).toBe('/c/ada-writes');
  });

  it('sends a report to the queue, where it can be acted on', () => {
    expect(destinationFor(notification({ type: 'ENTRY_FLAGGED' }))).toBe('/c/ada-writes/review');
  });

  it('sends a raised message to that message', () => {
    const item = notification({ type: 'TICKET_RAISED', ...payload({ ticketId: 'tk1' }) });

    expect(destinationFor(item)).toBe('/c/ada-writes/tickets/tk1');
  });

  it('sends a resolved message to that message, which is where the answer is', () => {
    // The reader who raised it holds no moderator permission, so the inbox would refuse them —
    // this is the only ticket page they can open at all.
    const item = notification({ type: 'TICKET_RESOLVED', ...payload({ ticketId: 'tk1' }) });

    expect(destinationFor(item)).toBe('/c/ada-writes/tickets/tk1');
  });

  it('falls back to the inbox for a message notification carrying no id', () => {
    // `ticketId` is optional on the payload type, so a build must not render `/tickets/undefined`.
    const item = notification({ type: 'TICKET_RAISED' });

    expect(destinationFor(item)).toBe('/c/ada-writes/tickets');
  });

  it('sends a redeem to the entry that is playing', () => {
    expect(destinationFor(notification({ type: 'REDEEM_PLAYING' }))).toBe('/c/ada-writes/e/rec-1');
  });
});
