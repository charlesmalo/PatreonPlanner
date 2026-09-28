import type { TokenState } from '../api/use-tokens';

/** The first of next month, UTC — periods are `YYYY-MM`, so that is when the next one begins. */
function nextGrantDate(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

const WHEN = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'long',
  timeZone: 'UTC',
});

interface TokenWalletProps {
  tokens: TokenState;
  /** Injectable so the date this renders is testable without freezing the clock. */
  now?: Date;
}

/**
 * A reader's redeem tokens, in one place they can find them.
 *
 * The count already rides on every redeem control, but only on cards that have one — so a reader
 * with tokens and no accepted entries in view saw no number anywhere, and a reader with none saw
 * nothing to explain why the controls were missing. Both are answered here.
 *
 * It says when the next grant lands because the alternative is a reader refreshing to find out.
 * Granting is lazy — the next batch appears the first time they open the board in the new period,
 * not at midnight — but the date is the same either way, so saying it is honest.
 */
export function TokenWallet({ tokens, now = new Date() }: TokenWalletProps) {
  // Nothing at all rather than an empty shell: on a board that never switched tokens on, this is
  // a feature the reader has no reason to learn exists.
  if (!tokens.enabled) return null;

  const { available } = tokens;
  return (
    <section
      aria-label="Your redeem tokens"
      className="mb-3 rounded border border-sky-200 bg-sky-50 px-3 py-2 text-sm dark:border-sky-900 dark:bg-sky-950/40"
    >
      <p className="font-medium text-sky-900 dark:text-sky-200">
        {available === 0
          ? 'No redeem tokens right now'
          : `${available} redeem ${available === 1 ? 'token' : 'tokens'}`}
      </p>
      <p className="mt-0.5 text-xs text-slate-600 dark:text-slate-400">
        {available === 0
          ? // Said plainly, because the absent control is otherwise indistinguishable from a bug.
            'Spend one to mark an accepted entry as Priority. Your next grant arrives '
          : 'Spend one to mark an accepted entry as Priority. Next grant '}
        {WHEN.format(nextGrantDate(now))}.
      </p>
    </section>
  );
}
