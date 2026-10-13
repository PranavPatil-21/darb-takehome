import { getChargeRegister } from '@/lib/platform/charge-register';
import { resetDatabase, seedMinimalWorld, syncChargeStatuses } from './helpers/db';
import prisma from '@/lib/prisma';

/**
 * The charge register is the screen a finance operator works from, and the chips above it
 * price the set below it. Both numbers have to describe the same rows.
 */

const ACTOR = {
  id: 'tester',
  displayName: 'Tester',
  capabilities: ['view', 'decide'] as const,
  clientIds: null,
};

const actor = () => ({ ...ACTOR, capabilities: [...ACTOR.capabilities] });
const NOW = new Date('2025-06-30T12:00:00Z');

/** A charge on a given day with a given cached documentation status. */
async function charge(id: number, daysAgo: number, documentationStatus: string, amount = 10_000) {
  const at = new Date('2025-06-30T12:00:00Z');
  at.setUTCDate(at.getUTCDate() - daysAgo);
  await prisma.transaction.create({
    data: {
      id,
      clientId: 1,
      cardLast4: '4412',
      driverPhone: '966551234567',
      merchantName: `MERCHANT ${id}`,
      amount,
      currency: 'SAR',
      transactionAt: at,
      documentationStatus,
    },
  });
}

beforeEach(async () => {
  await resetDatabase();
  await seedMinimalWorld();
  // Clear the seeded charges so these tests own the whole register.
  await prisma.documentMatch.deleteMany();
  await prisma.transaction.updateMany({ data: { confirmedDocumentId: null } });
  await prisma.document.deleteMany();
  await prisma.transaction.deleteMany();
});

describe('the status chips count every charge', () => {
  it('does not lose a status group when an unreadable value decodes onto it', async () => {
    // `decodeDocumentationStatus` maps anything unrecognised to MISSING so a corrupt row
    // stays visible and counts as unsettled. Two raw groups therefore land on one key —
    // and an assignment, rather than an addition, throws the first one away.
    await charge(901, 2, 'MISSING');
    await charge(902, 2, 'MISSING');
    await charge(903, 2, 'MISSING');
    await charge(904, 2, 'QUARANTINED'); // unrecognised -> decodes to MISSING

    const register = await getChargeRegister(actor(), {}, NOW);

    expect(register.statusCounts.MISSING).toBe(4);

    // Put the deliberately-corrupt row back before the global status invariant runs: this
    // test is about how the register *reads* an unreadable value, not about leaving one.
    await prisma.transaction.update({
      where: { id: 904 },
      data: { documentationStatus: 'MISSING' },
    });
  });
});

describe('the status and age filters compose', () => {
  it('never returns an undocumented charge under an active DOCUMENTED filter', async () => {
    // The age filter carries its own `documentationStatus: { not: 'DOCUMENTED' }`, and the
    // chips let both be active at once. Spread last, it silently replaced the status the
    // operator selected — so the header priced a set as documented whose every row was not.
    await charge(901, 2, 'DOCUMENTED');
    await charge(912, 20, 'MISSING');
    await charge(913, 20, 'MISSING');

    const register = await getChargeRegister(actor(), { status: 'DOCUMENTED', age: '8-30' }, NOW);

    // The combination is empty by definition — the age bands are defined over
    // undocumented charges — so the correct answer is no rows and a count of zero. What
    // must never happen is MISSING rows priced under a DOCUMENTED chip.
    for (const row of register.rows) {
      expect(row.status).toBe('DOCUMENTED');
    }
    expect(register.matchedCount).toBe(register.rows.length);

    // And the unfiltered register must still see all three, or the fix broke the query.
    const all = await getChargeRegister(actor(), {}, NOW);
    expect(all.rows).toHaveLength(3);

    // These statuses were written directly to set up the filter combination; re-derive
    // them so the global cache-consistency invariant sees the world it expects.
    await syncChargeStatuses();
  });
});
