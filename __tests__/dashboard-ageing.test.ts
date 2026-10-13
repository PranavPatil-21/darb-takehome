import { getDashboard } from '@/lib/platform/dashboard';
import { getChargeRegister } from '@/lib/platform/charge-register';
import { resetDatabase, seedMinimalWorld, syncChargeStatuses } from './helpers/db';
import prisma from '@/lib/prisma';

/**
 * Two numbers an operator acts on, both derived from an "as of" reference.
 *
 * The reference is the end of the period the *charge* data covers, which is a deliberate
 * choice: a closed month should not keep ageing. The bugs are in applying that reference
 * to things it does not describe.
 */

const ACTOR = {
  id: 'tester',
  displayName: 'Tester',
  capabilities: ['view', 'decide'] as const,
  clientIds: null,
};
const actor = () => ({ ...ACTOR, capabilities: [...ACTOR.capabilities] });
const NOW = new Date('2025-09-30T12:00:00Z');

async function clearWorld() {
  await prisma.documentMatch.deleteMany();
  await prisma.transaction.updateMany({ data: { confirmedDocumentId: null } });
  await prisma.document.deleteMany();
  await prisma.transaction.deleteMany();
}

beforeEach(async () => {
  await resetDatabase();
  await seedMinimalWorld();
  await clearWorld();
});

it('ages a waiting document against now, not against the charge period', async () => {
  // The charges stop in June; the document arrived in September and has waited since.
  // Anchoring its age to the end of the charge period made the gap negative, which the
  // clamp turned into 0 — so the headline that exists to catch a stalled pipeline read
  // "< 1 day" after a month of silence.
  await prisma.transaction.create({
    data: {
      id: 801, clientId: 1, cardLast4: '4412', driverPhone: '966551234567',
      merchantName: 'ALFANAR FUEL ST 04 RUH', amount: 12_500, currency: 'SAR',
      transactionAt: new Date('2025-06-14T11:02:00Z'),
    },
  });
  await prisma.document.create({
    data: {
      id: 801, source: 'WHATSAPP', externalId: 'wamid.AGE', contentHash: 'hash-age',
      senderIdentifier: '966551234567', status: 'UNMATCHED', clientId: 1,
      failureReason: 'NO_PLAUSIBLE_CANDIDATE', receivedAt: new Date('2025-09-01T09:00:00Z'),
    },
  });
  await syncChargeStatuses();

  const dashboard = await getDashboard(actor(), NOW);

  expect(dashboard.oldestWaitingDays).toBe(29);
});

it('does not change a charge’s age when the operator searches', async () => {
  // The ageing reference was computed over the *filtered* set, so typing in the search
  // box moved it and the same charge aged differently on the same screen.
  for (const [id, merchant, day] of [
    [811, 'TAMIMI MARKETS 220', '2025-06-14'],
    [812, 'SASCO FUEL ST 12 RUH', '2025-08-20'],
  ] as const) {
    await prisma.transaction.create({
      data: {
        id, clientId: 1, cardLast4: '4412', driverPhone: '966551234567',
        merchantName: merchant, amount: 10_000, currency: 'SAR',
        transactionAt: new Date(`${day}T10:00:00Z`),
      },
    });
  }
  await syncChargeStatuses();

  const unfiltered = await getChargeRegister(actor(), {}, NOW);
  const searched = await getChargeRegister(actor(), { query: 'TAMIMI' }, NOW);

  const ageOf = (rows: typeof unfiltered.rows, id: number) =>
    rows.find((row) => row.id === id)?.age;

  // Guard against a vacuous assertion: both lookups must actually find the row.
  expect(ageOf(unfiltered.rows, 811)).toEqual(expect.any(Number));
  expect(ageOf(searched.rows, 811)).toEqual(expect.any(Number));
  expect(ageOf(searched.rows, 811)).toBe(ageOf(unfiltered.rows, 811));
});
