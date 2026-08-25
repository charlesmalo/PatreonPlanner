CREATE TYPE "TicketStatus" AS ENUM ('OPEN', 'RESOLVED');
CREATE TYPE "TicketResolution" AS ENUM ('CONFIRMED', 'DENIED', 'LINKED', 'CLOSED');

-- Off by default: a public contact form on a public board is the highest-value spam target
-- in the app.
ALTER TABLE "CreatorPolicy" ADD COLUMN "allowAnonymousTickets" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "Ticket" (
    "id" UUID NOT NULL,
    "creatorId" UUID NOT NULL,
    "raisedByUserId" UUID,
    "subjectId" UUID,
    "body" TEXT NOT NULL,
    "status" "TicketStatus" NOT NULL DEFAULT 'OPEN',
    "resolution" "TicketResolution",
    "reply" TEXT,
    "resolvedByUserId" UUID,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_creatorId_fkey"
    FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- SetNull, not Cascade: a ticket outlives both the entry it disputes and the account that
-- raised it. The reader's own words are the substance; the card is context.
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_raisedByUserId_fkey"
    FOREIGN KEY ("raisedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_subjectId_fkey"
    FOREIGN KEY ("subjectId") REFERENCES "Recommendation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_resolvedByUserId_fkey"
    FOREIGN KEY ("resolvedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The inbox reads open tickets for one board, oldest first, so nothing rots.
CREATE INDEX "Ticket_creatorId_status_createdAt_idx" ON "Ticket"("creatorId", "status", "createdAt");
CREATE INDEX "Ticket_subjectId_idx" ON "Ticket"("subjectId");
CREATE INDEX "Ticket_raisedByUserId_idx" ON "Ticket"("raisedByUserId");
