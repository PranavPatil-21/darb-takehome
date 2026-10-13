import { readFixtureFile } from '@/fixtures';
import { MockExtractor, setExtractor } from '@/lib/extraction';
import { ingestDocument } from '@/lib/services/document-ingestion';
import { documentHistory, recordEvent } from '@/lib/platform/audit';
import { resetDatabase, seedMinimalWorld, testPrisma } from './helpers/db';

/**
 * The audit trail.
 *
 * This is the evidence an auditor asks for eighteen months after the fact, so the tests
 * are about properties rather than features: that a decision and its record cannot come
 * apart, that the machine's decisions are evidenced the same way a person's are, and that
 * the trail reads in the order things happened.
 */

beforeEach(async () => {
  setExtractor(new MockExtractor());
  await resetDatabase();
  await seedMinimalWorld();
});

afterAll(async () => {
  await testPrisma.$disconnect();
});

const ingest = (slug: string, overrides: Record<string, unknown> = {}) =>
  ingestDocument(
    {
      source: 'WHATSAPP',
      externalId: `wamid.${slug}`,
      senderIdentifier: '966551234567',
      bytes: readFixtureFile(slug),
      mimeType: 'image/jpeg',
      filename: `${slug}.jpg`,
      receivedAt: new Date('2025-06-20T12:00:00Z'),
      ...overrides,
    },
    testPrisma,
  );

describe('what the system does for itself', () => {
  it('evidences an automatic attachment the same way it would a person', async () => {
    // An auto-match is the machine acting as maker. If only human decisions were
    // recorded, the majority of attachments in a working deployment would have no trail
    // at all — and those are exactly the ones an auditor will sample.
    const result = await ingest('whatsapp-alfanar-exact');
    expect(result.status).toBe('MATCHED');

    const history = await documentHistory(result.documentId, testPrisma);

    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      action: 'AUTO_MATCHED',
      actorId: 'system',
      actorRole: 'SYSTEM',
    });
  });

  it('snapshots the confidence the decision was actually made on', async () => {
    // Re-running the matcher later can produce a different number — thresholds move,
    // merchant normalisation improves. The trail has to show what was on screen at the
    // time, not what the engine would say today.
    const result = await ingest('whatsapp-alfanar-exact');
    const match = await testPrisma.documentMatch.findFirstOrThrow({
      where: { documentId: result.documentId },
    });
    const atTheTime = match.confidence;

    // Move the live number afterwards, which is what a threshold change or a better
    // normaliser does. Comparing the event against the match as it stands *now* would
    // pass just as well if the trail joined the figure live — which is the implementation
    // this test exists to rule out.
    await testPrisma.documentMatch.update({
      where: { id: match.id },
      data: { confidence: 0.1234 },
    });

    const event = (await documentHistory(result.documentId, testPrisma))[0]!;

    expect(event.confidence).toBeCloseTo(atTheTime, 4);
    expect(event.confidence).not.toBeCloseTo(0.1234, 4);
  });

  it('records nothing for a document that attached to nothing', async () => {
    const result = await ingest('whatsapp-orphan-receipt');
    expect(result.status).toBe('UNMATCHED');

    expect(await documentHistory(result.documentId, testPrisma)).toEqual([]);
  });
});

describe('the trail as a narrative', () => {
  it('reads oldest first, so it can be read as a sequence', async () => {
    const result = await ingest('whatsapp-alfanar-exact');

    await recordEvent(testPrisma.reviewEvent, {
      documentId: result.documentId,
      action: 'REJECTED',
      actorId: 'faisal',
      actorRole: 'MAKER',
    });
    await recordEvent(testPrisma.reviewEvent, {
      documentId: result.documentId,
      action: 'VERIFIED',
      actorId: 'controller',
      actorRole: 'CHECKER',
      note: 'Checked against the paper receipt.',
    });

    const history = await documentHistory(result.documentId, testPrisma);

    expect(history.map((e) => e.action)).toEqual(['AUTO_MATCHED', 'REJECTED', 'VERIFIED']);
    expect(history[2]!.note).toBe('Checked against the paper receipt.');
  });

  it('keeps every event rather than replacing the previous one', async () => {
    // DocumentMatch.decidedBy holds only the current decision and is overwritten. The
    // whole reason this table exists is that a receipt attached, detached and re-attached
    // has one match row and several events.
    const result = await ingest('whatsapp-alfanar-exact');

    for (const action of ['REJECTED', 'CONFIRMED', 'REJECTED'] as const) {
      await recordEvent(testPrisma.reviewEvent, {
        documentId: result.documentId,
        action,
        actorId: 'faisal',
        actorRole: 'MAKER',
      });
    }

    expect(await documentHistory(result.documentId, testPrisma)).toHaveLength(4);
  });

  it('separates one document’s history from another’s', async () => {
    const a = await ingest('whatsapp-alfanar-exact');
    const b = await ingest('whatsapp-petromin-generic', {
      externalId: 'wamid.OTHER',
    });

    // B gets an event of its own. In this fixture world it does not auto-attach, so it
    // had no trail at all — which is precisely why the old assertion passed without
    // proving anything.
    await recordEvent(testPrisma.reviewEvent, {
      documentId: b.documentId,
      action: 'REJECTED',
      actorId: 'faisal',
      actorRole: 'MAKER',
    });

    const historyA = await documentHistory(a.documentId, testPrisma);
    const historyB = await documentHistory(b.documentId, testPrisma);

    // Both non-empty first. The assertion this replaces was
    // `historyA.every((e) => e.id !== historyB[0]?.id)`, and `historyB[0]?.id` is
    // `undefined` for an empty history — so every id differed from it and the test passed
    // without either document having a trail at all.
    expect(historyA.length).toBeGreaterThan(0);
    expect(historyB.length).toBeGreaterThan(0);

    // Disjoint in both directions, and each history is about its own document.
    const idsB = new Set(historyB.map((e) => e.id));
    expect(a.documentId).not.toBe(b.documentId);
    expect(historyA.some((e) => idsB.has(e.id))).toBe(false);
  });
});

describe('what the trail survives', () => {
  it('outlives the charge it refers to', async () => {
    // transactionId is deliberately not a foreign key. A charge may be purged under a
    // retention policy long after the trail must still read sensibly, and an event that
    // disappears with its transaction defeats the point of keeping one.
    const result = await ingest('whatsapp-alfanar-exact');
    const event = (await documentHistory(result.documentId, testPrisma))[0]!;
    const transactionId = event.transactionId!;

    expect(transactionId).not.toBeNull();

    await testPrisma.transaction.update({
      where: { id: transactionId },
      data: { confirmedDocumentId: null },
    });
    await testPrisma.documentMatch.deleteMany({ where: { transactionId } });
    await testPrisma.transaction.delete({ where: { id: transactionId } });

    const after = await documentHistory(result.documentId, testPrisma);
    expect(after).toHaveLength(1);
    expect(after[0]!.transactionId).toBe(transactionId);
  });
});
