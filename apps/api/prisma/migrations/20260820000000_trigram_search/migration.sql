-- Design §5's "already submitted?" search. A contrib extension, already present in the
-- pgvector/pgvector image — no vendor, no key, no per-call cost.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- GIN over the de-duplication key, which is already lowercased and punctuation-stripped, so
-- "The Matrix!" and "the matrix" are one trigram target rather than two.
CREATE INDEX "Recommendation_normalizedTitle_trgm_idx"
  ON "Recommendation" USING GIN ("normalizedTitle" gin_trgm_ops);

-- Aliases carry TMDB's translations, which is the only cross-language matching available without
-- an embedding model.
CREATE INDEX "TitleAlias_text_trgm_idx" ON "TitleAlias" USING GIN ("text" gin_trgm_ops);
