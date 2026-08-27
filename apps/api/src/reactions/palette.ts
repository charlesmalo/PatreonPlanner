/**
 * The set we ship.
 *
 * Curated rather than uploaded: user- or creator-supplied images mean hosting, storage, and a
 * content-moderation surface considerably worse than text — and the first CDN bill breaks the
 * free-only constraint. Serving this set to ten thousand people costs what serving it to ten
 * costs, which is what makes it an honest thing to charge for.
 */

/** Everybody gets these. Reacting is not a premium feature; Amendment A.1 keeps it free. */
export const FREE_REACTIONS = ['👍', '🔥', '😂', '😭', '🤯', '👀'] as const;

/**
 * More of the set we already ship, for readers who pay. Amendment A.2.
 *
 * Deliberately non-derogatory. A reaction hangs off somebody's *suggestion*, and a
 * downvote-shaped emote turns hype into a pile-on — which is exactly what design §10 separated
 * reactions from upvotes to avoid. Every one of these is positive or neutral, and that is a
 * constraint on anything added here later, not an accident of this particular six.
 */
export const PREMIUM_REACTIONS = ['🍿', '🧠', '🥹', '⭐', '🎯', '🫶'] as const;

export const REACTIONS = [...FREE_REACTIONS, ...PREMIUM_REACTIONS] as const;

export type Reaction = (typeof REACTIONS)[number];

export function isReaction(value: string): value is Reaction {
  return (REACTIONS as readonly string[]).includes(value);
}

/**
 * Whether casting this one needs a subscription.
 *
 * Only casting. Reading is never gated: an emote somebody already used renders and counts for
 * everybody, or a count would vanish the day their subscription lapsed — which is both a lie
 * about the data and a clawback of something already given.
 */
export function needsPremium(value: string): boolean {
  return (PREMIUM_REACTIONS as readonly string[]).includes(value);
}
