import { contentHashOf, readFixtureFile } from '@/fixtures';
import { setExtractor, MockExtractor } from '@/lib/extraction';
import type { DocumentExtractor, ExtractedDocument } from '@/lib/extraction/types';
import { ingestDocument, normaliseSenderIdentifier } from '@/lib/services/document-ingestion';
import { resetDatabase, seedMinimalWorld, testPrisma } from './helpers/db';

/**
 * Ingestion-pipeline tests.
 *
 * These run against a real SQLite database rather than a mocked Prisma client, because
 * the properties under test — idempotency, and one confirmed document per transaction —
 * are enforced by unique constraints. A mock would assert that the code *intends* to be
 * idempotent; only the database proves that it *is*.
 */

const whatsappInput = (overrides: Partial<Parameters<typeof ingestDocument>[0]> = {}) => ({
  source: 'WHATSAPP' as const,
  externalId: 'wamid.TEST001',
  senderIdentifier: '966551234567',
  bytes: readFixtureFile('whatsapp-alfanar-exact'),
  mimeType: 'image/jpeg',
  filename: 'alfanar-receipt.jpg',
  receivedAt: new Date('2025-06-14T12:00:00Z'),
  ...overrides,
});

beforeEach(async () => {
  setExtractor(new MockExtractor());
  await resetDatabase();
  await seedMinimalWorld();
});

afterAll(async () => {
  await testPrisma.$disconnect();
});

/* -------------------------------------------------------------------------- */

describe('happy path', () => {
  it('creates a document and auto-matches it to the right transaction', async () => {
    const result = await ingestDocument(whatsappInput(), testPrisma);

    expect(result.disposition).toBe('INGESTED');
    expect(result.status).toBe('MATCHED');
    expect(result.match?.outcome).toBe('AUTO_MATCHED');
    expect(result.match?.candidates[0].transactionId).toBe(1);
  });

  it('persists the extraction onto the document row', async () => {
    const { documentId } = await ingestDocument(whatsappInput(), testPrisma);

    const document = await testPrisma.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(document.merchantName).toBe('Alfanar Fuel Station');
    expect(document.totalAmount).toBe(12500);
    expect(document.cardLast4).toBe('4412');
    expect(document.contentHash).toBe(contentHashOf('whatsapp-alfanar-exact'));
  });

  it('claims the transaction confirmed-document slot on auto-match', async () => {
    const { documentId } = await ingestDocument(whatsappInput(), testPrisma);

    const transaction = await testPrisma.transaction.findUniqueOrThrow({ where: { id: 1 } });
    expect(transaction.confirmedDocumentId).toBe(documentId);
  });

  it('records the signal breakdown so the score is explainable', async () => {
    const { documentId } = await ingestDocument(whatsappInput(), testPrisma);

    const match = await testPrisma.documentMatch.findFirstOrThrow({ where: { documentId } });
    expect(match.status).toBe('AUTO_CONFIRMED');
    expect(match.decidedBy).toBe('system');
    expect(JSON.parse(match.signals)).toEqual(
      expect.objectContaining({ amount: 1, cardLast4: 1, date: 1 }),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Edge case 4 — duplicate submission                                          */
/* -------------------------------------------------------------------------- */

describe('edge case 4: idempotency', () => {
  it('does not create a second document when the provider redelivers the same message', async () => {
    const first = await ingestDocument(whatsappInput(), testPrisma);
    const second = await ingestDocument(whatsappInput(), testPrisma);

    expect(second.disposition).toBe('DUPLICATE');
    expect(second.documentId).toBe(first.documentId);
    expect(await testPrisma.document.count()).toBe(1);
  });

  it('collapses the same photo sent twice under different message ids', async () => {
    const first = await ingestDocument(whatsappInput({ externalId: 'wamid.FIRST' }), testPrisma);
    const second = await ingestDocument(whatsappInput({ externalId: 'wamid.SECOND' }), testPrisma);

    expect(second.disposition).toBe('DUPLICATE');
    expect(second.documentId).toBe(first.documentId);
    expect(await testPrisma.document.count()).toBe(1);
  });

  it('does not create duplicate match rows on redelivery', async () => {
    await ingestDocument(whatsappInput(), testPrisma);
    await ingestDocument(whatsappInput(), testPrisma);

    expect(await testPrisma.documentMatch.count()).toBe(1);
  });

  it('survives concurrent redelivery of the same message', async () => {
    // The read-then-write check cannot save us here; only the unique constraint can.
    const results = await Promise.all([
      ingestDocument(whatsappInput(), testPrisma),
      ingestDocument(whatsappInput(), testPrisma),
      ingestDocument(whatsappInput(), testPrisma),
    ]);

    expect(await testPrisma.document.count()).toBe(1);
    const ids = new Set(results.map((result) => result.documentId));
    expect(ids.size).toBe(1);
  });

  it('collapses identical file content regardless of which sender submitted it', async () => {
    // The brief is explicit: "the same file content (hash it) must not create a duplicate
    // Document", and `contentHash` is globally unique. So a second driver forwarding the
    // same photo resolves to the first driver's document rather than creating its own.
    await testPrisma.senderIdentity.create({
      data: {
        identifier: '966557778888',
        channel: 'WHATSAPP',
        clientId: 1,
        driverPhone: '966557778888',
        label: 'Omar Nasser',
      },
    });

    const first = await ingestDocument(whatsappInput(), testPrisma);
    const second = await ingestDocument(
      whatsappInput({ externalId: 'wamid.OTHER', senderIdentifier: '966557778888' }),
      testPrisma,
    );

    expect(second.disposition).toBe('DUPLICATE');
    expect(second.documentId).toBe(first.documentId);
    expect(await testPrisma.document.count()).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Failure isolation                                                           */
/* -------------------------------------------------------------------------- */

describe('failure isolation', () => {
  class ThrowingExtractor implements DocumentExtractor {
    async extract(): Promise<ExtractedDocument> {
      throw new Error('OCR provider returned 503');
    }
  }

  it('lands a document in FAILED rather than throwing when extraction dies', async () => {
    setExtractor(new ThrowingExtractor());

    const result = await ingestDocument(whatsappInput(), testPrisma);

    expect(result.disposition).toBe('FAILED');
    expect(result.status).toBe('FAILED');
    expect(result.detail).toContain('503');
  });

  it('keeps the document row even though extraction failed', async () => {
    setExtractor(new ThrowingExtractor());

    const { documentId } = await ingestDocument(whatsappInput(), testPrisma);

    const document = await testPrisma.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(document.status).toBe('FAILED');
    expect(document.failureReason).toContain('503');
    // The webhook is still idempotent for a failed document — we accepted the message.
    expect(document.externalId).toBe('wamid.TEST001');
  });

  it('does not retry extraction on redelivery of a failed document', async () => {
    setExtractor(new ThrowingExtractor());
    await ingestDocument(whatsappInput(), testPrisma);

    const second = await ingestDocument(whatsappInput(), testPrisma);

    expect(second.disposition).toBe('DUPLICATE');
    expect(second.status).toBe('FAILED');
  });

  it('reaches a terminal state for garbage OCR output without throwing', async () => {
    const result = await ingestDocument(
      whatsappInput({
        externalId: 'wamid.GARBAGE',
        bytes: readFixtureFile('whatsapp-blurry-garbage'),
      }),
      testPrisma,
    );

    expect(result.status).toBe('UNMATCHED');
    expect(result.match?.reason).toBe('UNUSABLE_EXTRACTION');
  });
});

/* -------------------------------------------------------------------------- */
/* Scoping and routing                                                         */
/* -------------------------------------------------------------------------- */

describe('scoping', () => {
  it('stores but does not match a document from an unregistered sender', async () => {
    const result = await ingestDocument(
      whatsappInput({ senderIdentifier: '966500000000', externalId: 'wamid.UNKNOWN' }),
      testPrisma,
    );

    expect(result.status).toBe('UNMATCHED');
    expect(result.detail).toContain('No sender identity');
    expect(await testPrisma.document.count()).toBe(1);
  });

  it('routes an emailed invoice to the client-scoped corporate transaction', async () => {
    const result = await ingestDocument(
      {
        source: 'EMAIL',
        externalId: 'msg_8f2a1',
        senderIdentifier: 'FleetOps@Rawabi-Logistics.example',
        bytes: readFixtureFile('email-alfanar-invoice'),
        mimeType: 'application/pdf',
        filename: 'invoice-99812.pdf',
        receivedAt: new Date('2025-06-14T09:30:00Z'),
      },
      testPrisma,
    );

    expect(result.status).toBe('MATCHED');
    // Transaction 11 has no driverPhone — reachable only through the client-wide scope.
    expect(result.match?.candidates[0].transactionId).toBe(11);
  });

  it('normalises sender identifiers before looking them up', () => {
    expect(normaliseSenderIdentifier('EMAIL', '  Billing@Alfanar-Fuel.com.SA ')).toBe(
      'billing@alfanar-fuel.com.sa',
    );
    expect(normaliseSenderIdentifier('WHATSAPP', '+966 55 123 4567')).toBe('966551234567');
  });
});

describe('ambiguity routing', () => {
  it('persists both candidates and sends the document to review', async () => {
    const result = await ingestDocument(
      whatsappInput({
        externalId: 'wamid.TAMIMI',
        bytes: readFixtureFile('whatsapp-tamimi-ambiguous'),
      }),
      testPrisma,
    );

    expect(result.status).toBe('NEEDS_REVIEW');

    const matches = await testPrisma.documentMatch.findMany({
      where: { documentId: result.documentId },
      orderBy: { confidence: 'desc' },
    });
    expect(matches).toHaveLength(2);
    expect(matches.every((match) => match.status === 'CANDIDATE')).toBe(true);
    expect(matches.map((m) => m.transactionId).sort()).toEqual([6, 7]);
  });

  it('leaves the transaction slots unclaimed while a human decides', async () => {
    await ingestDocument(
      whatsappInput({
        externalId: 'wamid.TAMIMI',
        bytes: readFixtureFile('whatsapp-tamimi-ambiguous'),
      }),
      testPrisma,
    );

    const transactions = await testPrisma.transaction.findMany({ where: { id: { in: [6, 7] } } });
    expect(transactions.every((t) => t.confirmedDocumentId === null)).toBe(true);
  });
});
