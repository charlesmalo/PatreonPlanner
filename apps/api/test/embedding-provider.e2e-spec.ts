import { ConfigService } from '../src/config/config.module';
import { LocalEmbeddingProvider } from '../src/embeddings/local-embedding.provider';
import { applyTestConfigDefaults } from './support/env';

// The model is loaded through a dynamic import so that deployments with embeddings off never pull
// in the native runtime. Mocking it here makes the failure path deterministic: the real thing
// fetches ~120MB over the network, which is neither fast nor reliable enough to assert on.
const loadModel = jest.fn();
jest.mock('@huggingface/transformers', () => ({
  pipeline: (...args: unknown[]) => loadModel(...args),
}));

/**
 * The real model is exercised by `pnpm --filter @app/api verify:embeddings`, which is a manual
 * script rather than a suite. What is worth pinning here is the wiring around it — above all what
 * happens when it will not load, since that decides whether search degrades or disappears.
 */
describe('LocalEmbeddingProvider', () => {
  beforeAll(() => {
    process.env.DATABASE_URL = 'postgresql://planner:planner@localhost:5432/planner';
    process.env.REDIS_URL = 'redis://localhost:6379';
    applyTestConfigDefaults();
  });

  afterEach(() => {
    loadModel.mockReset();
    jest.restoreAllMocks();
    delete process.env.EMBEDDING_MODEL;
  });

  const provider = (enabled = true) => {
    process.env.EMBEDDINGS_ENABLED = String(enabled);
    return new LocalEmbeddingProvider(new ConfigService());
  };

  it('reports unconfigured when embeddings are switched off', () => {
    expect(provider(false).isConfigured()).toBe(false);
  });

  it('reports configured when they are on and nothing has failed yet', () => {
    expect(provider().isConfigured()).toBe(true);
  });

  it('reports the configured model id, which is stored beside every vector it produces', () => {
    process.env.EMBEDDING_MODEL = 'some/other-model';
    expect(provider().modelId()).toBe('some/other-model');
  });

  it('prefixes passages and queries the way e5 was trained to expect', async () => {
    const seen: string[][] = [];
    loadModel.mockResolvedValue(async (inputs: string[]) => {
      seen.push(inputs);
      return { tolist: () => inputs.map(() => [0.1, 0.2]) };
    });
    const instance = provider();

    await instance.embedPassages(['Cowboy Bebop']);
    await instance.embedQuery('space bounty hunters');

    // Asymmetric on purpose: e5 scores a query against a passage, and dropping the prefixes
    // degrades retrieval while looking like a harmless simplification.
    expect(seen[0]).toEqual(['passage: Cowboy Bebop']);
    expect(seen[1]).toEqual(['query: space bounty hunters']);
  });

  it('loads the model once and reuses it across calls', async () => {
    loadModel.mockResolvedValue(async (inputs: string[]) => ({
      tolist: () => inputs.map(() => [0.1, 0.2]),
    }));
    const instance = provider();

    await Promise.all([instance.embedQuery('a'), instance.embedQuery('b')]);
    await instance.embedQuery('c');

    expect(loadModel).toHaveBeenCalledTimes(1);
  });

  it('backs off after a load failure rather than staying broken until restart', async () => {
    // A model that will not load is usually a transient condition — a cold container, a blocked
    // egress route, a slow mirror. Disabling semantic search permanently in response to one is a
    // permanent consequence for a temporary cause.
    loadModel.mockRejectedValue(new Error('network unreachable'));
    const instance = provider();

    await expect(instance.embedQuery('anything')).rejects.toThrow('unavailable');
    expect(instance.isConfigured()).toBe(false);

    const failedAt = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(failedAt + 11 * 60 * 1000);
    expect(instance.isConfigured()).toBe(true);

    // ...and the retry is a real one: the loader is asked again, not served a cached failure.
    loadModel.mockResolvedValue(async (inputs: string[]) => ({
      tolist: () => inputs.map(() => [0.3, 0.4]),
    }));
    await expect(instance.embedQuery('anything')).resolves.toEqual([0.3, 0.4]);
  });
});
