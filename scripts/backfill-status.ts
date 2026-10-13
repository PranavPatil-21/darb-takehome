/**
 * Recompute `Transaction.documentationStatus` for every charge.
 *
 * The reconciliation job the derivation's own comment asked for before it would accept a
 * materialised column. Two uses: backfilling a database that predates the column, and
 * proving after a migration or a bulk import that nothing drifted.
 *
 * Idempotent and safe to run against production at any time — it only ever writes the
 * value the derivation already implies.
 */
import { PrismaClient } from '@prisma/client';
import { recomputeDocumentationStatus } from '../lib/services/charge-status';

const BATCH = 500;

async function main() {
  const prisma = new PrismaClient();
  let cursor: number | undefined;
  let scanned = 0;
  let corrected = 0;

  for (;;) {
    const charges = await prisma.transaction.findMany({
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
      select: { id: true, documentationStatus: true },
    });
    if (charges.length === 0) break;

    for (const charge of charges) {
      const next = await recomputeDocumentationStatus(prisma, charge.id);
      scanned += 1;
      if (next !== charge.documentationStatus) {
        corrected += 1;
        console.log(`  ${charge.id}: ${charge.documentationStatus} -> ${next}`);
      }
    }

    cursor = charges[charges.length - 1]!.id;
  }

  console.log(`Backfill complete: ${scanned} charges scanned, ${corrected} corrected.`);
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
