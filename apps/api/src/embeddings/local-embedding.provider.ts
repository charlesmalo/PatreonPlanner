import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '../config/config.module';
import { EmbeddingProvider } from './embedding.provider';

/** How long to wait before trying to load the model again after a failure. */
const LOAD_RETRY_MS = 10 * 60 * 1000;

type Pipeline = (
  texts: string[],
  options: { pooling: 'mean'; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

@Injectable()
export class LocalEmbeddingProvider implements EmbeddingProvider {
  private readonly logger = new Logger(LocalEmbeddingProvider.name);
  private pipeline?: Pipeline;
  private loading?: Promise<Pipeline | null>;
  /**
   * When to try loading again after a failure. The model is fetched over the network on first
   * use, so a blip at exactly the wrong moment would otherwise disable semantic search until
   * someone restarted the process — a permanent consequence for a transient cause.
   */
  private retryAfter = 0;

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    if (!this.config.get('EMBEDDINGS_ENABLED')) return false;
    return this.pipeline !== undefined || Date.now() >= this.retryAfter;
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
        const { pipeline, env } = await import('@huggingface/transformers');
        // Set before the pipeline is built, because that is when the download happens.
        // Transformers caches inside its own package directory by default, which is under
        // node_modules and not writable by the `node` user the image runs as — so every load
        // failed with EACCES and search silently fell back to trigram.
        env.cacheDir = this.config.get('EMBEDDING_CACHE_DIR');
        const extractor = (await pipeline(
          'feature-extraction',
          this.modelId(),
        )) as unknown as Pipeline;
        this.pipeline = extractor;
        this.logger.log(`Embedding model ready: ${this.modelId()}`);
        return extractor;
      } catch (error) {
        // Backed off, not given up on. Degrading to trigram-only is right — semantic search is an
        // improvement on a working feature rather than a dependency of it — but degrading until
        // someone restarts the process, because one model download happened to fail, is not.
        this.retryAfter = Date.now() + LOAD_RETRY_MS;
        this.loading = undefined;
        this.logger.error(
          `Embedding model unavailable, using trigram search only; retrying in ${
            LOAD_RETRY_MS / 60_000
          } minutes: ${(error as Error).message}`,
        );
        return null;
      }
    })();
    return this.loading;
  }
}
