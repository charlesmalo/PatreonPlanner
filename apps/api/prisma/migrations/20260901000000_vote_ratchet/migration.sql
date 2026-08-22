-- On by default: the ratchet is the incentive the weights exist to create, and a board that
-- would rather rank on current support can turn it off.
ALTER TABLE "CreatorPolicy" ADD COLUMN "allowVoteRatchet" BOOLEAN NOT NULL DEFAULT true;
