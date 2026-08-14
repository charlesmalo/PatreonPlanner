import type { EmbeddingProvider } from '../../src/embeddings/embedding.provider';

/**
 * Deterministic stand-in. The real model is never loaded in CI — downloading 120MB per run is
 * slow and flaky, and every other external capability here is faked the same way.
 *
 * Vectors are hashed from the text, so identical text embeds identically and different text
 * embeds differently. `near()` lets a suite declare that two strings should be close without
 * pretending to model meaning.
 */
export class FakeEmbeddingProvider implements EmbeddingProvider {
  configured = true;
  model = 'fake/model';
  calls = 0;
  failOn?: string;
  /** Texts declared semantically equivalent: they receive the same vector. */
  readonly synonyms = new Map<string, string>();

  isConfigured(): boolean {
    return this.configured;
  }

  modelId(): string {
    return this.model;
  }

  async embedPassages(texts: string[]): Promise<number[][]> {
    this.calls += 1;
    for (const text of texts) {
      if (this.failOn && text.includes(this.failOn)) throw new Error('embedding failed');
    }
    return texts.map((text) => this.vector(text));
  }

  async embedQuery(text: string): Promise<number[]> {
    this.calls += 1;
    return this.vector(text);
  }

  /** Declares two texts equivalent, so a suite can assert semantic matching without a model. */
  near(a: string, b: string): void {
    this.synonyms.set(a.toLowerCase(), b.toLowerCase());
  }

  private vector(raw: string): number[] {
    const text = raw.replace(/^(passage|query): /, '').toLowerCase();
    const canonical = this.synonyms.get(text) ?? text;
    const vector = new Array(384).fill(0);
    for (let i = 0; i < canonical.length; i += 1) {
      vector[(canonical.charCodeAt(i) * 7 + i) % 384] += 1;
    }
    const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
    return vector.map((v) => v / magnitude);
  }
}
