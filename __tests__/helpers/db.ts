import prisma from '@/lib/prisma';

/**
 * The client the tests build fixtures with — **the same instance the route handlers and
 * server actions use**, not a second one pointed at the same file.
 *
 * It used to be its own `new PrismaClient({ datasources: … 'file:./test.db' })`. That gave
 * one SQLite file two connection pools with independent write pipelines, and four suites
 * used both in the same test. The result was a suite that passed roughly one run in five:
 * `resetDatabase`'s ordered deletes raced against writes still in flight on the other
 * pool, surfacing as `Foreign key constraint violated` on `client.deleteMany()` and
 * `Unique constraint failed on (id)` on `transaction.createMany()` — failures that look
 * like product bugs and are not. A flaky gate is worse than a missing one, because it
 * teaches everyone to re-run until green.
 *
 * `__tests__/setup.ts` points `DATABASE_URL` at `file:./test.db` before any module loads
 * `lib/prisma`, so this singleton is already the test database. One pool, one writer,
 * deterministic ordering.
 */
export const testPrisma = prisma;

export async function resetDatabase(): Promise<void> {
  // Explicit: ReviewEvent deliberately has no foreign key to Document, so nothing
  // cascades into it. That is the point — the trail outlives what it describes — but it
  // means the reset has to name it.
  await testPrisma.reviewEvent.deleteMany();
  await testPrisma.transactionBatch.deleteMany();
  await testPrisma.documentMatch.deleteMany();
  await testPrisma.transaction.updateMany({ data: { confirmedDocumentId: null } });
  await testPrisma.document.deleteMany();
  await testPrisma.transaction.deleteMany();
  await testPrisma.senderIdentity.deleteMany();
  await testPrisma.client.deleteMany();
}

/** The minimum world an ingestion test needs: one client, one driver, one transaction. */
export async function seedMinimalWorld(): Promise<void> {
  await testPrisma.client.create({ data: { id: 1, name: 'Rawabi Logistics' } });
  await testPrisma.client.create({ data: { id: 2, name: 'Nujood Catering' } });

  await testPrisma.senderIdentity.createMany({
    data: [
      {
        identifier: '966551234567',
        channel: 'WHATSAPP',
        clientId: 1,
        driverPhone: '966551234567',
        label: 'Faisal Al-Harbi',
      },
      {
        identifier: 'fleetops@rawabi-logistics.example',
        channel: 'EMAIL',
        clientId: 1,
        driverPhone: null,
        label: 'Rawabi fleet manager inbox',
      },
    ],
  });

  await testPrisma.transaction.createMany({
    data: [
      {
        id: 1,
        clientId: 1,
        cardLast4: '4412',
        driverPhone: '966551234567',
        merchantName: 'ALFANAR FUEL ST 04 RUH',
        amount: 12500,
        transactionAt: new Date('2025-06-14T11:02:00Z'),
      },
      {
        id: 6,
        clientId: 1,
        cardLast4: '4412',
        driverPhone: '966551234567',
        merchantName: 'TAMIMI MARKETS 0007 RUH',
        amount: 4500,
        transactionAt: new Date('2025-06-17T12:10:00Z'),
      },
      {
        id: 7,
        clientId: 1,
        cardLast4: '4412',
        driverPhone: '966551234567',
        merchantName: 'TAMIMI MARKETS 0012 RUH',
        amount: 4500,
        transactionAt: new Date('2025-06-17T12:55:00Z'),
      },
      {
        id: 11,
        clientId: 1,
        cardLast4: '1155',
        driverPhone: null,
        merchantName: 'ALFANAR FUEL CORP RUH',
        amount: 487500,
        transactionAt: new Date('2025-06-14T09:21:00Z'),
      },
    ],
  });
}

/**
 * Recompute every charge's cached status from its live relations.
 *
 * Tests that build fixtures by writing `confirmedDocumentId` or match rows directly are
 * doing what a data migration does: changing the inputs without going through the write
 * paths that maintain the cache. They call this afterwards for the same reason a backfill
 * exists — and `scripts/backfill-status.ts` is this function against a real database.
 */
export async function syncChargeStatuses(): Promise<void> {
  const { recomputeDocumentationStatuses } = await import('@/lib/services/charge-status');
  const ids = await testPrisma.transaction.findMany({ select: { id: true } });
  await recomputeDocumentationStatuses(
    testPrisma,
    ids.map((row) => row.id),
  );
}
