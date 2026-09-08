/**
 * How a resolved message is described to the person who sent it.
 *
 * `resolution` is always set — a moderator must choose one — while `reply` is optional, because
 * "handled internally" is a legitimate answer to a reader and not one to the audit trail. So this
 * is the only guaranteed piece of information a resolved-message notification carries, and
 * rendering the reply alone left the readers who got no reply told that something had happened
 * and nothing about what.
 *
 * Shared by the dropdown and the notifications page rather than written twice, which is how the
 * two would come to word the same event differently.
 */
const OUTCOMES: Record<string, string> = {
  CONFIRMED: 'confirmed',
  DENIED: 'declined',
  LINKED: 'linked to an existing entry',
  CLOSED: 'closed',
};

/**
 * Falls back rather than failing. A resolution added to the API after this build shipped would
 * otherwise render as "undefined by the moderators of Ada Writes" — a defect visible only to
 * whoever received it, on a build nobody is looking at any more.
 */
export function describeResolution(resolution: string | undefined): string {
  return (resolution && OUTCOMES[resolution]) || 'answered';
}
