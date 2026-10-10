import { PrismaClient } from '@prisma/client';

/**
 * A Prisma client pinned to the test database, plus the fixtures the integration tests
 * build on. Kept separate from `prisma/seed.ts` so a change to the demo seed can never
 * silently move a test's goalposts.
 */
export const testPrisma = new PrismaClient({
  datasources: { db: { url: 'file:./test.db' } },
});

export async function resetDatabase(): Promise<void> {
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
