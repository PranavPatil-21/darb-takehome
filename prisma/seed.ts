import { PrismaClient } from '@prisma/client';
import { recomputeDocumentationStatuses } from '../lib/services/charge-status';
import { recomputeDocumentStatus } from '../lib/services/document-status';
import { selectCandidateTransactions } from '../lib/services/candidate-selection';
import { matchDocument, type MatchableDocument } from '../lib/services/transaction-matcher';
import { persistMatchResult } from '../lib/services/document-ingestion';
import { claimConfirmedDocumentSlot } from '../lib/services/slot-claim';
import { recordEvent } from '../lib/platform/audit';
import { decideVerification } from '../lib/platform/verification';

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
  // ReviewEvent has no foreign key to Document by design, so it must be cleared by name
  // rather than relying on a cascade.
  await prisma.reviewEvent.deleteMany();
  await prisma.transactionBatch.deleteMany();
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
  // Work for a person to do, scored by the real engine. Without it the product looks
  // finished and empty — see `seedReviewWork`.
  await seedReviewWork(rawabi.id, nujood.id);
  await reconcileStatuses(prisma);

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
  const pick = <T,>(items: readonly T[]): T => {
    const chosen = items[Math.floor(next() * items.length)];
    if (chosen === undefined) throw new Error('pick() called with an empty list');
    return chosen;
  };

  // The cards whose scripted scenarios are *sensitive to volume*, named once and checked
  // below rather than described in prose and hoped for.
  //
  // Most scripted cards tolerate background charges happily. These three do not, and each
  // for a different reason:
  //
  //   4412  almost every scripted scenario runs on it, including the orphan receipt whose
  //         entire purpose is to have no plausible charge. Volume here gave it four
  //         candidates at 0.67, turning a demonstrated UNMATCHED into a review item — and
  //         since the re-match sweep only revisits UNMATCHED documents, that also made the
  //         late-arrival rescue structurally invisible.
  //   5520  carries the one-rule-each scenarios (17-22), which depend on nothing else
  //         being scoped to that card. Two to four extra charges a day for 28 days is
  //         exactly the noise that flips a scripted AUTO_MATCHED into an ambiguity.
  //   6604  Layla is the NO_CANDIDATE_TRANSACTIONS scenario and must have no charges at
  //         all. She is also a Rawabi identity, so Nujood volume on her card would
  //         describe a driver whose charges belong to a different client.
  //
  // The assertion is the point. A comment asking the next person not to add a card is a
  // wish; this fails the seed immediately and says which scenario it would have broken.
  const SCENARIO_CRITICAL_CARDS = ['4412', '5520', '6604'] as const;

  const fleets = [
    // Deliberately excludes the cards the scripted scenarios depend on.
    //
    // Card 5520 / driver 966554440001 carries transactions 17-22, and the comment at the
    // top of this file promises nothing else is scoped to that card so those scenarios
    // cannot be perturbed. Including it in the background generator made that promise
    // false: 2-4 extra charges a day for 28 days on the same card is exactly the kind of
    // noise that flips a scripted AUTO_MATCHED into an ambiguity.
    // 4412 is excluded for the same reason as 5520: it is the card almost every scripted
    // scenario runs on, including the orphan receipt whose whole purpose is to have no
    // plausible charge. Background volume generated onto it gave that receipt four
    // candidates at 0.67 and turned a demonstrated UNMATCHED into a review item — which
    // also made it invisible to the re-match sweep, since the sweep only revisits
    // UNMATCHED documents. Volume belongs on the cards nothing is scripted against.
    { clientId: rawabiId, cards: ['8899', '1155'], drivers: ['966557778888', null] },
    { clientId: nujoodId, cards: ['7731'], drivers: ['966561112233'] },
  ];

  const collisions = fleets
    .flatMap((fleet) => fleet.cards)
    .filter((card) => (SCENARIO_CRITICAL_CARDS as readonly string[]).includes(card));

  if (collisions.length > 0) {
    throw new Error(
      `Background volume would be generated onto scenario-critical card(s) ${collisions.join(', ')}. ` +
        'Those cards carry scripted demo scenarios that extra charges silently break — ' +
        'see SCENARIO_CRITICAL_CARDS above. Put background volume on a different card.',
    );
  }

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
        const card = fleet.cards[cardIndex];
        const driver = fleet.drivers[cardIndex] ?? null;
        if (card === undefined) continue;
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
          cardLast4: card,
          driverPhone: driver,
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

    // Most attachments are the engine's. A minority were made by a person, because the
    // segregation-of-duties rule is invisible unless some attachment actually has a human
    // maker: with every row attributed to 'system', nobody is ever the maker of anything,
    // `canVerify` never refuses, and switching between the two roles shows no difference
    // at all. A handful are attributed to the controller specifically, so her own
    // assurance queue contains work she is not allowed to sign off.
    const draw = next();
    const maker =
      draw < 0.08 ? 'controller' : draw < 0.22 ? 'reviewer' : 'system';
    const automatic = maker === 'system';

    await prisma.documentMatch.create({
      data: {
        documentId: document.id,
        transactionId: charge.id,
        confidence: 0.92 + next() * 0.07,
        signals: JSON.stringify({ amount: 1, cardLast4: 1, merchant: 0.9, date: 1 }),
        status: automatic ? 'AUTO_CONFIRMED' : 'CONFIRMED',
        decidedBy: maker,
        decidedAt: charge.transactionAt,
        // The same policy the running system applies: material value always, automatic
        // attachments always, and a sample of the rest.
        verificationRequired:
          charge.amount >= 100_000 || automatic || next() < 0.1,
        verificationTrigger:
          charge.amount >= 100_000 ? 'MATERIAL' : automatic ? 'AUTOMATIC' : 'SAMPLED',
        verificationReason:
          charge.amount >= 100_000
            ? 'Above the materiality threshold.'
            : automatic
              ? 'Attached automatically — no person has seen this yet.'
              : 'Selected by routine sampling.',
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

/**
 * Bring every seeded charge's cached status in line with its relations.
 *
 * The seed writes `confirmedDocumentId` and match rows directly rather than going through
 * the write paths that maintain the cache — which is what a bulk import does, and exactly
 * the case `scripts/backfill-status.ts` exists for. Running the same reconciliation here
 * means a freshly seeded database is in the state the application would have produced.
 */
/* -------------------------------------------------------------------------- */
/* Work for a person to do                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Documents that are not settled, scored by the real engine.
 *
 * Without this the product looks finished and empty: `db:reset` produced 113 documents,
 * every one of them `MATCHED`, so the review queue — the screen this whole system exists
 * to feed — had nothing in it, the audit trail had no events, and the charge register
 * showed two of its four states. Every unsettled state was reachable only by starting a
 * server and firing `npm run webhooks:demo`, which is a lot to ask of someone who just
 * wants to look at the thing.
 *
 * **These are not hand-written rows.** Each document is built with plausible extracted
 * fields, then passed through `selectCandidateTransactions` → `matchDocument` →
 * `persistMatchResult`: the same three calls the webhook pipeline makes. The confidences,
 * the per-signal breakdowns and the reason codes on screen are whatever the engine
 * actually computed, so what a reviewer sees is the product of the rules rather than a
 * decoration of them. If a threshold changes, these rows change with it.
 *
 * They are deliberately built on the *background* cards. The scripted scenarios on cards
 * 4412/5520/6604 stay untouched so `webhooks:demo` still demonstrates the live pipeline
 * end to end — see `SCENARIO_CRITICAL_CARDS`.
 */
async function seedReviewWork(rawabiId: number, nujoodId: number): Promise<void> {
  /** An undocumented background charge on a given card, oldest first. */
  const openCharge = async (cardLast4: string, skip = 0) =>
    prisma.transaction.findFirst({
      where: { cardLast4, confirmedDocumentId: null },
      orderBy: { transactionAt: 'desc' },
      skip,
    });

  const senderFor = (clientId: number, driverPhone: string | null) =>
    driverPhone ?? (clientId === rawabiId
      ? 'fleetops@rawabi-logistics.example'
      : 'accounts@nujood-catering.example');

  let seq = 0;

  /**
   * Creates the document, runs the real matcher over the real candidate set, and persists
   * whatever it decided. Returns the stored document id and the engine's outcome.
   */
  async function ingestScored(input: {
    clientId: number;
    driverPhone: string | null;
    source: 'WHATSAPP' | 'EMAIL';
    documentType: 'RECEIPT' | 'TAX_INVOICE' | 'UNKNOWN';
    merchantName: string | null;
    totalAmount: number | null;
    documentDate: Date | null;
    cardLast4: string | null;
    extractionConfidence: number;
    receivedAt: Date;
    note: string;
  }) {
    seq += 1;
    const document = await prisma.document.create({
      data: {
        source: input.source,
        externalId: `seed.work.${seq}`,
        contentHash: `seed-work-hash-${seq}`,
        senderIdentifier: senderFor(input.clientId, input.driverPhone),
        clientId: input.clientId,
        driverPhone: input.driverPhone,
        status: 'EXTRACTED',
        documentType: input.documentType,
        merchantName: input.merchantName,
        vatNumber: input.documentType === 'UNKNOWN' ? null : `30000000000${String(seq).padStart(4, '0')}`,
        totalAmount: input.totalAmount,
        currency: input.totalAmount === null ? null : 'SAR',
        documentDate: input.documentDate,
        cardLast4: input.cardLast4,
        rawText: input.note,
        extractionConfidence: input.extractionConfidence,
        receivedAt: input.receivedAt,
      },
    });

    const matchable: MatchableDocument = {
      source: input.source,
      clientId: input.clientId,
      driverPhone: input.driverPhone,
      documentType: input.documentType,
      merchantName: input.merchantName,
      vatNumber: null,
      totalAmount: input.totalAmount,
      currency: input.totalAmount === null ? null : 'SAR',
      documentDate: input.documentDate?.toISOString() ?? null,
      cardLast4: input.cardLast4,
      invoiceNumber: null,
      extractionConfidence: input.extractionConfidence,
    };

    const candidates = await selectCandidateTransactions(prisma, matchable, input.receivedAt);
    const result = matchDocument(matchable, candidates);
    await persistMatchResult(prisma, document.id, result);

    return { documentId: document.id, result };
  }

  const day = (iso: string) => new Date(iso);

  /* -- One of each kind of work ------------------------------------------- */

  // CHOOSE_CHARGE — two background charges on the same card, same day, same amount.
  const ambiguousA = await openCharge('8899');
  if (ambiguousA) {
    const twin = await prisma.transaction.create({
      data: {
        clientId: ambiguousA.clientId,
        cardLast4: ambiguousA.cardLast4,
        driverPhone: ambiguousA.driverPhone,
        merchantName: ambiguousA.merchantName,
        amount: ambiguousA.amount,
        currency: 'SAR',
        transactionAt: new Date(ambiguousA.transactionAt.getTime() + 3 * 3600_000),
      },
    });
    await ingestScored({
      clientId: ambiguousA.clientId,
      driverPhone: ambiguousA.driverPhone,
      source: 'WHATSAPP',
      documentType: 'RECEIPT',
      merchantName: ambiguousA.merchantName.replace(/ (ST|BR|RUH|DMM)\b.*$/, ''),
      totalAmount: ambiguousA.amount,
      documentDate: ambiguousA.transactionAt,
      cardLast4: ambiguousA.cardLast4,
      extractionConfidence: 0.93,
      receivedAt: new Date(twin.transactionAt.getTime() + 86_400_000),
      note: 'Two charges at the same branch, three hours apart, for the same amount.',
    });
  }

  // CHECK_FIGURES — a tip. The receipt total is below the charge by more than rounding.
  const tipped = await openCharge('1155');
  if (tipped) {
    await ingestScored({
      clientId: tipped.clientId,
      driverPhone: tipped.driverPhone,
      source: 'WHATSAPP',
      documentType: 'RECEIPT',
      merchantName: tipped.merchantName.replace(/ (ST|BR|RUH|DMM)\b.*$/, ''),
      totalAmount: Math.round(tipped.amount * 0.88),
      documentDate: tipped.transactionAt,
      cardLast4: tipped.cardLast4,
      extractionConfidence: 0.91,
      receivedAt: new Date(tipped.transactionAt.getTime() + 2 * 86_400_000),
      note: 'Printed total 12% below the charge — a service charge added at the terminal.',
    });
  }

  // CHECK_FIGURES via a scan the OCR itself distrusts.
  const blurry = await openCharge('7731');
  if (blurry) {
    await ingestScored({
      clientId: blurry.clientId,
      driverPhone: blurry.driverPhone,
      source: 'EMAIL',
      documentType: 'TAX_INVOICE',
      merchantName: blurry.merchantName.replace(/ (ST|BR|RUH|DMM)\b.*$/, ''),
      totalAmount: blurry.amount,
      documentDate: blurry.transactionAt,
      cardLast4: blurry.cardLast4,
      extractionConfidence: 0.41,
      receivedAt: new Date(blurry.transactionAt.getTime() + 86_400_000),
      note: 'Faxed invoice. Every field agrees, but the OCR distrusted its own read.',
    });
  }

  // WEAK_EVIDENCE — merchant and date survived; the total and the card did not.
  //
  // Given its own charge on its own card, so exactly one candidate is in the window.
  // With several, a document carrying only a merchant and a date ties them and the
  // engine reports ambiguity instead — correctly, but that is a different queue.
  const faint = await prisma.transaction.create({
    data: {
      clientId: rawabiId,
      cardLast4: '3370',
      driverPhone: '966553330000',
      merchantName: 'MADA CAFE BR 12 RUH',
      amount: 8_450,
      currency: 'SAR',
      transactionAt: day('2025-06-24T10:15:00Z'),
    },
  });
  await prisma.senderIdentity.create({
    data: {
      identifier: '966553330000',
      channel: 'WHATSAPP',
      clientId: rawabiId,
      driverPhone: '966553330000',
      label: 'Nawaf Al-Dossari (driver, card 3370)',
    },
  });
  await ingestScored({
    clientId: rawabiId,
    driverPhone: '966553330000',
    source: 'WHATSAPP',
    documentType: 'RECEIPT',
    merchantName: 'Mada Cafe',
    totalAmount: null,
    documentDate: faint.transactionAt,
    cardLast4: null,
    extractionConfidence: 0.74,
    receivedAt: new Date(faint.transactionAt.getTime() + 86_400_000),
    note: 'Thermal paper left on a dashboard. The merchant and the date are all that is left.',
  });

  // POSSIBLE_DUPLICATE — a second receipt for a charge that already holds one. The
  // cardholder slip arrives after the till receipt was already attached.
  const alreadyDocumented = await prisma.transaction.findFirst({
    where: { confirmedDocumentId: { not: null }, cardLast4: '8899' },
    orderBy: { transactionAt: 'desc' },
  });
  if (alreadyDocumented) {
    await ingestScored({
      clientId: alreadyDocumented.clientId,
      driverPhone: alreadyDocumented.driverPhone,
      source: 'WHATSAPP',
      documentType: 'RECEIPT',
      merchantName: alreadyDocumented.merchantName.replace(/ (ST|BR|RUH|DMM)\b.*$/, ''),
      totalAmount: alreadyDocumented.amount,
      documentDate: alreadyDocumented.transactionAt,
      cardLast4: alreadyDocumented.cardLast4,
      extractionConfidence: 0.96,
      receivedAt: new Date(alreadyDocumented.transactionAt.getTime() + 3 * 86_400_000),
      note: 'Cardholder slip for a charge that already has a till receipt attached.',
    });
  }

  // NO_CHARGE_FOUND — a real receipt whose charge has not posted yet.
  await ingestScored({
    clientId: rawabiId,
    driverPhone: '966557778888',
    source: 'WHATSAPP',
    documentType: 'RECEIPT',
    merchantName: 'Qasr Al Mandi Restaurant',
    totalAmount: 73_317,
    documentDate: day('2025-07-04T19:40:00Z'),
    cardLast4: '8899',
    extractionConfidence: 0.95,
    receivedAt: day('2025-07-04T19:55:00Z'),
    note: 'Receipt photographed at the till. The settlement has not posted yet.',
  });

  // UNREADABLE — OCR returned nothing usable.
  await ingestScored({
    clientId: nujoodId,
    driverPhone: '966561112233',
    source: 'WHATSAPP',
    documentType: 'UNKNOWN',
    merchantName: null,
    totalAmount: null,
    documentDate: null,
    cardLast4: null,
    extractionConfidence: 0.12,
    receivedAt: day('2025-06-26T08:10:00Z'),
    note: 'Photograph of a dashboard, taken by accident.',
  });

  // SENDER_UNKNOWN — a readable receipt from a number nobody has registered.
  seq += 1;
  await prisma.document.create({
    data: {
      source: 'WHATSAPP',
      externalId: `seed.work.${seq}`,
      contentHash: `seed-work-hash-${seq}`,
      senderIdentifier: '966509998877',
      clientId: null,
      driverPhone: null,
      status: 'UNMATCHED',
      failureReason: 'NO_CANDIDATE_TRANSACTIONS',
      documentType: 'RECEIPT',
      merchantName: 'Sasco Fuel Station',
      vatNumber: '300000000099001',
      totalAmount: 18_900,
      currency: 'SAR',
      documentDate: day('2025-06-25T07:30:00Z'),
      cardLast4: '2244',
      rawText: 'Perfectly readable. We do not know whose driver this is.',
      extractionConfidence: 0.94,
      receivedAt: day('2025-06-25T07:45:00Z'),
    },
  });

  /* -- Decisions, so the trail and the settled states are not empty -------- */

  // Made on documents created for the purpose, not on the queue above.
  //
  // Acting on the demo work items would consume them — the first attempt confirmed a
  // candidate belonging to the ambiguity example, which emptied the `CHOOSE_CHARGE` queue
  // that example exists to fill. The trail needs decisions; the queue needs work; they
  // must not be the same rows.
  //
  // Each decision goes through the same primitives the server actions use —
  // `claimConfirmedDocumentSlot`, `recordEvent`, `recomputeDocumentStatus` — so the audit
  // trail contains real events and the charge register shows its REJECTED and IN_REVIEW
  // states rather than only DOCUMENTED and MISSING.

  /** A fresh document that matches one open charge, left in review for a person to decide. */
  async function decidableDocument(cardLast4: string) {
    const charge = await openCharge(cardLast4);
    if (!charge) return null;
    const { documentId } = await ingestScored({
      clientId: charge.clientId,
      driverPhone: charge.driverPhone,
      source: 'WHATSAPP',
      documentType: 'RECEIPT',
      merchantName: charge.merchantName.replace(/ (ST|BR|RUH|DMM)\b.*$/, ''),
      totalAmount: charge.amount,
      documentDate: charge.transactionAt,
      cardLast4: charge.cardLast4,
      // Under the OCR gate, so it lands in review rather than settling itself — which is
      // what makes the human decision worth recording.
      extractionConfidence: 0.52,
      receivedAt: new Date(charge.transactionAt.getTime() + 86_400_000),
      note: 'Legible, but the OCR was unsure enough that a person had to sign it off.',
    });
    return prisma.documentMatch.findFirst({
      where: { documentId, status: 'CANDIDATE' },
      orderBy: { confidence: 'desc' },
      include: { transaction: { select: { amount: true } } },
    });
  }

  const confirmed = await decidableDocument('1155');
  if (confirmed) {
    const claimed = await claimConfirmedDocumentSlot(
      prisma.transaction,
      confirmed.transactionId,
      confirmed.documentId,
      prisma,
    );
    if (claimed) {
      const verification = decideVerification({
        amount: confirmed.transaction.amount,
        automatic: false,
        draw: 0.04,
      });
      await prisma.documentMatch.update({
        where: { id: confirmed.id },
        data: {
          status: 'CONFIRMED',
          decidedBy: 'reviewer',
          decidedAt: day('2025-06-28T09:15:00Z'),
          verificationRequired: verification.required,
          verificationTrigger: verification.required ? verification.trigger : null,
          verificationReason: verification.required ? verification.reason : null,
        },
      });
      await recordEvent(prisma.reviewEvent, {
        documentId: confirmed.documentId,
        transactionId: confirmed.transactionId,
        matchId: confirmed.id,
        action: 'CONFIRMED',
        actorId: 'reviewer',
        actorRole: 'MAKER',
        confidence: confirmed.confidence,
        note: 'Branch and time checked against the paper receipt.',
      });
      await recomputeDocumentStatus(prisma, confirmed.documentId);
    }
  }

  // On a charge of its own, so rejecting the only proposal leaves the charge in the
  // REJECTED state — "somebody looked and said no", which is a different queue from
  // "nobody has proposed anything". Reusing a shared card left another document's
  // candidate alive on the same charge, so it stayed IN_REVIEW and the state never showed.
  const lonelyCharge = await prisma.transaction.create({
    data: {
      clientId: nujoodId,
      cardLast4: '7731',
      driverPhone: '966561112233',
      merchantName: 'HERFY FOOD SERVICES BR 8',
      amount: 15_600,
      currency: 'SAR',
      transactionAt: day('2025-06-23T12:30:00Z'),
    },
  });
  const { documentId: rejectedDocumentId } = await ingestScored({
    clientId: nujoodId,
    driverPhone: '966561112233',
    source: 'WHATSAPP',
    documentType: 'RECEIPT',
    merchantName: 'Herfy Food Services',
    totalAmount: lonelyCharge.amount,
    documentDate: lonelyCharge.transactionAt,
    cardLast4: lonelyCharge.cardLast4,
    extractionConfidence: 0.54,
    receivedAt: new Date(lonelyCharge.transactionAt.getTime() + 86_400_000),
    note: 'Right chain, wrong branch — the driver was at the airport road store.',
  });
  const rejected = await prisma.documentMatch.findFirst({
    where: { documentId: rejectedDocumentId, status: 'CANDIDATE' },
    orderBy: { confidence: 'desc' },
    include: { transaction: { select: { amount: true } } },
  });
  if (rejected) {
    await prisma.documentMatch.update({
      where: { id: rejected.id },
      data: { status: 'REJECTED', decidedBy: 'reviewer', decidedAt: day('2025-06-28T09:22:00Z') },
    });
    await recordEvent(prisma.reviewEvent, {
      documentId: rejected.documentId,
      transactionId: rejected.transactionId,
      matchId: rejected.id,
      action: 'REJECTED',
      actorId: 'reviewer',
      actorRole: 'MAKER',
      confidence: rejected.confidence,
      note: 'Different branch — the driver confirmed it was the airport road station.',
    });
    await recomputeDocumentStatus(prisma, rejected.documentId);
  }

  // One checker sign-off, so the assurance queue shows a completed verification beside the
  // outstanding ones and the trail carries a CHECKER row.
  const toVerify = await prisma.documentMatch.findFirst({
    where: { verificationRequired: true, verifiedAt: null, decidedBy: 'reviewer' },
    orderBy: { id: 'asc' },
  });
  if (toVerify) {
    await prisma.documentMatch.update({
      where: { id: toVerify.id },
      data: {
        verifiedBy: 'controller',
        verifiedAt: day('2025-06-28T16:40:00Z'),
        verificationOutcome: 'UPHELD',
      },
    });
    await recordEvent(prisma.reviewEvent, {
      documentId: toVerify.documentId,
      transactionId: toVerify.transactionId,
      matchId: toVerify.id,
      action: 'VERIFIED',
      actorId: 'controller',
      actorRole: 'CHECKER',
      confidence: toVerify.confidence,
      note: 'Independent check: amount, card and merchant all agree.',
    });
  }
}

async function reconcileStatuses(prisma: PrismaClient) {
  const charges = await prisma.transaction.findMany({ select: { id: true } });
  await recomputeDocumentationStatuses(
    prisma,
    charges.map((charge) => charge.id),
  );
  console.log(`Reconciled documentation status for ${charges.length} charges.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
