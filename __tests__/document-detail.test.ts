import { getDocumentDetail } from '@/lib/platform/document-detail';
import { ingestDocument } from '@/lib/services/document-ingestion';
import { readFixtureFile } from '@/fixtures';
import { MockExtractor, setExtractor } from '@/lib/extraction';
import { resetDatabase, seedMinimalWorld, testPrisma } from './helpers/db';

/**
 * The journey of one document.
 *
 * Charges had a detail page; documents did not, which made the Documents register a wall
 * of rows nothing could be opened from — and left the product asymmetric in the one place
 * it is about pairing two things. This answers the question the charge page cannot: what
 * arrived, what was read out of it, what it was scored against, and what became of it.
 */

const ACTOR = {
  id: 'tester',
  displayName: 'Tester',
  capabilities: ['view', 'decide'] as const,
  clientIds: null,
};

beforeEach(async () => {
  setExtractor(new MockExtractor());
  await resetDatabase();
  await seedMinimalWorld();
});

const ingest = (slug: string, externalId: string, at = '2025-06-14T12:00:00Z') =>
  ingestDocument(
    {
      source: 'WHATSAPP',
      externalId,
      senderIdentifier: '966551234567',
      bytes: readFixtureFile(slug),
      mimeType: 'image/jpeg',
      filename: 'r.jpg',
      receivedAt: new Date(at),
    },
    testPrisma,
  );

describe('an auto-matched document', () => {
  test('reports what was extracted from it', async () => {
    const { documentId } = await ingest('whatsapp-alfanar-exact', 'wamid.D1');
    const detail = await getDocumentDetail(ACTOR, documentId, testPrisma);

    expect(detail).not.toBeNull();
    expect(detail!.extraction.merchantName).not.toBeNull();
    expect(detail!.extraction.totalAmount).not.toBeNull();
    expect(detail!.rawText).not.toBeNull();
  });

  test('names the charge it ended up on', async () => {
    const { documentId } = await ingest('whatsapp-alfanar-exact', 'wamid.D2');
    const detail = await getDocumentDetail(ACTOR, documentId, testPrisma);

    expect(detail!.attachedTo).not.toBeNull();
    expect(detail!.attachedTo!.merchantName.length).toBeGreaterThan(0);
  });

  test('lists every charge it was scored against, with the reason it lost', async () => {
    const { documentId } = await ingest('whatsapp-tamimi-ambiguous', 'wamid.D3', '2025-06-17T13:00:00Z');
    const detail = await getDocumentDetail(ACTOR, documentId, testPrisma);

    expect(detail!.considered.length).toBeGreaterThan(1);
    for (const row of detail!.considered) {
      expect(Object.keys(row.signals).length).toBeGreaterThan(0);
    }
  });

  test('carries who identified the sender', async () => {
    const { documentId } = await ingest('whatsapp-alfanar-exact', 'wamid.D4');
    const detail = await getDocumentDetail(ACTOR, documentId, testPrisma);

    expect(detail!.senderLabel).not.toBeNull();
  });
});

describe('a document nothing could be done with', () => {
  test('an unreadable document still has a page that says so', async () => {
    const { documentId } = await ingest('whatsapp-blurry-garbage', 'wamid.D5');
    const detail = await getDocumentDetail(ACTOR, documentId, testPrisma);

    expect(detail).not.toBeNull();
    expect(detail!.attachedTo).toBeNull();
    expect(detail!.considered).toEqual([]);
    // The reason it stalled, not a blank screen.
    expect(detail!.workKind).not.toBeNull();
  });

  test('an unregistered sender is reported as the reason, not as a missing name', async () => {
    const result = await ingestDocument(
      {
        source: 'EMAIL',
        externalId: 'ext.stranger',
        senderIdentifier: 'nobody@nowhere.example',
        bytes: readFixtureFile('email-alfanar-invoice'),
        mimeType: 'application/pdf',
        filename: 'i.pdf',
        receivedAt: new Date('2025-06-14T09:00:00Z'),
      },
      testPrisma,
    );

    const detail = await getDocumentDetail(ACTOR, result.documentId, testPrisma);
    expect(detail!.workKind).toBe('SENDER_UNKNOWN');
    expect(detail!.senderLabel).toBeNull();
  });
});

describe('scoping', () => {
  test('a document outside the actor’s clients is not returned', async () => {
    const { documentId } = await ingest('whatsapp-alfanar-exact', 'wamid.D6');
    const detail = await getDocumentDetail({ ...ACTOR, clientIds: [999] }, documentId, testPrisma);
    expect(detail).toBeNull();
  });

  test('a document with no client is visible only to an unrestricted actor', async () => {
    const result = await ingestDocument(
      {
        source: 'EMAIL',
        externalId: 'ext.stranger2',
        senderIdentifier: 'nobody2@nowhere.example',
        bytes: readFixtureFile('whatsapp-najd-tip'),
        mimeType: 'application/pdf',
        filename: 'i.pdf',
        receivedAt: new Date('2025-06-14T09:00:00Z'),
      },
      testPrisma,
    );

    expect(await getDocumentDetail(ACTOR, result.documentId, testPrisma)).not.toBeNull();
    expect(
      await getDocumentDetail({ ...ACTOR, clientIds: [1] }, result.documentId, testPrisma),
    ).toBeNull();
  });
});
