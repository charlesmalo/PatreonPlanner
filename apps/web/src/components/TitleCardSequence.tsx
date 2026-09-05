/** The slogan, and the order it has to stay in. */
/**
 * The slogan, the order it has to stay in, and the colour each stage takes.
 *
 * `accent` follows the mascot's three puzzle pieces — the outer two pale, the middle one coral —
 * so the cards, the heading above them and the artwork all say the same thing. Empty means the
 * word inherits the theme's foreground, which is white on the dark theme and readable on the
 * light one, where literal white would not be.
 */
const STAGES = [
  { word: 'Pitch.', column: 'Suggested', gloss: 'A patron puts something forward.', accent: '' },
  {
    word: 'Plan.',
    column: 'Accepted',
    gloss: 'You decide it is happening, and when.',
    accent: 'text-brand',
  },
  { word: 'Play.', column: 'Now Playing', gloss: 'It reaches the top of the queue.', accent: '' },
] as const;

/**
 * The slogan as the thing it describes: three board cards landing one after another, each one
 * jostling the ones already there.
 *
 * The animation is decorative and the words are not. Every stage is ordinary text in the document,
 * in order, so the sequence reads identically to a screen reader, to a crawler, and to anyone whose
 * system asks for less motion — where it does not animate at all. Nothing here is the only way to
 * learn something.
 *
 * Left to right is load-bearing rather than a layout choice: a patron *pitches*, the creator
 * *plans* it into the queue, and it *plays*. That is the board's own lifecycle, which is why the
 * column each card names is a real column.
 */
export function TitleCardSequence() {
  return (
    <ol className="flex flex-wrap items-stretch justify-center gap-3 sm:gap-4" role="list">
      {STAGES.map((stage) => (
        <li
          key={stage.word}
          // One static class, and the stylesheet picks each card out by position. A composed name
          // like `pp-title-card-${index + 1}` is invisible to Tailwind's scanner, which reads
          // source as text — it purged those rules and the sequence shipped without an
          // `animation-name` at all. Nothing failed; it simply did not move.
          className="pp-title-card w-full max-w-[15rem] rounded-lg border border-slate-200 bg-white p-4 text-left shadow-sm sm:w-56 dark:border-slate-800 dark:bg-slate-900"
        >
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
            {stage.column}
          </p>
          <p className={`mt-1 text-2xl font-semibold tracking-tight ${stage.accent}`}>
            {stage.word}
          </p>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{stage.gloss}</p>
        </li>
      ))}
    </ol>
  );
}
