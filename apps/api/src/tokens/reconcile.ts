import { Prisma, PrismaClient } from '@prisma/client';

export interface LedgerDiscrepancy {
  creatorId: string;
  userId: string;
  /** What the balance row says. `null` when there is no balance row at all. */
  available: number | null;
  /** What the ledger adds up to. `null` when the reader has no ledger rows. */
  ledgerSum: number | null;
}

/**
 * Every balance this board holds, checked against the rows that are supposed to explain it.
 *
 * The ledger is the record and `TokenBalance.available` is a cache of its sum — kept only so
 * spending can be one conditional decrement instead of an aggregate read. Two writes maintain
 * that invariant (`grantDue`, `grantDirect`) and one consumes it (`spend`), each inside a
 * transaction; a bug in any of them, or a hand-edit in psql, silently desynchronises the two
 * and nothing in the product notices. A patron would see a number that is not their tokens.
 *
 * A FULL OUTER JOIN rather than a scan of balances, because the two interesting failures are on
 * opposite sides of it: a balance with no ledger behind it is minted from nowhere, and a ledger
 * with no balance row is tokens a reader was granted and cannot spend.
 *
 * Reads only. It reports, and a person decides — an automatic repair would have to guess which
 * side is wrong, and the ledger being authoritative is a design decision, not something a
 * cleanup script should assert at 4am.
 */
export async function findLedgerDiscrepancies(
  prisma: PrismaClient | Prisma.TransactionClient,
  creatorId?: string,
): Promise<LedgerDiscrepancy[]> {
  // Appended to an existing WHERE, never replacing it: an empty fragment in the leading
  // position leaves a dangling AND, which is a syntax error and not a query returning nothing.
  const scope = creatorId
    ? Prisma.sql`AND COALESCE(b."creatorId", l."creatorId") = ${creatorId}::uuid`
    : Prisma.empty;

  const rows = await prisma.$queryRaw<
    Array<{ creatorId: string; userId: string; available: number | null; ledgerSum: bigint | null }>
  >(Prisma.sql`
    SELECT
      COALESCE(b."creatorId", l."creatorId") AS "creatorId",
      COALESCE(b."userId", l."userId")       AS "userId",
      b."available"                          AS "available",
      l."ledgerSum"                          AS "ledgerSum"
    FROM "TokenBalance" b
    FULL OUTER JOIN (
      SELECT "creatorId", "userId", SUM("amount") AS "ledgerSum"
      FROM "TokenLedger"
      GROUP BY "creatorId", "userId"
    ) l ON l."creatorId" = b."creatorId" AND l."userId" = b."userId"
    -- A missing row on either side is a discrepancy in itself, so the comparison has to treat
    -- absence as a value rather than letting NULL swallow the inequality. That is exactly what
    -- IS DISTINCT FROM does, and why there is no sentinel here: a sentinel would have to be a
    -- number a balance could never hold, and there isn't one.
    WHERE b."available" IS DISTINCT FROM l."ledgerSum"
    ${scope}
    ORDER BY "creatorId", "userId"
  `);

  // SUM() comes back as bigint from Postgres; these are counts of tokens, far inside a number.
  return rows.map((row) => ({
    creatorId: row.creatorId,
    userId: row.userId,
    available: row.available,
    ledgerSum: row.ledgerSum === null ? null : Number(row.ledgerSum),
  }));
}
