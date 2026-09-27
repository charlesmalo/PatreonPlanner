import { useState } from 'react';
import { api } from '../api/client';
import type { CreatorProfile } from '../api/types';

const MIN_TOKENS = 0;
const MAX_TOKENS = 50;

/**
 * How many redeem tokens each tier is granted per month.
 *
 * Its own component beside `TierWeights` rather than a second column inside it: they answer
 * different questions — what a vote is worth, and what a tier is *given* — and a creator changing
 * one is not usually thinking about the other. The two-state draft/saved pattern is copied
 * deliberately, along with the reason it exists.
 *
 * Rendered only when the board has tokens switched on. A number nobody can spend is a setting
 * that does nothing, and asking a creator to fill it in before enabling the feature gets the
 * order backwards.
 */
export function TierTokens({ slug, tiers }: { slug: string; tiers: CreatorProfile['tiers'] }) {
  // Two states, not one. The field's value and the last value the server accepted are different
  // things: with a single map, `onChange` writes the new number before `onBlur` reads it, so the
  // "did it change?" check compares the new value against itself and never saves.
  const [saved, setSaved] = useState<Record<string, number>>(() =>
    Object.fromEntries(tiers.map((tier) => [tier.id, tier.tokensPerPeriod])),
  );
  const [draft, setDraft] = useState<Record<string, number>>(() =>
    Object.fromEntries(tiers.map((tier) => [tier.id, tier.tokensPerPeriod])),
  );
  const [message, setMessage] = useState<string | null>(null);

  async function save(tierId: string, raw: string) {
    const value = Number(raw);
    const previous = saved[tierId];
    // Answered here rather than sent: the API takes 0 to 50, and its 400 reads like the page is
    // broken because nothing on screen said what the range was.
    if (!Number.isInteger(value) || value < MIN_TOKENS || value > MAX_TOKENS) {
      setMessage(`A tier can be granted a whole number of tokens, 0 to ${MAX_TOKENS}.`);
      setDraft((current) => ({ ...current, [tierId]: previous }));
      return;
    }
    if (value === previous) return;
    setMessage(null);
    try {
      await api.patch(`/creators/${encodeURIComponent(slug)}/tiers/${tierId}`, {
        tokensPerPeriod: value,
      });
      setSaved((current) => ({ ...current, [tierId]: value }));
    } catch {
      setDraft((current) => ({ ...current, [tierId]: previous }));
      setMessage('That did not save. Nothing changed.');
    }
  }

  return (
    <section className="mt-6">
      <h2 className="text-sm font-medium">Redeem tokens per tier</h2>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
        Granted once a calendar month, to anyone holding that tier when they next open the board. A
        token marks one accepted entry as Priority, and the patron writes what they want played.
        Zero means that tier is granted none.
      </p>

      <ul className="mt-3 space-y-2">
        {[...tiers]
          .sort((a, b) => a.order - b.order)
          .map((tier) => (
            <li key={tier.id} className="flex flex-wrap items-center gap-3 text-sm">
              <label htmlFor={`tokens-${tier.id}`} className="min-w-[12rem]">
                <span className="font-medium">{tier.title}</span>
                <span className="ml-2 text-slate-600 dark:text-slate-300">
                  ${(tier.amountCents / 100).toFixed(2)}
                </span>
              </label>
              <input
                id={`tokens-${tier.id}`}
                type="number"
                min={MIN_TOKENS}
                max={MAX_TOKENS}
                value={draft[tier.id] ?? tier.tokensPerPeriod}
                // Saved on blur rather than per keystroke: typing "10" passes through "1", and a
                // request per digit would leave the grant at whatever the last one happened to be.
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    [tier.id]: Number(event.target.value),
                  }))
                }
                onBlur={(event) => save(tier.id, event.target.value)}
                className="w-24 rounded border border-slate-300 px-2 py-1 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:bg-slate-950"
              />
            </li>
          ))}
      </ul>

      {message ? (
        <p role="status" aria-live="polite" className="mt-2 text-sm text-red-600 dark:text-red-400">
          {message}
        </p>
      ) : null}
    </section>
  );
}
