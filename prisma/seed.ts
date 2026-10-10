import { PrismaClient } from '@prisma/client';

/**
 * Seed data.
 *
 * Shaped so that every edge case in the brief is reachable by firing a sample webhook,
 * not just by running a unit test. Notable deliberate collisions:
 *
 *  - Transactions 6 and 7 are the same amount, same day, same chain — the ambiguity pair.
 *  - Transaction 14 is byte-identical in amount/merchant/date to transaction 1 but belongs
 *    to a different client, which proves scoping is a filter rather than a tiebreaker.
 *  - Transaction 11 is a large corporate charge with no driver, reachable only by email.
 */

const prisma = new PrismaClient();

const at = (iso: string) => new Date(iso);

async function main() {
  // Order matters: children before parents.
  await prisma.documentMatch.deleteMany();
  await prisma.transaction.updateMany({ data: { confirmedDocumentId: null } });
  await prisma.document.deleteMany();
  await prisma.transaction.deleteMany();
  await prisma.senderIdentity.deleteMany();
  await prisma.client.deleteMany();

  const rawabi = await prisma.client.create({ data: { id: 1, name: 'Rawabi Logistics' } });
  const nujood = await prisma.client.create({ data: { id: 2, name: 'Nujood Catering' } });

  await prisma.senderIdentity.createMany({
    data: [
      {
        identifier: '966551234567',
        channel: 'WHATSAPP',
        clientId: rawabi.id,
        driverPhone: '966551234567',
        label: 'Faisal Al-Harbi (driver, card 4412)',
      },
      {
        identifier: '966557778888',
        channel: 'WHATSAPP',
        clientId: rawabi.id,
        driverPhone: '966557778888',
        label: 'Omar Nasser (driver, card 8899)',
      },
      {
        identifier: '966561112233',
        channel: 'WHATSAPP',
        clientId: nujood.id,
        driverPhone: '966561112233',
        label: 'Yusuf Idris (driver, card 7731)',
      },
      {
        identifier: 'fleetops@rawabi-logistics.example',
        channel: 'EMAIL',
        clientId: rawabi.id,
        driverPhone: null, // client-wide scope: a fleet manager forwards for any driver
        label: 'Rawabi fleet manager inbox',
      },
      {
        identifier: 'billing@alfanar-fuel.com.sa',
        channel: 'EMAIL',
        clientId: rawabi.id,
        driverPhone: null,
        label: 'Alfanar Fuel — supplier billing (Rawabi corporate account)',
      },
      {
        identifier: 'accounts@nujood-catering.example',
        channel: 'EMAIL',
        clientId: nujood.id,
        driverPhone: null,
        label: 'Nujood accounts inbox',
      },
    ],
  });

  await prisma.transaction.createMany({
    data: [
      /* --- Rawabi · Faisal · card 4412 --------------------------------- */
      {
        id: 1,
        clientId: rawabi.id,
        cardLast4: '4412',
        driverPhone: '966551234567',
        merchantName: 'ALFANAR FUEL ST 04 RUH',
        amount: 12500,
        transactionAt: at('2025-06-14T11:02:00Z'),
      },
      {
        id: 2,
        clientId: rawabi.id,
        cardLast4: '4412',
        driverPhone: '966551234567',
        merchantName: 'NAJD VILLAGE REST RUH',
        amount: 6325, // receipt says 57.50; card charged 63.25 — the tip case
        transactionAt: at('2025-06-12T19:34:00Z'),
      },
      {
        id: 3,
        clientId: rawabi.id,
        cardLast4: '4412',
        driverPhone: '966551234567',
        merchantName: 'TAMIMI MARKETS 0007 RUH',
        amount: 8940,
        transactionAt: at('2025-06-10T08:15:00Z'),
      },
      {
        id: 4,
        clientId: rawabi.id,
        cardLast4: '4412',
        driverPhone: '966551234567',
        merchantName: 'SACO HARDWARE CO LLC',
        amount: 31075,
        transactionAt: at('2025-06-09T14:20:00Z'),
      },
      {
        id: 5,
        clientId: rawabi.id,
        cardLast4: '4412',
        driverPhone: '966551234567',
        merchantName: 'PETROMIN FUEL ST 21 RUH',
        amount: 9000,
        transactionAt: at('2025-06-16T07:33:00Z'),
      },
      {
        id: 6,
        clientId: rawabi.id,
        cardLast4: '4412',
        driverPhone: '966551234567',
        merchantName: 'TAMIMI MARKETS 0007 RUH',
        amount: 4500, // ambiguity pair, half one
        transactionAt: at('2025-06-17T12:10:00Z'),
      },
      {
        id: 7,
        clientId: rawabi.id,
        cardLast4: '4412',
        driverPhone: '966551234567',
        merchantName: 'TAMIMI MARKETS 0012 RUH',
        amount: 4500, // ambiguity pair, half two — same amount, same day, same chain
        transactionAt: at('2025-06-17T12:55:00Z'),
      },

      /* --- Rawabi · Omar · card 8899 ----------------------------------- */
      {
        id: 8,
        clientId: rawabi.id,
        cardLast4: '8899',
        driverPhone: '966557778888',
        merchantName: 'ALFANAR FUEL ST 04 RUH',
        amount: 15600,
        transactionAt: at('2025-06-13T16:40:00Z'),
      },
      {
        id: 9,
        clientId: rawabi.id,
        cardLast4: '8899',
        driverPhone: '966557778888',
        merchantName: 'PANDA HYPERMARKET BR 112',
        amount: 21450,
        transactionAt: at('2025-06-11T10:00:00Z'),
      },
      {
        id: 10,
        clientId: rawabi.id,
        cardLast4: '8899',
        driverPhone: '966557778888',
        merchantName: 'ADV*UBER TRIP',
        amount: 4200,
        transactionAt: at('2025-06-14T09:00:00Z'),
      },

      /* --- Rawabi · corporate pool card 1155 (no driver) ---------------- */
      {
        id: 11,
        clientId: rawabi.id,
        cardLast4: '1155',
        driverPhone: null,
        merchantName: 'ALFANAR FUEL CORP RUH',
        amount: 487500, // the emailed tax invoice INV-99812
        transactionAt: at('2025-06-14T09:21:00Z'),
      },
      {
        id: 12,
        clientId: rawabi.id,
        cardLast4: '1155',
        driverPhone: null,
        merchantName: 'JARIR BOOKSTORE RUH',
        amount: 18000,
        transactionAt: at('2025-06-05T12:00:00Z'),
      },
      {
        id: 13,
        clientId: rawabi.id,
        cardLast4: '1155',
        driverPhone: null,
        merchantName: 'ALFANAR FUEL CORP RUH',
        amount: 52300,
        transactionAt: at('2025-06-20T13:00:00Z'),
      },

      /* --- Nujood · Yusuf · card 7731 ---------------------------------- */
      {
        id: 14,
        clientId: nujood.id,
        cardLast4: '7731',
        driverPhone: '966561112233',
        merchantName: 'ALFANAR FUEL ST 04 RUH',
        amount: 12500, // identical to transaction 1 — different client, must never match
        transactionAt: at('2025-06-14T11:02:00Z'),
      },
      {
        id: 15,
        clientId: nujood.id,
        cardLast4: '7731',
        driverPhone: '966561112233',
        merchantName: 'BATEEL CAFE RUH',
        amount: 7600,
        transactionAt: at('2025-06-16T18:00:00Z'),
      },
      {
        id: 16,
        clientId: nujood.id,
        cardLast4: '7731',
        driverPhone: '966561112233',
        merchantName: 'TAMIMI MARKETS 0007 RUH',
        amount: 14300,
        transactionAt: at('2025-06-18T08:30:00Z'),
      },
    ],
  });

  const [clients, identities, transactions] = await Promise.all([
    prisma.client.count(),
    prisma.senderIdentity.count(),
    prisma.transaction.count(),
  ]);

  console.log(
    `Seeded ${clients} clients, ${identities} sender identities, ${transactions} transactions.`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
