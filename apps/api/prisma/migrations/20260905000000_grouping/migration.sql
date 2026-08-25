-- Chosen by staff, unlike the nesting the board derives from TMDB collections — that is keyed on
-- titleId, cannot express a decision, and cannot reach an external link at all.
ALTER TABLE "Recommendation" ADD COLUMN "groupHeadId" UUID;

-- SetNull, not Cascade: deleting a head releases its children rather than taking them with it.
-- Grouping preserves; that is what separates it from a merge.
ALTER TABLE "Recommendation" ADD CONSTRAINT "Recommendation_groupHeadId_fkey"
    FOREIGN KEY ("groupHeadId") REFERENCES "Recommendation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Recommendation_groupHeadId_idx" ON "Recommendation"("groupHeadId");
