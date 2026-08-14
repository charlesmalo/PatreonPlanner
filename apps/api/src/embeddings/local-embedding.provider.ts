import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '../config/config.module';
import { EmbeddingProvider } from './embedding.provider';

type Pipeline = (
  texts: string[],
  options: { pooling: 'mean'; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

@Injectable()
export class LocalEmbeddingProvider implements EmbeddingProvider {
  private readonly logger = new Logger(LocalEmbeddingProvider.name);
  private pipeline?: Pipeline;
  private loading?: Promise<Pipeline | null>;
  /** Set when the model could not be loaded, so the failure is reported once and not per call. */
  private unavailable = false;

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return this.config.get('EMBEDDINGS_ENABLED') && !this.unavailable;
  }

  modelId(): string {
    return this.config.get('EMBEDDING_MODEL');
  }

  /**
   * The e5 family is trained with these prefixes and they are not decoration — dropping them
   * measurably degrades retrieval while looking like a no-op, which is the worst kind of bug to
   * leave for someone else.
   */
  async embedPassages(texts: string[]): Promise<number[][]> {
    return this.run(texts.map((text) => `passage: ${text}`));
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vector] = await this.run([`query: ${text}`]);
    return vector;
  }

  private async run(inputs: string[]): Promise<number[][]> {
    const pipeline = await this.load();
    if (!pipeline) throw new Error('Embedding model is unavailable');
    // Mean pooling and normalisation: e5 expects both, and normalised vectors make cosine
    // distance a plain dot product for pgvector.
    const output = await pipeline(inputs, { pooling: 'mean', normalize: true });
    return output.tolist();
  }

  /** Loaded lazily and once: it costs seconds, and nothing on the request path needs it. */
  private load(): Promise<Pipeline | null> {
    if (this.pipeline) return Promise.resolve(this.pipeline);
    this.loading ??= (async () => {
      try {
        // Imported dynamically so the package — and its native bits — are not pulled in at boot
        // by deployments that leave embeddings off.
        const { pipeline } = await import('@huggingface/transformers');
        const extractor = (await pipeline(
          'feature-extraction',
          this.modelId(),
        )) as unknown as Pipeline;
        this.pipeline = extractor;
        this.logger.log(`Embedding model ready: ${this.modelId()}`);
        return extractor;
      } catch (error) {
        // Once. A model that cannot load is a permanent condition until restart, and semantic
        // search is an improvement on a working feature rather than a dependency of it.
        this.unavailable = true;
        this.logger.error(
          `Embedding model unavailable, falling back to trigram search only: ${
            (error as Error).message
          }`,
        );
        return null;
      }
    })();
    return this.loading;
  }
}
