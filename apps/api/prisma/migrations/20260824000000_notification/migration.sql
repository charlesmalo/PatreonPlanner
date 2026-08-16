CREATE TYPE "NotificationType" AS ENUM ('ENTRY_STATUS_CHANGED', 'ENTRY_FLAGGED');

CREATE TABLE "Notification" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "creatorId" UUID NOT NULL,
    "type" "NotificationType" NOT NULL,
    -- A snapshot rather than a foreign key: the message has to keep being true after the entry it
    -- describes is deleted, retitled, or moved somewhere this reader can no longer see.
    "payload" JSONB NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_creatorId_fkey"
    FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The list is keyset-paginated newest first, which is the only way it is ever read.
CREATE INDEX "Notification_userId_createdAt_id_idx"
    ON "Notification"("userId", "createdAt" DESC, "id" DESC);

-- The badge asks for this on every poll from every signed-in reader, and unread rows are a small
-- fraction of the table.
CREATE INDEX "Notification_unread_idx" ON "Notification"("userId") WHERE "readAt" IS NULL;
