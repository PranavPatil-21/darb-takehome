import { confirmMatch, rejectMatch } from '@/lib/actions/review';
import { ingestDocument } from '@/lib/services/document-ingestion';
import { recomputeDocumentationStatus } from '@/lib/services/charge-status';
import { readFixtureFile } from '@/fixtures';
import { MockExtractor, setExtractor } from '@/lib/extraction';
import { resetDatabase, seedMinimalWorld, testPrisma } from './helpers/db';
import { expectStatusesConsistent } from './helpers/invariants';
import { runAction } from './helpers/actions';
import prisma from '@/lib/prisma';

/**
 * The materialised documentation status.
 *
 * The column exists so the register can filter and count in SQL instead of loading every
 * charge into Node to compute the same thing. That only holds if the column is always
 * right, so these tests are about the invariant rather than about any one screen.
 */

beforeEach(async () => {
  setExtractor(new MockExtractor());
  await resetDatabase();
  await seedMinimalWorld();
});

describe('the column tracks the derivation', () => {
  test('a freshly seeded charge with no documents is MISSING', async () => {
    const charge = await testPrisma.transaction.findFirstOrThrow({ select: { documentationStatus: true } });
    expect(charge.documentationStatus).toBe('MISSING');
    await expectStatusesConsistent(testPrisma);
  });

  test('ingesting a document that auto-matches moves its charge to DOCUMENTED', async () => {
    const result = await ingestDocument(
      {
        source: 'WHATSAPP',
        externalId: 'wamid.EXACT',
        senderIdentifier: '966551234567',
        bytes: readFixtureFile('whatsapp-alfanar-exact'),
        mimeType: 'image/jpeg',
        filename: 'r.jpg',
        receivedAt: new Date('2025-06-14T12:00:00Z'),
      },
      testPrisma,
    );

    expect(result.match?.outcome).toBe('AUTO_MATCHED');

    const charge = await testPrisma.transaction.findFirstOrThrow({
      where: { confirmedDocumentId: { not: null } },
      select: { documentationStatus: true },
    });
    expect(charge.documentationStatus).toBe('DOCUMENTED');
    await expectStatusesConsistent(testPrisma);
  });

  test('a document that lands in review moves its charges to IN_REVIEW', async () => {
    await ingestDocument(
      {
        source: 'WHATSAPP',
        externalId: 'wamid.TAMIMI',
        senderIdentifier: '966551234567',
        bytes: readFixtureFile('whatsapp-tamimi-ambiguous'),
        mimeType: 'image/jpeg',
        filename: 'r.jpg',
        receivedAt: new Date('2025-06-17T13:00:00Z'),
      },
      testPrisma,
    );

    const inReview = await testPrisma.transaction.count({
      where: { documentationStatus: 'IN_REVIEW' },
    });
    expect(inReview).toBeGreaterThan(0);
    await expectStatusesConsistent(testPrisma);
  });

  test('confirming a candidate settles its charge and releases the siblings', async () => {
    const { documentId } = await ingestDocument(
      {
        source: 'WHATSAPP',
        externalId: 'wamid.TAMIMI2',
        senderIdentifier: '966551234567',
        bytes: readFixtureFile('whatsapp-tamimi-ambiguous'),
        mimeType: 'image/jpeg',
        filename: 'r.jpg',
        receivedAt: new Date('2025-06-17T13:00:00Z'),
      },
      testPrisma,
    );

    const matches = await testPrisma.documentMatch.findMany({ where: { documentId } });
    await runAction(confirmMatch, matches[0]!.id);

    const winner = await prisma.transaction.findUniqueOrThrow({
      where: { id: matches[0]!.transactionId },
      select: { documentationStatus: true },
    });
    const loser = await prisma.transaction.findUniqueOrThrow({
      where: { id: matches[1]!.transactionId },
      select: { documentationStatus: true },
    });

    expect(winner.documentationStatus).toBe('DOCUMENTED');
    // Its only candidate was rejected when the sibling won.
    expect(loser.documentationStatus).toBe('REJECTED');
    await expectStatusesConsistent();
  });

  test('rejecting a candidate leaves its charge REJECTED, not MISSING', async () => {
    // REJECTED outranks MISSING deliberately: a charge somebody has already ruled a
    // receipt out for is not the same as one nothing has ever been proposed for, and the
    // cached column has to preserve that distinction like the derivation does.
    const { documentId } = await ingestDocument(
      {
        source: 'WHATSAPP',
        externalId: 'wamid.TAMIMI3',
        senderIdentifier: '966551234567',
        bytes: readFixtureFile('whatsapp-tamimi-ambiguous'),
        mimeType: 'image/jpeg',
        filename: 'r.jpg',
        receivedAt: new Date('2025-06-17T13:00:00Z'),
      },
      testPrisma,
    );

    const match = await testPrisma.documentMatch.findFirstOrThrow({ where: { documentId } });
    await runAction(rejectMatch, match.id);

    const charge = await prisma.transaction.findUniqueOrThrow({
      where: { id: match.transactionId },
      select: { documentationStatus: true },
    });
    expect(charge.documentationStatus).toBe('REJECTED');
    await expectStatusesConsistent();
  });

  test('recompute is idempotent', async () => {
    const charge = await testPrisma.transaction.findFirstOrThrow({ select: { id: true } });
    const first = await recomputeDocumentationStatus(testPrisma, charge.id);
    const second = await recomputeDocumentationStatus(testPrisma, charge.id);
    expect(second).toBe(first);
    await expectStatusesConsistent(testPrisma);
  });
});

describe('the column is what the register filters on', () => {
  test('counting by status needs no match rows loaded', async () => {
    // The point of the column: this is a groupBy on one indexed column, not a scan of
    // every charge and its matches.
    const counts = await testPrisma.transaction.groupBy({
      by: ['documentationStatus'],
      _count: true,
    });

    const total = counts.reduce((sum, row) => sum + row._count, 0);
    expect(total).toBe(await testPrisma.transaction.count());
  });
});
