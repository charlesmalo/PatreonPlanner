import { useState } from 'react';
import { api } from '../api/client';
import type { ReactionCount } from '../api/types';

/** Kept in step with the API's palette; a client cannot invent one the server will accept. */
export const REACTIONS = ['👍', '🔥', '😂', '😭', '🤯', '👀'] as const;

interface ReactionBarProps {
  slug: string;
  recommendationId: string;
  title: string;
  reactions: ReactionCount[];
  /** Reacting is participation, so it follows the same gate as upvoting. */
  canReact: boolean;
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
}: ReactionBarProps) {
  const [counts, setCounts] = useState(reactions);
  const [busy, setBusy] = useState(false);

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
    } catch {
      // The count stays as it was; the next load corrects it.
    } finally {
      setBusy(false);
    }
  }

  // Only what someone has actually used, plus the full palette for a reader who may add one.
  // A row of six grey emotes on every card would be noise on a board nobody has reacted to.
  const shown = canReact ? REACTIONS : REACTIONS.filter((emote) => countFor(emote));
  if (shown.length === 0) return null;

  return (
    <div className="mt-2 flex flex-wrap gap-1">
      {shown.map((emote) => {
        const row = countFor(emote);
        return (
          <button
            key={emote}
            type="button"
            disabled={!canReact || busy}
            onClick={() => toggle(emote)}
            aria-pressed={row?.reacted ?? false}
            aria-label={`${emote} ${row?.count ?? 0} on ${title}`}
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
  );
}
