import { readFixtureFile } from '@/fixtures';
import { MockExtractor, setExtractor } from '@/lib/extraction';
import { ingestDocument } from '@/lib/services/document-ingestion';
import {
  TransactionAlreadyDocumentedError,
  claimConfirmedDocumentSlot,
  releaseConfirmedDocumentSlot,
} from '@/lib/services/slot-claim';
import { resetDatabase, seedMinimalWorld, testPrisma } from './helpers/db';

/**
 * Review-queue behaviour.
 *
 * The server actions in `lib/actions/review.ts` are `'use server'` modules, which Jest
 * cannot invoke outside a Next request context. These harnesses mirror the action bodies
 * and, critically, call the *same* `slot-claim` helpers the actions call — so the
 * concurrency guarantee under test is the production one, not a re-implementation of it.
 */

const REVIEWER = 'reviewer';

async function confirm(matchId: number) {
  return testPrisma.$transaction(async (tx) => {
    const match = await tx.documentMatch.findUniqueOrThrow({ where: { id: matchId } });
    if (['CONFIRMED', 'AUTO_CONFIRMED', 'REJECTED'].includes(match.status)) {
      return { effect: 'ALREADY_DECIDED' as const };
    }
    const claimed = await claimConfirmedDocumentSlot(
      tx.transaction,
      match.transactionId,
      match.documentId,
    );
    if (!claimed) throw new TransactionAlreadyDocumentedError(match.transactionId);

    await tx.documentMatch.update({
      where: { id: matchId },
      data: { status: 'CONFIRMED', decidedBy: REVIEWER, decidedAt: new Date() },
    });
    await tx.documentMatch.updateMany({
      where: { documentId: match.documentId, id: { not: matchId }, status: 'CANDIDATE' },
      data: { status: 'REJECTED', decidedBy: REVIEWER, decidedAt: new Date() },
    });
    await tx.document.update({ where: { id: match.documentId }, data: { status: 'MATCHED' } });
    return { effect: 'CONFIRMED' as const };
  });
}

async function reject(matchId: number) {
  return testPrisma.$transaction(async (tx) => {
    const match = await tx.documentMatch.findUniqueOrThrow({ where: { id: matchId } });
    if (match.status === 'REJECTED') return { effect: 'ALREADY_DECIDED' as const, remaining: 0 };

    if (['CONFIRMED', 'AUTO_CONFIRMED'].includes(match.status)) {
      await releaseConfirmedDocumentSlot(tx.transaction, match.transactionId, match.documentId);
    }

    await tx.documentMatch.update({
      where: { id: matchId },
      data: { status: 'REJECTED', decidedBy: REVIEWER, decidedAt: new Date() },
    });
    const remaining = await tx.documentMatch.count({
      where: { documentId: match.documentId, status: 'CANDIDATE' },
    });
    await tx.document.update({
      where: { id: match.documentId },
      data: {
        status: remaining > 0 ? 'NEEDS_REVIEW' : 'UNMATCHED',
        failureReason: remaining > 0 ? null : 'ALL_CANDIDATES_REJECTED',
      },
    });
    return { effect: 'REJECTED' as const, remaining };
  });
}

/** Ingests the ambiguous Tamimi receipt and returns its two candidate match rows. */
async function ingestAmbiguous() {
  const result = await ingestDocument(
    {
      source: 'WHATSAPP',
      externalId: 'wamid.TAMIMI',
      senderIdentifier: '966551234567',
      bytes: readFixtureFile('whatsapp-tamimi-ambiguous'),
      mimeType: 'image/jpeg',
      filename: 'tamimi-receipt.jpg',
      receivedAt: new Date('2025-06-17T13:00:00Z'),
    },
    testPrisma,
  );

  const matches = await testPrisma.documentMatch.findMany({
    where: { documentId: result.documentId },
    orderBy: [{ confidence: 'desc' }, { transactionId: 'asc' }],
  });

  return { documentId: result.documentId, matches };
}

beforeEach(async () => {
  setExtractor(new MockExtractor());
  await resetDatabase();
  await seedMinimalWorld();
});

afterAll(async () => {
  await testPrisma.$disconnect();
});

/* -------------------------------------------------------------------------- */

describe('confirmMatch', () => {
  it('attaches the chosen candidate and rejects its siblings', async () => {
    const { documentId, matches } = await ingestAmbiguous();

    await confirm(matches[0].id);

    const after = await testPrisma.documentMatch.findMany({ where: { documentId } });
    expect(after.find((m) => m.id === matches[0].id)?.status).toBe('CONFIRMED');
    expect(after.find((m) => m.id === matches[1].id)?.status).toBe('REJECTED');
  });

  it('moves the document to MATCHED', async () => {
    const { documentId, matches } = await ingestAmbiguous();

    await confirm(matches[0].id);

    const document = await testPrisma.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(document.status).toBe('MATCHED');
  });

  it('is a no-op on a double submit rather than a second confirmation', async () => {
    const { matches } = await ingestAmbiguous();

    const first = await confirm(matches[0].id);
    const second = await confirm(matches[0].id);

    expect(first.effect).toBe('CONFIRMED');
    expect(second.effect).toBe('ALREADY_DECIDED');
  });

  it('refuses a second document for a transaction that already has one', async () => {
    // The database constraint is the guard, not an application-level if.
    const { matches } = await ingestAmbiguous();
    await confirm(matches[0].id);

    const transactionId = matches[0].transactionId;
    const otherDocument = await testPrisma.document.create({
      data: {
        source: 'WHATSAPP',
        externalId: 'wamid.SECOND-RECEIPT',
        contentHash: 'hash-of-a-different-photo',
        senderIdentifier: '966551234567',
        clientId: 1,
        driverPhone: '966551234567',
        status: 'NEEDS_REVIEW',
      },
    });
    const rivalMatch = await testPrisma.documentMatch.create({
      data: { documentId: otherDocument.id, transactionId, confidence: 0.9, signals: '{}' },
    });

    // A plain `update` here would silently overwrite the first document's confirmation.
    // The compare-and-set refuses instead.
    await expect(confirm(rivalMatch.id)).rejects.toBeInstanceOf(TransactionAlreadyDocumentedError);

    const transaction = await testPrisma.transaction.findUniqueOrThrow({
      where: { id: transactionId },
    });
    expect(transaction.confirmedDocumentId).toBe(matches[0].documentId);
    expect(transaction.confirmedDocumentId).not.toBe(otherDocument.id);
  });

  it('refuses to attach a document that is already confirmed for another transaction', async () => {
    const { documentId, matches } = await ingestAmbiguous();
    await confirm(matches[0].id);

    // The @unique index on confirmedDocumentId is what catches this direction.
    await expect(
      testPrisma.transaction.update({
        where: { id: matches[1].transactionId },
        data: { confirmedDocumentId: documentId },
      }),
    ).rejects.toThrow(/Unique constraint|P2002/i);
  });

  it('survives two reviewers confirming different candidates at the same time', async () => {
    const { documentId, matches } = await ingestAmbiguous();

    const outcomes = await Promise.allSettled([confirm(matches[0].id), confirm(matches[1].id)]);
    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');

    // Whatever the interleaving, the document ends with exactly one confirmed match.
    const confirmed = await testPrisma.documentMatch.count({
      where: { documentId, status: 'CONFIRMED' },
    });
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    expect(confirmed).toBe(1);
  });
});

describe('rejectMatch', () => {
  it('leaves the document in review while other candidates remain', async () => {
    const { documentId, matches } = await ingestAmbiguous();

    const result = await reject(matches[0].id);

    expect(result.effect).toBe('REJECTED');
    const document = await testPrisma.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(document.status).toBe('NEEDS_REVIEW');
  });

  it('returns the document to UNMATCHED once every candidate is rejected', async () => {
    const { documentId, matches } = await ingestAmbiguous();

    await reject(matches[0].id);
    await reject(matches[1].id);

    const document = await testPrisma.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(document.status).toBe('UNMATCHED');
    expect(document.failureReason).toBe('ALL_CANDIDATES_REJECTED');
  });

  it('is a no-op on a double submit', async () => {
    const { matches } = await ingestAmbiguous();

    await reject(matches[0].id);
    const second = await reject(matches[0].id);

    expect(second.effect).toBe('ALREADY_DECIDED');
  });

  it('detaches a confirmed match and frees the transaction for the correct document', async () => {
    const { matches } = await ingestAmbiguous();
    await confirm(matches[0].id);

    // Rejecting a *confirmed* match is the undo path — it must release the slot.
    const result = await reject(matches[0].id);
    expect(result.effect).toBe('REJECTED');

    const transaction = await testPrisma.transaction.findUniqueOrThrow({
      where: { id: matches[0].transactionId },
    });
    expect(transaction.confirmedDocumentId).toBeNull();
  });

  it('lets a rejected-then-reconsidered candidate be confirmed after the slot is freed', async () => {
    const { matches } = await ingestAmbiguous();
    await confirm(matches[0].id);
    await reject(matches[0].id);

    await testPrisma.documentMatch.update({
      where: { id: matches[1].id },
      data: { status: 'CANDIDATE' },
    });

    await expect(confirm(matches[1].id)).resolves.toEqual({ effect: 'CONFIRMED' });
  });
});
