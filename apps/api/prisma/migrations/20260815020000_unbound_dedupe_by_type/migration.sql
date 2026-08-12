-- The unbound de-dupe key had no `type` column, which was harmless while EXTERNAL_LINK was the
-- only unbound class. WATCH_ORDER is the second, and without this a watch order named the same as
-- an existing link resolves to that link: the submitter is told "already on the board", their
-- steps are silently discarded, and they are handed a link card in reply.
DROP INDEX "Recommendation_creatorId_normalizedTitle_key";

CREATE UNIQUE INDEX "Recommendation_creatorId_normalizedTitle_type_key"
  ON "Recommendation"("creatorId", "normalizedTitle", "type")
  WHERE "titleId" IS NULL AND "status" <> 'DELETED';
