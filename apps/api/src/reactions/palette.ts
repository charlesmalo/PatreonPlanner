/**
 * The set we ship.
 *
 * Curated rather than uploaded: user- or creator-supplied images mean hosting, storage, and a
 * content-moderation surface considerably worse than text — and the first CDN bill breaks the
 * free-only constraint. Serving this set to ten thousand people costs what serving it to ten
 * costs.
 *
 * One palette for everyone at present. The design leaves *what premium contains* open, and
 * splitting this into free and premium tiers would implement an undecided answer; when it is
 * decided, the split happens here.
 */
export const REACTIONS = ['👍', '🔥', '😂', '😭', '🤯', '👀'] as const;

export type Reaction = (typeof REACTIONS)[number];

export function isReaction(value: string): value is Reaction {
  return (REACTIONS as readonly string[]).includes(value);
}
