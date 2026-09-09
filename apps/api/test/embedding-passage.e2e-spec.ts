import {
  PASSAGE_VERSION,
  buildPassage,
  embeddingSignature,
} from '../src/embeddings/passage';

/**
 * The text that becomes a vector, and the version that forces a re-embed when it changes.
 */
describe('embedding passages', () => {
  it('includes what a title is about, not only what it is called', () => {
    // Under the previous recipe a plot description measured further from its own entry than
    // gibberish did, because the plot was nowhere in the vector.
    const passage = buildPassage({
      name: 'Spirited Away',
      overview: 'A girl wanders into a world of spirits.',
      aliases: [{ text: '千と千尋の神隠し' }],
    });

    expect(passage).toContain('Spirited Away');
    expect(passage).toContain('千と千尋の神隠し');
    expect(passage).toContain('world of spirits');
  });

  it('leaves out the parts a title does not have', () => {
    // An empty segment is not free: it becomes a dangling separator the model has to account for.
    expect(buildPassage({ name: 'Solo', overview: null, aliases: [] })).toBe('Solo');
    expect(buildPassage({ name: 'Solo', overview: '   ', aliases: [] })).toBe('Solo');
  });

  it('signs the recipe as well as the model', () => {
    // A row embedded from different text lives in a different space just as surely as one embedded
    // by a different model, and the column has to be able to tell.
    expect(embeddingSignature('some/model')).toBe(`some/model#${PASSAGE_VERSION}`);
    expect(embeddingSignature('some/model')).not.toBe('some/model');
  });
});
