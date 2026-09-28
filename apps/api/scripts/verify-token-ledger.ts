/**
 * Checks every token balance against the ledger rows that explain it.
 *
 *   pnpm --filter @app/api verify:tokens
 *
 * Run it against a real database — a copy of production is the point. `TokenBalance.available`
 * is a cache of `SUM(TokenLedger.amount)`, and nothing in the product notices when the two
 * drift: a patron just sees a number that is not their tokens.
 *
 * Reports only. Repairing would mean choosing a side automatically, and which side is right
 * depends on how the drift happened — the ledger is the record, but a missing ledger row is not
 * an instruction to confiscate somebody's tokens.
 */
import { PrismaClient } from '@prisma/client';
import { findLedgerDiscrepancies } from '../src/tokens/reconcile';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const creatorId = process.argv[2];
    const rows = await findLedgerDiscrepancies(prisma, creatorId);
    const scope = creatorId ? `creator ${creatorId}` : 'all boards';

    if (rows.length === 0) {
      const checked = await prisma.tokenBalance.count(
        creatorId ? { where: { creatorId } } : undefined,
      );
      console.log(`ok — ${checked} balance(s) on ${scope} match their ledger`);
      return;
    }

    console.error(`${rows.length} discrepancy(ies) on ${scope}:\n`);
    for (const row of rows) {
      const available = row.available === null ? 'no balance row' : String(row.available);
      const sum = row.ledgerSum === null ? 'no ledger rows' : String(row.ledgerSum);
      console.error(
        `  creator=${row.creatorId} user=${row.userId}  balance=${available}  ledger=${sum}`,
      );
    }
    console.error('\nThe ledger is the record. Decide each case before writing anything.');
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main();
