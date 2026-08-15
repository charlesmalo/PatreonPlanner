-- Prisma has no `vector` type, so the column itself is raw. The width must match
-- EMBEDDING_DIMENSIONS; rotating to a model of a different width needs a follow-up migration
-- altering this column and rebuilding the index, which is deliberately a manual decision.
ALTER TABLE "Title" ADD COLUMN "embedding" vector(384);
ALTER TABLE "Title" ADD COLUMN "embeddingModel" TEXT;
ALTER TABLE "Title" ADD COLUMN "embeddedAt" TIMESTAMP(3);

-- Partial: only embedded rows are searchable, and the index should not carry the rest.
CREATE INDEX "Title_embedding_idx" ON "Title"
  USING hnsw ("embedding" vector_cosine_ops) WHERE "embedding" IS NOT NULL;

-- The job walks rows with no vector or a model that no longer matches the configured one.
CREATE INDEX "Title_embeddingModel_idx" ON "Title" ("embeddingModel");
