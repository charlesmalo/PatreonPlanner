import { ApiError } from '../api/client';

/**
 * A refusal, in the reader's terms.
 *
 * Pure and on its own so the copy can be read and tested without standing up a form. It is the
 * only place that decides what a submission failure sounds like, which matters because getting it
 * wrong either says too much or says nothing useful.
 */
export function submitErrorMessage(error: unknown): string {
  // A timeout is the one refusal that carries a time, and the time is the only part the user can
  // act on. Nothing is said about why — design §9 wants no probing of the rules.
  if (error instanceof ApiError && error.status === 403 && error.retryAt) {
    const when = new Date(error.retryAt);
    if (!Number.isNaN(when.getTime())) {
      return `You cannot suggest anything until ${when.toLocaleString()}.`;
    }
  }
  if (!(error instanceof ApiError)) return 'Something went wrong. Try again.';
  switch (error.status) {
    case 429:
      return 'You have suggested recently — try again a little later.';
    case 400:
      return 'That suggestion was rejected. Try rewording it.';
    case 403:
      return 'Suggesting is for patrons at the required tier.';
    case 401:
      return 'Sign in to suggest something.';
    default:
      return 'Something went wrong. Try again.';
  }
}
