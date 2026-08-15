export const EMBEDDING_PROVIDER = Symbol('EMBEDDING_PROVIDER');

/**
 * Design §5's embeddings, behind an interface like every other external capability here — except
 * this one has no vendor: the model runs in-process, which is what keeps it free.
 */
export interface EmbeddingProvider {
  /** False when disabled or the model could not load; callers degrade to trigram-only search. */
  isConfigured(): boolean;
  /**
   * Stored beside every vector this produces. Vectors from different models are not comparable,
   * so a rotation has to be a re-embed rather than a column that quietly stops meaning one thing.
   */
  modelId(): string;
  /** For stored text: e5 expects a different prefix here than for a query. */
  embedPassages(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}
