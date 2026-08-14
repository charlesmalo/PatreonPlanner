/**
 * Manual verification of the real embedding model.
 *
 *   pnpm --filter @app/api verify:embeddings
 *
 * Deliberately not a jest suite. Two reasons: loading the model downloads ~120MB on a cold cache,
 * which does not belong in CI; and onnxruntime's tensors fail jest's typed-array checks because
 * jest runs tests in a separate VM realm where `Float32Array` is a different constructor.
 *
 * This is the only thing that exercises the real provider, so run it before touching
 * `local-embedding.provider.ts` — a dropped prefix or the wrong pooling strategy looks like a
 * no-op everywhere else.
 */
import { ConfigService } from '../src/config/config.module';
import { LocalEmbeddingProvider } from '../src/embeddings/local-embedding.provider';

const cosine = (a: number[], b: number[]) => a.reduce((sum, v, i) => sum + v * b[i], 0);
const magnitude = (v: number[]) => Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));

let failures = 0;
function check(name: string, passed: boolean, detail = ''): void {
  if (passed) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main(): Promise<void> {
  process.env.DATABASE_URL ??= 'postgresql://planner:planner@localhost:5432/planner';
  process.env.REDIS_URL ??= 'redis://localhost:6379';
  process.env.PATREON_CLIENT_ID ??= 'x';
  process.env.PATREON_CLIENT_SECRET ??= 'x';
  process.env.PATREON_REDIRECT_URI ??= 'http://localhost:3000/auth/patreon/callback';
  process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 1).toString('base64');
  process.env.EMBEDDINGS_ENABLED = 'true';

  const config = new ConfigService();
  const provider = new LocalEmbeddingProvider(config);
  console.log(`model: ${provider.modelId()} (first run downloads it)\n`);

  const [spirited] = await provider.embedPassages(['Spirited Away']);
  check('vector has the configured width', spirited.length === config.get('EMBEDDING_DIMENSIONS'));
  check('vector is unit length', Math.abs(magnitude(spirited) - 1) < 0.01);

  // The entire reason for doing any of this: no shared characters, and it still matches.
  const [translation, unrelated] = await provider.embedPassages([
    'Your Name',
    'Accounting Software Tutorial',
  ]);
  const jp = await provider.embedQuery('君の名は。');
  check(
    'a translation is nearer than an unrelated title',
    cosine(jp, translation) > cosine(jp, unrelated),
    `translation=${cosine(jp, translation).toFixed(3)} unrelated=${cosine(jp, unrelated).toFixed(3)}`,
  );

  const [bebop, taxes] = await provider.embedPassages(['Cowboy Bebop', 'Tax Return Guide']);
  const described = await provider.embedQuery('anime about bounty hunters in space');
  check(
    'a description matches the title it describes',
    cosine(described, bebop) > cosine(described, taxes),
    `bebop=${cosine(described, bebop).toFixed(3)} taxes=${cosine(described, taxes).toFixed(3)}`,
  );

  // If the prefixes were silently dropped these would be identical, and the degradation would be
  // invisible — which is exactly why it is asserted rather than assumed.
  const asQuery = await provider.embedQuery('Spirited Away');
  check('query and passage prefixes differ', cosine(spirited, asQuery) < 0.999);

  process.env.EMBEDDINGS_ENABLED = 'false';
  check(
    'reports unconfigured when switched off',
    !new LocalEmbeddingProvider(new ConfigService()).isConfigured(),
  );

  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
