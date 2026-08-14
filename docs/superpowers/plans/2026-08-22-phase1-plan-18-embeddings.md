# Semantic Search via Local Embeddings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish design §5's "already submitted?" — a patron typing "Your Name" finds 君の名は。 even when nobody wrote that alias, and "space cowboys" finds *Cowboy Bebop*.

**Architecture:** An `EmbeddingProvider` interface with a **local ONNX model** behind it — free, no key, nothing leaves the box, which is the standing constraint. Vectors live on `Title` in a pgvector column beside the model that produced them, because vectors from different models are not comparable and rotating one has to be a re-embed rather than a silent corruption. Search fuses the trigram ranking already shipped with a vector ranking by reciprocal rank, since the two scores mean different things and normalising them would invent a comparison.

**Tech Stack:** `@huggingface/transformers` (Apache-2.0, runs ONNX in-process), pgvector (already installed), NestJS 10, Postgres. **No key, no vendor, no per-call cost.**

## Global Constraints

- **Free.** No hosted embedding API, no paid tier. The model runs in the API process.
- **A missing or unloadable model degrades to trigram-only search.** Semantic matching is an improvement on a working feature, never a dependency of it.
- **Embedding happens in the background job, never on a request.** Inference is tens to hundreds of milliseconds on CPU; the submit path is already the slowest thing in the product.
- **Every vector records the model that produced it.** Rotation is then a re-embed the job performs, not a set of vectors that silently stopped meaning the same thing.
- **CI must not download a model.** Suites use a fake provider, like every other external dependency here.

## Scope

**In scope:** the provider interface and its local implementation, the vector column with model tracking and an HNSW index, a background embedding job, and semantic candidates fused into the existing board search.

**Out of scope — deliberately deferred, with the reason:**

- **Personalised ranking from upvote history** (design §5) → needs a per-user vector built from what they have upvoted, plus a decision about how much it should move the ordering. That is a product question about how much the board should differ per person, and nobody has answered it.
- **Embedding-driven `TitleRelation`** (design §5's "`RELATED` from … embedding proximity") → the relation table already carries `RELATED` from TMDB's own similar list. Adding a second producer needs a policy for which wins, and the read model does not use `RELATED` for anything yet.
- **Theme clustering** (design §5) → clustering needs vectors to exist first and a decision about cluster granularity.
- **Embedding recommendation descriptions** → titles are identity, descriptions are commentary, and the same reasoning that kept descriptions out of trigram search applies here.

## Decisions this plan settles

**A local ONNX model, not a hosted API.** The standing constraint is free, and this is the only route that stays free at any volume. The cost is memory: `multilingual-e5-small` is ~120MB on disk and ~250–400MB resident. On the 16–32GB target that is noise.

**`EMBEDDING_MODEL` and `EMBEDDING_DIMENSIONS` are configuration, and every row records which model wrote it.** Rotating to a larger model — `multilingual-e5-base` at 768 dimensions, say — is then: change the setting, run a migration if the dimension changed, and the job re-embeds everything whose recorded model no longer matches. Without the recorded model, a rotation would leave two incomparable vector spaces in one column and quietly wrong results with no error anywhere.

**Cosine distance, and the e5 prefixes are not optional.** The e5 family is trained with `query: ` and `passage: ` prefixes and produces normalised vectors; omitting the prefixes measurably degrades retrieval, and it is the kind of detail that looks like a no-op and is not.

**Trigram and vector candidates are fused by reciprocal rank, not by score.** A trigram similarity of 0.4 and a cosine distance of 0.4 have no relationship to each other, so any weighted sum is a number nobody can justify. Reciprocal rank fusion combines *orderings*, needs no normalisation, and degrades to "whatever one arm returned" when the other is empty — which is exactly the behaviour wanted when the model is unavailable.

**The model is loaded lazily and once.** Loading costs seconds; doing it at boot delays readiness for a feature that is not on the request path, and doing it per call is unusable.

---

## Task 1: The provider

**Files:**

- Create: `apps/api/src/embeddings/embedding.provider.ts`, `apps/api/src/embeddings/local-embedding.provider.ts`, `apps/api/src/embeddings/embeddings.module.ts`
- Modify: `apps/api/src/config/config.schema.ts`, `apps/api/package.json`
- Test: `apps/api/test/local-embedding.opt-spec.ts` (opt-in), `apps/api/test/support/fake-embedding.provider.ts`

**Interfaces:**

```ts
export const EMBEDDING_PROVIDER = Symbol('EMBEDDING_PROVIDER');

export interface EmbeddingProvider {
  isConfigured(): boolean;
  /** The model id stored beside every vector it produces. */
  modelId(): string;
  embedPassages(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}
```

Config: `EMBEDDINGS_ENABLED` (default `false`), `EMBEDDING_MODEL` (default
`Xenova/multilingual-e5-small`), `EMBEDDING_DIMENSIONS` (default `384`).

- [ ] **Step 1: Write the failing tests**

The real model is **not** exercised in CI — downloading 120MB per run is slow, flaky and pointless
when every other external dependency here is faked. The opt-in spec runs under
`EMBEDDINGS_REAL=1`:

```ts
it('produces a unit-length vector of the configured width', async () => {
  const [vector] = await provider.embedPassages(['Spirited Away']);
  expect(vector).toHaveLength(384);
  expect(magnitude(vector)).toBeCloseTo(1, 2);
});

it('places a translation nearer than an unrelated title', async () => {
  // The entire reason for doing this at all.
  const [name, unrelated] = await provider.embedPassages(['Your Name', 'Accounting Software']);
  const query = await provider.embedQuery('君の名は。');
  expect(cosine(query, name)).toBeGreaterThan(cosine(query, unrelated));
});

it('applies the e5 prefixes, which are not decoration', async () => {
  // Prefixed and unprefixed embeddings of the same text differ; if they did not, the prefix was
  // silently dropped.
  ...
});

it('reports not configured when embeddings are off', () => { ... });
```

- [ ] **Step 2: Implement, run the opt-in spec locally, commit**

The pipeline is created on first use and memoised. A failure to load is logged once and
`isConfigured()` turns false, so the rest of the system degrades rather than throwing per call.

---

## Task 2: Storage

**Files:**

- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260822000000_title_embedding/migration.sql`

Prisma has no `vector` type, so the column is added in raw SQL and the model carries the
bookkeeping fields only:

```prisma
model Title {
  // ...
  /// Which model produced `embedding`. Null until embedded; compared against the configured
  /// model so a rotation re-embeds rather than mixing incomparable vector spaces.
  embeddingModel String?
  embeddedAt     DateTime?
  @@index([embeddingModel])
}
```

```sql
ALTER TABLE "Title" ADD COLUMN "embedding" vector(384);
ALTER TABLE "Title" ADD COLUMN "embeddingModel" TEXT;
ALTER TABLE "Title" ADD COLUMN "embeddedAt" TIMESTAMP(3);

-- Partial: only embedded rows are searchable, and the index should not carry the rest.
CREATE INDEX "Title_embedding_idx" ON "Title"
  USING hnsw ("embedding" vector_cosine_ops) WHERE "embedding" IS NOT NULL;

-- The job walks un-embedded and stale-model rows.
CREATE INDEX "Title_embeddingModel_idx" ON "Title" ("embeddingModel");
```

Rotating to a different dimension needs one more migration altering the column type — documented,
not automated, because dropping and rebuilding an HNSW index is an operation someone should choose
deliberately.

- [ ] **Steps: add, `migrate deploy`, `migrate reset --force`, commit**

---

## Task 3: The embedding job

**Files:**

- Create: `apps/api/src/jobs/embed-titles.job.ts`
- Modify: `apps/api/src/jobs/jobs.module.ts`
- Test: `apps/api/test/embedding.int-spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('embeds titles that have never been embedded', async () => { ... });

it('re-embeds a title whose model no longer matches the configured one', async () => {
  // A rotation must be a re-embed, not two incomparable vector spaces in one column.
  await prisma.title.update({ where: { id }, data: { embeddingModel: 'old/model' } });
  await job.runOnce();
  expect((await title(id)).embeddingModel).toBe(fake.modelId());
});

it('leaves an up-to-date title alone', async () => { ... });

it('stops at the batch size', async () => { ... });

it('does nothing when embeddings are disabled', async () => { ... });

it('keeps going when one title fails', async () => { ... });

it('embeds the name and its aliases together, not the name alone', async () => {
  // The aliases are what carry the other-language surface forms.
  ...
});

it('writes a vector Postgres accepts as the right width', async () => {
  // A dimension mismatch is a 500 from Postgres at write time, not a silent shrug.
  ...
});
```

- [ ] **Step 2: Run, watch fail, implement, commit**

Batched: one `embedPassages` call for the whole batch, since transformer inference amortises
heavily across a batch. Written with `$executeRaw` because Prisma cannot express a vector literal.

---

## Task 4: Semantic candidates in search

**Files:**

- Modify: `apps/api/src/recommendations/search.service.ts`
- Test: `apps/api/test/board-search.int-spec.ts` (extend)

- [ ] **Step 1: Write the failing test**

```ts
it('finds a title by meaning when no letters match', async () => {
  // The whole point: no trigram overlap whatsoever between the query and the stored title.
  const res = await search(patron, 'space cowboys').expect(200);
  expect(ids(res.body)).toContain(bebopId);
});

it('still finds trigram matches when the model is unavailable', async () => {
  fakeEmbeddings.configured = false;
  expect(ids((await search(patron, 'sprited away').expect(200)).body)).toContain(spiritedId);
});

it('ranks a title matched by both arms above one matched by either', async () => {
  // Reciprocal rank fusion: appearing in both orderings should win.
  ...
});

it('applies the same visibility rules to semantic candidates', async () => {
  // The arm is new; the rule is not. A rejected entry must not arrive by a different route.
  ...
});

it('never returns another creator entries by semantic match', async () => { ... });
```

The visibility and tenancy assertions matter most: a new candidate source is a new way to bypass
the filter if the ids do not go through the same read model.

- [ ] **Step 2: Run, watch fail, implement, commit**

---

## Task 5: Verification and documentation

- [ ] **Step 1: Full verification**

```bash
pnpm -r typecheck && pnpm -r test && pnpm format:check
EMBEDDINGS_REAL=1 pnpm --filter @app/api test -- local-embedding   # locally, once
docker-compose -f docker-compose.e2e.yml up -d --build && pnpm --filter e2e e2e
```

- [ ] **Step 2: Document in the README** — the memory cost, how to rotate models, that the real
  provider is only verified by an opt-in spec, and that the model downloads on first use.

---

## Self-Review

**Spec coverage (design §5 Catalog Intelligence, "Already submitted?"):**

- "each title+description vectorized" → Task 3, **titles and aliases**, not descriptions, with the reason in Scope. Partial, and stated.
- "powers semantic de-dupe" → Task 4. ✅
- "(semantic, cross-language)" → Task 1's translation test is the assertion that this works at all. ✅
- "related titles" → **deferred**: `TitleRelation.RELATED` already has a producer, and nothing reads it.
- "per-user personalized ranking from upvote history" → **deferred**, with the reason in Scope.
- "off-the-shelf embeddings … no bespoke model training" → satisfied literally. ✅

**Known risks:**

1. **The real provider is not exercised in CI.** Every test that runs on every commit uses a fake, so a change to the local implementation — a dropped prefix, a wrong pooling strategy — fails only in the opt-in spec somebody has to remember to run. This is the honest cost of not downloading a model per CI run, and it is a real gap rather than a clever trade.
2. **First use downloads the model.** A cold container with no network cannot embed; the job logs and degrades, but a deployment that never has egress will never embed anything, silently, until someone looks at `embeddedAt`.
3. **Inference is CPU-bound in the API process.** At 16–32GB this is about CPU contention rather than memory: a large embedding backlog competes with request handling. The batch size is the only control, and it is a guess until someone measures.
4. **Rotating dimensions is a manual migration.** Changing `EMBEDDING_MODEL` to one of a different width without altering the column produces write errors from Postgres on every embed — loud, but only once the job runs.
5. **Reciprocal rank fusion has a constant nobody has tuned.** `k = 60` is the value from the original paper; whether it suits a board of a few hundred entries is unmeasured.
