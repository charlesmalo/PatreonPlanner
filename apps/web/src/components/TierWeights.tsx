import { useState } from 'react';
import { api } from '../api/client';
import type { CreatorProfile } from '../api/types';

const MIN_WEIGHT = 0;
const MAX_WEIGHT = 1000;

/**
 * What a vote from each tier counts for.
 *
 * `PATCH /creators/:slug/tiers/:id` has existed since weighted voting shipped and nothing called
 * it, so every tier on every board sat at the default of 1 — which makes `weightedScore` identical
 * to the raw upvote count, and the board's "Top rated" sort a plain popularity sort. The feature
 * was complete apart from any way to use it.
 *
 * Owner-only, matching the API: deciding what a pledge is worth in the ranking is not a moderation
 * power.
 */
export function TierWeights({ slug, tiers }: { slug: string; tiers: CreatorProfile['tiers'] }) {
  // Two states, not one. The field's value and the last value the server accepted are different
  // things: with a single map, `onChange` had already written the new number before `onBlur` read
  // it, so the "did it change?" check compared the new value against itself and never saved.
  const [saved, setSaved] = useState<Record<string, number>>(() =>
    Object.fromEntries(tiers.map((tier) => [tier.id, tier.voteWeight])),
  );
  const [draft, setDraft] = useState<Record<string, number>>(() =>
    Object.fromEntries(tiers.map((tier) => [tier.id, tier.voteWeight])),
  );
  const [message, setMessage] = useState<string | null>(null);

  async function save(tierId: string, raw: string) {
    const value = Number(raw);
    const previous = saved[tierId];
    // Answered here rather than sent: the API takes 0 to 1000, and its 400 reads like the page is
    // broken because nothing on screen said what the range was.
    if (!Number.isInteger(value) || value < MIN_WEIGHT || value > MAX_WEIGHT) {
      setMessage(`A vote has to be worth a whole number between 0 and ${MAX_WEIGHT}.`);
      setDraft((current) => ({ ...current, [tierId]: previous }));
      return;
    }
    if (value === previous) return;
    setMessage(null);
    try {
      await api.patch(`/creators/${encodeURIComponent(slug)}/tiers/${tierId}`, {
        voteWeight: value,
      });
      setSaved((current) => ({ ...current, [tierId]: value }));
      setMessage('Saved.');
    } catch {
      // Both, so the field shows what is actually stored rather than what was attempted.
      setDraft((current) => ({ ...current, [tierId]: previous }));
      setMessage('That did not save. Nothing changed.');
    }
  }

  if (tiers.length === 0) {
    return (
      <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
        {/* Deliberately not the same sentence as the gates above, which say the same thing about
            a different consequence — two identical messages on one page read as one message
            repeated by mistake. */}
        Until tiers sync from Patreon there is nothing to weight, so every vote counts for one.
      </p>
    );
  }

  return (
    <div className="mt-3">
      <p className="text-sm text-slate-600 dark:text-slate-300">
        Ranking uses this, not the raw number of upvotes. Leaving every tier at 1 is a plain
        popularity sort, which is what a board does until you change it.{' '}
        {/* Zero is allowed by the API deliberately, and it is the one value whose effect is not
            obvious from the number itself. */}
        <span className="font-medium">Zero</span> means votes from that tier are counted but carry
        no weight in the order.
      </p>

      <ul className="mt-3 space-y-2">
        {[...tiers]
          .sort((a, b) => a.order - b.order)
          .map((tier) => (
            <li key={tier.id} className="flex flex-wrap items-center gap-3 text-sm">
              <label htmlFor={`weight-${tier.id}`} className="min-w-[12rem]">
                <span className="font-medium">{tier.title}</span>
                <span className="ml-2 text-slate-600 dark:text-slate-300">
                  ${(tier.amountCents / 100).toFixed(2)}
                </span>
              </label>
              <input
                id={`weight-${tier.id}`}
                type="number"
                min={MIN_WEIGHT}
                max={MAX_WEIGHT}
                value={draft[tier.id] ?? tier.voteWeight}
                // Saved on blur rather than per keystroke: typing "10" passes through "1", and a
                // request per digit would leave the weight at whatever the last one happened to be.
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
        <p role="status" className="mt-2 text-sm text-slate-600 dark:text-slate-300">
          {message}
        </p>
      ) : null}
    </div>
  );
}
