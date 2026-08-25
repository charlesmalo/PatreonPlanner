ALTER TABLE "CreatorPolicy" ADD COLUMN "allowReactions" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "Reaction" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "recommendationId" UUID,
    "noteId" UUID,
    "emote" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Reaction_pkey" PRIMARY KEY ("id"),
    -- Exactly one subject. Two nullable columns rather than a polymorphic (type, id) pair,
    -- because a polymorphic pair carries no foreign key: deleting an entry would leave orphaned
    -- reactions and nothing would notice.
    CONSTRAINT "Reaction_one_subject" CHECK (
        ("recommendationId" IS NOT NULL AND "noteId" IS NULL)
     OR ("recommendationId" IS NULL AND "noteId" IS NOT NULL)
    )
);

ALTER TABLE "Reaction" ADD CONSTRAINT "Reaction_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Reaction" ADD CONSTRAINT "Reaction_recommendationId_fkey"
    FOREIGN KEY ("recommendationId") REFERENCES "Recommendation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Reaction" ADD CONSTRAINT "Reaction_noteId_fkey"
    FOREIGN KEY ("noteId") REFERENCES "CreatorNote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One of each emote per person per subject; sending it again takes it back.
CREATE UNIQUE INDEX "Reaction_recommendationId_userId_emote_key"
    ON "Reaction"("recommendationId", "userId", "emote");
CREATE UNIQUE INDEX "Reaction_noteId_userId_emote_key"
    ON "Reaction"("noteId", "userId", "emote");
CREATE INDEX "Reaction_recommendationId_idx" ON "Reaction"("recommendationId");
CREATE INDEX "Reaction_noteId_idx" ON "Reaction"("noteId");
CREATE INDEX "Reaction_userId_idx" ON "Reaction"("userId");
