/**
 * The API restricts link URLs to http(s) at submit time. This repeats the check at the one place
 * attacker input becomes an attribute, so a future API regression is not immediately exploitable
 * — React only warns on a javascript: href, it does not block it.
 *
 * Its own module rather than living on a component: three components now render submitter-chosen
 * URLs, and importing this from the card would have made the card and the candidate list import
 * each other.
 */
export function isSafeHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}
