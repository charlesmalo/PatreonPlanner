/**
 * What gets embedded, and a version for it.
 *
 * These two live in one file on purpose. The column stores a signature rather than a bare model
 * id, so changing the recipe without bumping the version beside it leaves rows embedded from
 * different text in one vector space — the same "confident nonsense" the model check already
 * guards against, arriving by a door nobody was watching. Keeping them adjacent makes changing
 * one without the other look wrong.
 *
 * v1 was name plus aliases. v2 adds the overview, which is what lets a query describe a title
 * rather than name it: under v1 a plot description measured further from its own entry than
 * gibberish did, because the plot was nowhere in the vector.
 */
export const PASSAGE_VERSION = 'v2';

/**
 * Rows embedded under a different model *or* a different recipe are re-embedded. Comparing across
 * either boundary produces a confident wrong answer rather than an error, which is worse than
 * having no vector at all.
 */
export function embeddingSignature(modelId: string): string {
  return `${modelId}#${PASSAGE_VERSION}`;
}

/**
 * The overview carries what the title is *about*. Joined with a separator rather than concatenated
 * so the model sees these as distinct fields rather than one run-on sentence.
 *
 * The aliases would carry other-language surface forms, and in a running system they are **always
 * empty**: nothing in this codebase writes a `TitleAlias`. The table has a trigram index, the
 * search query joins it, and this passage reads it — every part exists except a producer, and the
 * tests that cover alias matching create the rows themselves. Kept in the recipe because the read
 * side is correct and costs nothing on an empty relation; see PROGRESS_TRACKER.md for what
 * building the producer would involve.
 */
export function buildPassage(title: {
  name: string;
  overview?: string | null;
  aliases: Array<{ text: string }>;
}): string {
  return [title.name, ...title.aliases.map((alias) => alias.text), title.overview ?? '']
    .filter((part) => part.trim().length > 0)
    .join(' — ');
}
