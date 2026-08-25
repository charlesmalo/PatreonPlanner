-- Added rather than replaced: an enum value cannot be removed without rewriting every row that
-- uses it, and both existing values are in live use.
ALTER TYPE "NotificationType" ADD VALUE 'TICKET_RAISED';
ALTER TYPE "NotificationType" ADD VALUE 'TICKET_RESOLVED';
