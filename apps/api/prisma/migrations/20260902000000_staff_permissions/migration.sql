CREATE TYPE "StaffPermission" AS ENUM (
    'MOVE_ENTRIES', 'EDIT_ENTRIES', 'HANDLE_REPORTS', 'WRITE_NOTES', 'MANAGE_THEMES'
);

ALTER TABLE "CreatorStaff" ADD COLUMN "permissions" "StaffPermission"[] NOT NULL DEFAULT '{}';

-- Existing moderators keep everything they could do yesterday. Fail-closed is the rule for
-- *new* permissions; silently stripping working moderators of powers they already had is a
-- different thing, and would break live boards to satisfy a principle about future grants.
UPDATE "CreatorStaff"
   SET "permissions" = ARRAY['MOVE_ENTRIES','EDIT_ENTRIES','HANDLE_REPORTS','WRITE_NOTES','MANAGE_THEMES']::"StaffPermission"[]
 WHERE "role" = 'MOD';
