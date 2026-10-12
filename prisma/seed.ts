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
 *  - Transactions 17-22 belong to one isolated driver (Saad, card 5520), each the target of
 *    one demo scenario. Nothing else is scoped to that card, so those scenarios cannot
 *    perturb the ones above. Six transactions carry eight scenarios: the second-receipt
 *    case deliberately re-targets transaction 17, and Layla (card 6604) deliberately has
 *    no transactions at all, which is the only way to reach NO_CANDIDATE_TRANSACTIONS
 *    from a webhook.
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
      {
        identifier: '966554440001',
        channel: 'WHATSAPP',
        clientId: rawabi.id,
        driverPhone: '966554440001',
        label: 'Saad Al-Dossari (driver, card 5520)',
      },
      {
        // Onboarded, but none of her transactions have posted yet. The only way to reach
        // NO_CANDIDATE_TRANSACTIONS from a webhook rather than a unit test.
        identifier: '966554440002',
        channel: 'WHATSAPP',
        clientId: rawabi.id,
        driverPhone: '966554440002',
        label: 'Layla Al-Qahtani (driver, card 6604 — newly onboarded)',
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

      /* --- Rawabi · Saad · card 5520 -----------------------------------
       *
       * A deliberately isolated driver. Every scenario below exercises one scoring rule,
       * and because no other fixture is scoped to this card, none of them can become a
       * stray candidate for the scenarios above — or for each other.
       */
      {
        id: 17,
        clientId: rawabi.id,
        cardLast4: '5520',
        driverPhone: '966554440001',
        merchantName: 'BIN DAWOOD MARKET 31 RUH',
        amount: 8850, // receipt reads 88.45 — five halalas of VAT rounding
        transactionAt: at('2025-06-21T10:05:00Z'),
      },
      {
        id: 18,
        clientId: rawabi.id,
        cardLast4: '5520',
        driverPhone: '966554440001',
        merchantName: 'ARAMEX SHIPPING RUH',
        amount: 4800, // receipt dated 17 June; this settled on the 23rd
        transactionAt: at('2025-06-23T09:00:00Z'),
      },
      {
        id: 19,
        clientId: rawabi.id,
        cardLast4: '5520',
        driverPhone: '966554440001',
        merchantName: 'EXTRA STORES RUH',
        amount: 27500, // receipt agrees on everything except the card digits
        transactionAt: at('2025-06-24T15:20:00Z'),
      },
      {
        id: 20,
        clientId: rawabi.id,
        cardLast4: '5520',
        driverPhone: '966554440001',
        merchantName: 'NOON COM FZ LLC',
        amount: 19900, // 199.00 SAR; the receipt says 199.00 USD
        transactionAt: at('2025-06-25T11:00:00Z'),
      },
      {
        id: 21,
        clientId: rawabi.id,
        cardLast4: '5520',
        driverPhone: '966554440001',
        merchantName: 'AL BAIK RESTAURANT RUH',
        amount: 14000, // receipt says 150.00 — the card paid less, which a tip cannot explain
        transactionAt: at('2025-06-26T20:15:00Z'),
      },
      {
        id: 22,
        clientId: rawabi.id,
        cardLast4: '5520',
        driverPhone: '966554440001',
        merchantName: 'DANUBE HYPERMARKET RUH',
        amount: 23400, // the matching receipt has faded past its amount line
        transactionAt: at('2025-06-27T17:45:00Z'),
      },
    ],
  });

  await seedOperatingHistory(rawabi.id, nujood.id);

  const [clients, identities, transactions] = await Promise.all([
    prisma.client.count(),
    prisma.senderIdentity.count(),
    prisma.transaction.count(),
  ]);

  console.log(
    `Seeded ${clients} clients, ${identities} sender identities, ${transactions} transactions.`,
  );
}

/**
 * A month of ordinary trading, behind the eleven scripted scenarios.
 *
 * The scripted fixtures exist to demonstrate specific engine behaviours and are
 * deliberately few. They are not a population: with twenty-three charges every register
 * reads as scaffolding, ageing has nothing to distribute across, the coverage figure moves
 * by four percent per decision, and a filter that returns three rows cannot show whether
 * filtering works.
 *
 * So this adds background volume: charges across both fleets spread over the period, a
 * realistic share already documented, and the rest left open at varying ages. It is
 * generated rather than written out because the point is the shape of the distribution,
 * not any individual row — and it is fully deterministic, because a demo that looks
 * different on every reset cannot be discussed.
 *
 * It touches nothing the scripted scenarios rely on: ids start well clear of them, and the
 * merchants, cards and dates are chosen not to collide with the fixtures' matching.
 */
async function seedOperatingHistory(rawabiId: number, nujoodId: number): Promise<void> {
  const MERCHANTS = [
    'SASCO FUEL ST 12 RUH', 'PANDA HYPERMARKET BR 220', 'NAHDI PHARMACY 118',
    'CARREFOUR HYPER RUH', 'DUNKIN DONUTS RUH 41', 'STARBUCKS KHOBAR 7',
    'LULU HYPERMARKET DMM', 'AL OTHAIM MARKET 55', 'HERFY FOOD SERVICES',
    'SAUDIA CATERING RUH', 'ABDUL LATIF JAMEEL', 'BUPA ARABIA CLINIC',
    'MOBILY RECHARGE', 'STC PAY TOPUP', 'UBER TRIP RIYADH',
    'JARIR MARKETING 09', 'IKEA RIYADH', 'ACE HARDWARE RUH',
    'SAUDI POST PARCEL', 'ARAMEX DOMESTIC 02',
  ];

  // A linear congruential generator, seeded by hand. Deterministic across resets so the
  // demo is the same every time and can be talked about; `Math.random()` would make every
  // screenshot and every conversation about a number obsolete on the next seed.
  let seed = 20250601;
  const next = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)];

  const fleets = [
    { clientId: rawabiId, cards: ['4412', '8899', '1155', '5520'], drivers: ['966551234567', '966557778888', null, '966554440001'] },
    { clientId: nujoodId, cards: ['7731', '6604'], drivers: ['966561112233', '966554440002'] },
  ];

  const rows: {
    id: number; clientId: number; cardLast4: string; driverPhone: string | null;
    merchantName: string; amount: number; transactionAt: Date;
  }[] = [];

  // Ids from 1000 so nothing can collide with the scripted charges or with the
  // late-arriving transaction the demo script posts.
  let id = 1000;

  for (const fleet of fleets) {
    for (let day = 1; day <= 28; day += 1) {
      // Two to four charges a day per fleet — enough to populate a register without
      // pretending a two-client demo is an enterprise.
      const perDay = 2 + Math.floor(next() * 3);

      for (let n = 0; n < perDay; n += 1) {
        const cardIndex = Math.floor(next() * fleet.cards.length);
        // Amounts are log-distributed: mostly small, occasionally large. A uniform spread
        // would make the by-value status bar meaningless, since its whole point is that
        // one large charge outweighs many small ones.
        const magnitude = next();
        const amount =
          magnitude > 0.94
            ? 50_000 + Math.floor(next() * 250_000)
            : magnitude > 0.7
              ? 8_000 + Math.floor(next() * 30_000)
              : 1_500 + Math.floor(next() * 7_000);

        rows.push({
          id: id++,
          clientId: fleet.clientId,
          cardLast4: fleet.cards[cardIndex],
          driverPhone: fleet.drivers[cardIndex],
          merchantName: pick(MERCHANTS),
          amount,
          transactionAt: at(
            `2025-06-${String(day).padStart(2, '0')}T${String(7 + Math.floor(next() * 12)).padStart(2, '0')}:${String(Math.floor(next() * 60)).padStart(2, '0')}:00Z`,
          ),
        });
      }
    }
  }

  await prisma.transaction.createMany({ data: rows });

  // Roughly two thirds already have a receipt, which is what a fleet running this for a
  // few months looks like. Documenting all of them would leave nothing to do on screen;
  // documenting none would make the coverage figure read as a broken pipeline.
  const documented = rows.filter(() => next() < 0.66);

  for (const charge of documented) {
    const document = await prisma.document.create({
      data: {
        source: next() < 0.75 ? 'WHATSAPP' : 'EMAIL',
        externalId: `seed.${charge.id}`,
        contentHash: `seed-hash-${charge.id}`,
        senderIdentifier: charge.driverPhone ?? 'fleetops@rawabi-logistics.example',
        clientId: charge.clientId,
        driverPhone: charge.driverPhone,
        status: 'MATCHED',
        documentType: 'RECEIPT',
        merchantName: charge.merchantName
          .replace(/ (ST|BR|RUH|DMM)\b.*$/, '')
          .replace(/\s+\d+$/, ''),
        vatNumber: `3000000000${String(charge.id).padStart(5, '0')}`,
        totalAmount: charge.amount,
        currency: 'SAR',
        documentDate: charge.transactionAt,
        cardLast4: charge.cardLast4,
        extractionConfidence: 0.9 + next() * 0.09,
        receivedAt: charge.transactionAt,
      },
    });

    await prisma.documentMatch.create({
      data: {
        documentId: document.id,
        transactionId: charge.id,
        confidence: 0.92 + next() * 0.07,
        signals: JSON.stringify({ amount: 1, cardLast4: 1, merchant: 0.9, date: 1 }),
        status: 'AUTO_CONFIRMED',
        decidedBy: 'system',
        decidedAt: charge.transactionAt,
      },
    });

    await prisma.transaction.update({
      where: { id: charge.id },
      data: { confirmedDocumentId: document.id },
    });
  }

  console.log(
    `Seeded ${rows.length} background charges, ${documented.length} already documented.`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
