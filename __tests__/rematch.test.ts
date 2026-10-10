import { readFixtureFile } from '@/fixtures';
import { MockExtractor, setExtractor } from '@/lib/extraction';
import type { DocumentExtractor, ExtractedDocument } from '@/lib/extraction/types';
import { ingestDocument } from '@/lib/services/document-ingestion';
import { rematchDocument, rematchUnmatchedDocuments } from '@/lib/services/rematch';
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

  it('skips documents that could never be scoped to a client', async () => {
    await ingestDocument(
      { ...orphan, externalId: 'wamid.STRANGER', senderIdentifier: '966500000000' },
      testPrisma,
    );

    const outcomes = await rematchUnmatchedDocuments({}, testPrisma);

    expect(outcomes).toEqual([]);
  });

  it('can be narrowed to one client', async () => {
    await ingestDocument(orphan, testPrisma);
    await testPrisma.transaction.create({ data: lateArrival });

    expect(await rematchUnmatchedDocuments({ clientId: 2 }, testPrisma)).toEqual([]);
    expect(await rematchUnmatchedDocuments({ clientId: 1 }, testPrisma)).toHaveLength(1);
  });
});
