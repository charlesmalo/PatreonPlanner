import { useState } from 'react';
import { api } from '../api/client';
import type { ReactionCount } from '../api/types';

/**
 * Kept in step with the API's palette; a client cannot invent one the server will accept.
 *
 * Split the same way for the same reason: offering an emote the server then refuses is a worse
 * failure than never offering it, and only an end-to-end test would catch the two drifting.
 */
export const FREE_REACTIONS = ['👍', '🔥', '😂', '😭', '🤯', '👀'] as const;
export const PREMIUM_REACTIONS = ['🍿', '🧠', '🥹', '⭐', '🎯', '🫶'] as const;
export const REACTIONS = [...FREE_REACTIONS, ...PREMIUM_REACTIONS] as const;

interface ReactionBarProps {
  slug: string;
  recommendationId: string;
  title: string;
  reactions: ReactionCount[];
  /** Reacting is participation, so it follows the same gate as upvoting. */
  canReact: boolean;
  /** Which half of the palette this reader may cast from. A hint — the API checks again. */
  isPremium?: boolean;
}

/**
 * Enthusiasm, kept apart from demand.
 *
 * Upvotes rank the board; these do not, and deliberately carry no weight — so someone can say
 * "yes!" without it being counted as "I would watch this".
 */
export function ReactionBar({
  slug,
  recommendationId,
  title,
  reactions,
  canReact,
  isPremium = false,
}: ReactionBarProps) {
  const [counts, setCounts] = useState(reactions);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const countFor = (emote: string) => counts.find((row) => row.emote === emote);

  async function toggle(emote: string) {
    setBusy(true);
    try {
      const result = await api.post<ReactionCount>(
        `/creators/${encodeURIComponent(slug)}/reactions`,
        {
          recommendationId,
          emote,
        },
      );
      // Reconciled from the server's own count rather than guessed: two tabs, or two people,
      // would otherwise drift.
      setCounts((current) => {
        const rest = current.filter((row) => row.emote !== emote);
        return result.count > 0 ? [...rest, result] : rest;
      });
      setFailed(false);
    } catch {
      // The count is taken from the server rather than guessed, so there is nothing to put back —
      // and that is exactly the problem. A refusal left the row identical to how it started, which
      // from the reader's side is a button that does nothing. Reacting is rate limited, so this is
      // reachable by anyone enthusiastic enough to press four in a row. Upvoting already settled
      // the principle: the server is what decides, so its refusal has to be shown.
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  const locked = (emote: string) =>
    (PREMIUM_REACTIONS as readonly string[]).includes(emote) && !isPremium;

  // Only what someone has actually used, plus the palette a reader who may add one can reach.
  // A row of twelve grey emotes on every card would be noise on a board nobody has reacted to.
  //
  // A locked emote that somebody else already used still appears, with its count: reading is
  // never gated, or a count would vanish the day a reactor stopped paying.
  const shown = REACTIONS.filter((emote) => {
    // Anything somebody has actually used is always shown, with its count. Reading is never
    // gated, or a count would vanish the day the person who cast it stopped paying.
    if (countFor(emote)) return true;
    // Beyond that, only what this reader could add. Twelve grey emotes on every card of a board
    // nobody has reacted to is noise, and six of them would be noise they cannot even use.
    return canReact && !locked(emote);
  });
  if (shown.length === 0) return null;

  return (
    <div className="mt-2">
      <div className="flex flex-wrap gap-1">
        {shown.map((emote) => {
          const row = countFor(emote);
          return (
            <button
              key={emote}
              type="button"
              disabled={!canReact || busy || locked(emote)}
              onClick={() => toggle(emote)}
              aria-pressed={row?.reacted ?? false}
              aria-label={
                locked(emote)
                  ? `${emote} ${row?.count ?? 0} on ${title} — premium palette`
                  : `${emote} ${row?.count ?? 0} on ${title}`
              }
              title={locked(emote) ? 'Part of the premium palette' : undefined}
              className={`rounded border px-1.5 py-0.5 text-xs disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${
                row?.reacted
                  ? 'border-sky-500 bg-sky-50 dark:bg-sky-950/40'
                  : 'border-slate-300 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800'
              }`}
            >
              <span aria-hidden="true">{emote}</span>
              {row ? <span className="ml-1">{row.count}</span> : null}
            </button>
          );
        })}
      </div>
      {failed ? (
        <p role="status" aria-live="polite" className="mt-1 text-xs text-red-600 dark:text-red-400">
          That did not count. Try again.
        </p>
      ) : null}
    </div>
  );
}
