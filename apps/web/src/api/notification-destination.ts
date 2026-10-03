import type { Notification } from './types';

/**
 * Where the news is acted on, which is not always where it happened.
 *
 * A report goes to the queue: the board is where an entry is read, the queue is where a moderator
 * can do something about it. A status change goes to the entry itself, which has its own page and
 * says so plainly when it has since been removed. A message goes to that message — not to the
 * entry it happens to be about, which leaves a moderator looking at the thing rather than at what
 * was said about it, and not to the whole inbox, which is a pile to search.
 *
 * Shared by the dropdown and the notifications page rather than written twice. It was written
 * twice, identically, and the copies are why `payload.ticketId` could be sent by the API from the
 * day tickets shipped and read by neither: one rule in two places is one rule nobody owns.
 */
export function destinationFor(item: Notification): string {
  const board = `/c/${item.payload.creatorSlug}`;
  if (item.type === 'ENTRY_FLAGGED') return `${board}/review`;
  if (item.type === 'TICKET_RAISED' || item.type === 'TICKET_RESOLVED') {
    // The inbox is the fallback, not the destination. `ticketId` is optional on the payload type
    // and a notification written before it was carried has none — and for the reader who raised
    // the message the fallback is a page they are refused, so it is worth as little as possible.
    return item.payload.ticketId ? `${board}/tickets/${item.payload.ticketId}` : `${board}/tickets`;
  }
  return item.payload.recommendationId
    ? `${board}/e/${item.payload.recommendationId}`
    : // No id means the content was refused before it existed; the board is all there is.
      board;
}
