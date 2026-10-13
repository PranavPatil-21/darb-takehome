import { getCoveragePosition, periodOf, vatWithin, VAT_RATE } from '@/lib/ui/coverage';
import { resetDatabase, seedMinimalWorld, testPrisma , syncChargeStatuses } from './helpers/db';

/**
 * The compliance position shown on the front page.
 *
 * These numbers are the ones an operator would quote to their accountant, so the
 * arithmetic is tested rather than eyeballed. The VAT extraction in particular is the
 * kind of thing that looks right, ships, and overstates a tax position by a few percent
 * forever.
 */

beforeEach(async () => {
  await resetDatabase();
  await seedMinimalWorld();
});

afterAll(async () => {
  await testPrisma.$disconnect();
});

describe('extracting VAT from a VAT-inclusive amount', () => {
  it('takes the tax out of the gross, not a further 15% on top of it', () => {
    // SAR 115.00 charged at 15% contains exactly SAR 15.00 of VAT. The naive
    // `gross * 0.15` returns 17.25 and overstates every recoverable figure downstream.
    expect(vatWithin(11_500)).toBe(1_500);
    expect(vatWithin(11_500)).not.toBe(Math.round(11_500 * VAT_RATE));
  });

  it('is the inverse of adding VAT, for any net amount', () => {
    for (const net of [100, 4_500, 12_500, 487_500, 1_000_003]) {
      const gross = Math.round(net * (1 + VAT_RATE));
      // Allow a halala of slack: both directions round, so they cannot be exact inverses.
      expect(Math.abs(vatWithin(gross) - (gross - net))).toBeLessThanOrEqual(1);
    }
  });

  it('returns whole minor units — money is never a float here', () => {
    for (const gross of [1, 7, 33, 4_501, 99_999]) {
      expect(Number.isInteger(vatWithin(gross))).toBe(true);
    }
  });

  it('handles zero without producing NaN', () => {
    expect(vatWithin(0)).toBe(0);
  });
});

describe('the reporting period', () => {
  it('is derived from the data, not from the clock', () => {
    // Anchoring on `new Date()` would make this page read 0% covered to anyone running
    // the repository after the seed data's month has passed — which is everyone.
    const period = periodOf(new Date('2025-06-17T12:10:00Z'));

    expect(period?.label).toBe('June 2025');
    expect(period?.from.toISOString()).toBe('2025-06-01T00:00:00.000Z');
    expect(period?.to.getUTCDate()).toBe(30);
  });

  it('covers the last day of a 31-day month', () => {
    expect(periodOf(new Date('2025-07-02T00:00:00Z'))?.to.getUTCDate()).toBe(31);
  });

  it('handles a December charge without rolling into the wrong year', () => {
    const period = periodOf(new Date('2025-12-20T00:00:00Z'));
    expect(period?.label).toBe('December 2025');
    expect(period?.to.getUTCFullYear()).toBe(2025);
    expect(period?.to.getUTCMonth()).toBe(11);
  });

  it('is absent when there are no charges at all', () => {
    expect(periodOf(null)).toBeNull();
  });
});

describe('the coverage position', () => {
  it('measures coverage by value rather than by count', async () => {
    // Ten documented coffees do not offset one undocumented fuel run, and a count-based
    // percentage would claim they do.
    await testPrisma.transaction.deleteMany();
    await testPrisma.transaction.createMany({
      data: [
        { id: 101, clientId: 1, cardLast4: '4412', merchantName: 'SMALL ONE', amount: 1_000, transactionAt: new Date('2025-06-10T10:00:00Z') },
        { id: 102, clientId: 1, cardLast4: '4412', merchantName: 'BIG ONE', amount: 99_000, transactionAt: new Date('2025-06-11T10:00:00Z') },
      ],
    });
    // Document the small one only: half the charges, but 1% of the money.
    const document = await testPrisma.document.create({
      data: {
        source: 'WHATSAPP',
        externalId: 'wamid.COVERAGE',
        contentHash: 'hash-coverage',
        senderIdentifier: '966551234567',
        clientId: 1,
        status: 'MATCHED',
      },
    });
    // The slot *and* the match it mirrors. Writing only the slot produces a state no
    // write path can reach — the registers read `DocumentMatch.status` as the fact — and
    // the global slot-agreement invariant rejects it, correctly.
    await testPrisma.documentMatch.create({
      data: {
        documentId: document.id,
        transactionId: 101,
        confidence: 0.97,
        signals: '{}',
        status: 'AUTO_CONFIRMED',
        decidedBy: 'system',
        decidedAt: new Date(),
      },
    });
    await testPrisma.transaction.update({
      where: { id: 101 },
      data: { confirmedDocumentId: document.id },
    });
    // Written directly rather than through `confirmMatch`, so the cached status has to
    // be brought back in line the same way a backfill would.
    await syncChargeStatuses();

    const position = await getCoveragePosition(testPrisma);

    expect(position.documentedCount).toBe(1);
    expect(position.undocumentedCount).toBe(1);
    expect(position.undocumentedSpend).toBe(99_000);
    expect(Math.round(position.coverageByValue * 100)).toBe(1);
  });

  it('reports full coverage rather than dividing by zero when there are no charges', async () => {
    await testPrisma.transaction.deleteMany();

    const position = await getCoveragePosition(testPrisma);

    expect(position.chargeCount).toBe(0);
    expect(position.coverageByValue).toBe(1);
    expect(Number.isNaN(position.coverageByValue)).toBe(false);
    expect(position.vatAtRisk).toBe(0);
    expect(position.period).toBeNull();
  });

  it('separates work waiting on a person from work waiting on a charge', async () => {
    // These two piles need different actions — one is a reviewer's queue, the other
    // resolves itself when the acquirer posts — so a single "outstanding" number would
    // hide the only useful distinction.
    await testPrisma.document.createMany({
      data: [
        { source: 'WHATSAPP', externalId: 'w.1', contentHash: 'h1', senderIdentifier: '966551234567', clientId: 1, status: 'NEEDS_REVIEW' },
        { source: 'WHATSAPP', externalId: 'w.2', contentHash: 'h2', senderIdentifier: '966551234567', clientId: 1, status: 'NEEDS_REVIEW' },
        { source: 'WHATSAPP', externalId: 'w.3', contentHash: 'h3', senderIdentifier: '966551234567', clientId: 1, status: 'UNMATCHED' },
      ],
    });

    const position = await getCoveragePosition(testPrisma);

    expect(position.awaitingDecision).toBe(2);
    expect(position.awaitingCharge).toBe(1);
  });

  it('derives VAT at risk from undocumented spend', async () => {
    const position = await getCoveragePosition(testPrisma);
    expect(position.vatAtRisk).toBe(vatWithin(position.undocumentedSpend));
  });
});
