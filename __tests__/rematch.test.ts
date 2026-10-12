import { readFixtureFile } from '@/fixtures';
import { MockExtractor, setExtractor } from '@/lib/extraction';
import type { DocumentExtractor, ExtractedDocument } from '@/lib/extraction/types';
import { ingestDocument } from '@/lib/services/document-ingestion';
import { rematchDocument, rematchUnmatchedDocuments } from '@/lib/services/rematch';
import { releaseConfirmedDocumentSlot } from '@/lib/services/slot-claim';
import { resetDatabase, seedMinimalWorld, testPrisma } from './helpers/db';

/**
 * Re-matching documents that arrived before their transaction.
 *
 * A driver photographs a receipt at the pump; the acquirer posts the charge hours later.
 * Nothing about the document will ever change, so the trigger has to come from the
 * transaction side.
 */

const orphan = {
  source: 'WHATSAPP' as const,
  externalId: 'wamid.KUDU',
  senderIdentifier: '966551234567',
  bytes: readFixtureFile('whatsapp-orphan-receipt'),
  mimeType: 'image/jpeg',
  filename: 'kudu-receipt.jpg',
  receivedAt: new Date('2025-06-19T14:00:00Z'),
};

/** The transaction that eventually arrives for the orphaned Kudu receipt. */
const lateArrival = {
  id: 99,
  clientId: 1,
  cardLast4: '4412',
  driverPhone: '966551234567',
  merchantName: 'KUDU REST 118 RUH',
  amount: 3300,
  transactionAt: new Date('2025-06-19T13:12:00Z'),
};

beforeEach(async () => {
  setExtractor(new MockExtractor());
  await resetDatabase();
  await seedMinimalWorld();
});

afterAll(async () => {
  await testPrisma.$disconnect();
});

describe('document arriving before its transaction', () => {
  it('lands in UNMATCHED rather than FAILED, so it stays retryable', async () => {
    const result = await ingestDocument(orphan, testPrisma);

    expect(result.status).toBe('UNMATCHED');
    expect(result.match?.reason).toBe('NO_PLAUSIBLE_CANDIDATE');
  });

  it('is picked up by the sweep once the transaction arrives', async () => {
    const { documentId } = await ingestDocument(orphan, testPrisma);
    await testPrisma.transaction.create({ data: lateArrival });

    const outcomes = await rematchUnmatchedDocuments({}, testPrisma);

    expect(outcomes).toEqual([
      expect.objectContaining({ documentId, previousStatus: 'UNMATCHED', status: 'MATCHED' }),
    ]);
  });

  it('claims the late transaction on re-match', async () => {
    const { documentId } = await ingestDocument(orphan, testPrisma);
    await testPrisma.transaction.create({ data: lateArrival });

    await rematchUnmatchedDocuments({}, testPrisma);

    const transaction = await testPrisma.transaction.findUniqueOrThrow({ where: { id: 99 } });
    expect(transaction.confirmedDocumentId).toBe(documentId);
  });

  it('does not re-run OCR — the stored extraction is reused', async () => {
    const { documentId } = await ingestDocument(orphan, testPrisma);
    await testPrisma.transaction.create({ data: lateArrival });

    class ExplodingExtractor implements DocumentExtractor {
      async extract(): Promise<ExtractedDocument> {
        throw new Error('OCR must not be called during a re-match');
      }
    }
    setExtractor(new ExplodingExtractor());

    const outcome = await rematchDocument(documentId, testPrisma);

    expect(outcome?.status).toBe('MATCHED');
  });

  it('leaves the document UNMATCHED when the sweep finds nothing new', async () => {
    const { documentId } = await ingestDocument(orphan, testPrisma);

    const outcomes = await rematchUnmatchedDocuments({}, testPrisma);

    expect(outcomes).toEqual([expect.objectContaining({ documentId, changed: false })]);
  });

  it('is idempotent — sweeping twice does not duplicate matches', async () => {
    const { documentId } = await ingestDocument(orphan, testPrisma);
    await testPrisma.transaction.create({ data: lateArrival });

    await rematchUnmatchedDocuments({}, testPrisma);
    await rematchUnmatchedDocuments({}, testPrisma);

    expect(await testPrisma.documentMatch.count({ where: { documentId } })).toBe(1);
  });
});

describe('sweep scope', () => {
  it('does not disturb documents a human is already reviewing', async () => {
    const ambiguous = await ingestDocument(
      {
        ...orphan,
        externalId: 'wamid.TAMIMI',
        bytes: readFixtureFile('whatsapp-tamimi-ambiguous'),
        receivedAt: new Date('2025-06-17T13:00:00Z'),
      },
      testPrisma,
    );
    expect(ambiguous.status).toBe('NEEDS_REVIEW');

    await rematchUnmatchedDocuments({}, testPrisma);

    const document = await testPrisma.document.findUniqueOrThrow({
      where: { id: ambiguous.documentId },
    });
    expect(document.status).toBe('NEEDS_REVIEW');
  });

  it('leaves a document whose sender is still unregistered exactly as it was', async () => {
    const { documentId } = await ingestDocument(
      { ...orphan, externalId: 'wamid.STRANGER', senderIdentifier: '966500000000' },
      testPrisma,
    );

    const outcomes = await rematchUnmatchedDocuments({}, testPrisma);

    // Examined and left alone, rather than excluded from the query. The distinction
    // matters: the sweep is the only thing that can notice a sender has been registered
    // since ingestion, so it has to look.
    expect(outcomes).toEqual([
      expect.objectContaining({ documentId, status: 'UNMATCHED', changed: false }),
    ]);
    const document = await testPrisma.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(document.clientId).toBeNull();
  });

  it('rescues a document once its sender is registered', async () => {
    // The promise `document-ingestion.ts` makes when it parks an unknown sender in
    // UNMATCHED rather than FAILED: registering the sender later resolves it without
    // re-ingesting. That promise is only keepable because extraction happens before
    // scoping — the bytes are gone once the webhook returns, so a document skipped at
    // extraction time could never be recovered.
    const { documentId } = await ingestDocument(
      { ...orphan, externalId: 'wamid.LATEREG', senderIdentifier: '966500000000' },
      testPrisma,
    );

    // The extraction must already be on the row, with no bytes available to redo it.
    const beforeRegistration = await testPrisma.document.findUniqueOrThrow({
      where: { id: documentId },
    });
    expect(beforeRegistration.merchantName).toBe('Kudu Restaurant');
    expect(beforeRegistration.totalAmount).toBe(3300);

    await testPrisma.senderIdentity.create({
      data: {
        identifier: '966500000000',
        channel: 'WHATSAPP',
        clientId: 1,
        driverPhone: '966551234567',
        label: 'Registered after the fact',
      },
    });
    await testPrisma.transaction.create({ data: lateArrival });

    await rematchUnmatchedDocuments({}, testPrisma);

    const document = await testPrisma.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(document.clientId).toBe(1);
    expect(document.status).toBe('MATCHED');
  });

  it('can be narrowed to one client', async () => {
    await ingestDocument(orphan, testPrisma);
    await testPrisma.transaction.create({ data: lateArrival });

    expect(await rematchUnmatchedDocuments({ clientId: 2 }, testPrisma)).toEqual([]);
    expect(await rematchUnmatchedDocuments({ clientId: 1 }, testPrisma)).toHaveLength(1);
  });
});

describe('the sweep respects human decisions', () => {
  /**
   * A rejection is a decision about a *pairing*, and it is permanent.
   *
   * The sweep selects on `status: 'UNMATCHED'`, and a document reaches that status two
   * ways: it never matched anything, or a reviewer rejected everything it did match.
   * Those look identical in the column. Re-scoring the second kind finds the same best
   * candidate it found the first time, re-attaches it, and overwrites `decidedBy` from
   * the reviewer back to `system` — so the record that a human ever said no is gone, in
   * a product whose entire purpose is producing an auditable trail.
   */
  it('does not resurrect a match the reviewer rejected', async () => {
    const result = await ingestDocument(
      {
        source: 'WHATSAPP',
        externalId: 'wamid.REJECTED',
        senderIdentifier: '966551234567',
        bytes: readFixtureFile('whatsapp-alfanar-exact'),
        mimeType: 'image/jpeg',
        filename: 'alfanar.jpg',
        receivedAt: new Date('2025-06-14T12:00:00Z'),
      },
      testPrisma,
    );
    expect(result.status).toBe('MATCHED');

    const match = await testPrisma.documentMatch.findFirstOrThrow({
      where: { documentId: result.documentId },
    });

    // Mirrors the body of `rejectMatch` in lib/actions/review.ts, calling the same
    // slot-claim helper the action calls — the 'use server' module cannot be invoked
    // from Jest outside a Next request context.
    await testPrisma.$transaction(async (tx) => {
      await releaseConfirmedDocumentSlot(tx.transaction, match.transactionId, match.documentId);
      await tx.documentMatch.update({
        where: { id: match.id },
        data: { status: 'REJECTED', decidedBy: 'reviewer', decidedAt: new Date() },
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
    });

    const afterReject = await testPrisma.document.findUniqueOrThrow({
      where: { id: result.documentId },
    });
    expect(afterReject.status).toBe('UNMATCHED');

    // An unrelated transaction posts, triggering the sweep.
    await testPrisma.transaction.create({
      data: {
        clientId: 1,
        cardLast4: '9999',
        driverPhone: '966551234567',
        merchantName: 'SOMETHING ENTIRELY ELSE',
        amount: 111,
        transactionAt: new Date('2025-06-20T10:00:00Z'),
      },
    });
    await rematchUnmatchedDocuments({ clientId: 1 }, testPrisma);

    const afterSweep = await testPrisma.documentMatch.findUniqueOrThrow({
      where: { id: match.id },
    });
    const document = await testPrisma.document.findUniqueOrThrow({
      where: { id: result.documentId },
    });
    const transaction = await testPrisma.transaction.findUniqueOrThrow({
      where: { id: match.transactionId },
    });

    expect(afterSweep.status).toBe('REJECTED');
    expect(afterSweep.decidedBy).toBe('reviewer');
    expect(document.status).toBe('UNMATCHED');
    expect(transaction.confirmedDocumentId).toBeNull();
  });

  it('still matches a genuinely new transaction after an unrelated rejection', async () => {
    // The rejection closes one pairing, not the document. A receipt whose real charge
    // posts later must still find it, or "reject" would quietly mean "discard forever".
    const result = await ingestDocument(
      {
        source: 'WHATSAPP',
        externalId: 'wamid.ORPHAN2',
        senderIdentifier: '966551234567',
        bytes: readFixtureFile('whatsapp-orphan-receipt'),
        mimeType: 'image/jpeg',
        filename: 'kudu.jpg',
        receivedAt: new Date('2025-06-19T14:00:00Z'),
      },
      testPrisma,
    );
    expect(result.status).toBe('UNMATCHED');

    // The transaction it was actually waiting for posts.
    await testPrisma.transaction.create({
      data: {
        clientId: 1,
        cardLast4: '4412',
        driverPhone: '966551234567',
        merchantName: 'KUDU REST 118 RUH',
        amount: 3300,
        transactionAt: new Date('2025-06-19T13:12:00Z'),
      },
    });
    await rematchUnmatchedDocuments({ clientId: 1 }, testPrisma);

    const document = await testPrisma.document.findUniqueOrThrow({
      where: { id: result.documentId },
    });
    expect(document.status).toBe('MATCHED');
  });
});
