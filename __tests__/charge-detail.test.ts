import { getChargeDetail } from '@/lib/platform/charge-detail';
import { confirmMatch } from '@/lib/actions/review';
import { ingestDocument } from '@/lib/services/document-ingestion';
import { readFixtureFile } from '@/fixtures';
import { MockExtractor, setExtractor } from '@/lib/extraction';
import { resetDatabase, seedMinimalWorld, syncChargeStatuses, testPrisma } from './helpers/db';
import { runAction } from './helpers/actions';
import prisma from '@/lib/prisma';

/**
 * The evidence file behind one charge.
 *
 * The detail page could not answer the questions an auditor actually asks: whether the
 * attachment had been countersigned, on what evidence the engine attached it, and what
 * happened to it since. The data was all present — sign-off columns on the match, the
 * signal breakdown, the audit trail — and none of it reached the screen. These tests are
 * about the assembly, so the page stays a rendering of it.
 */

const ACTOR = {
  id: 'tester',
  displayName: 'Tester',
  capabilities: ['view', 'decide'] as const,
  clientIds: null,
};

async function ingestExact() {
  return ingestDocument(
    {
      source: 'WHATSAPP',
      externalId: 'wamid.DETAIL',
      senderIdentifier: '966551234567',
      bytes: readFixtureFile('whatsapp-alfanar-exact'),
      mimeType: 'image/jpeg',
      filename: 'r.jpg',
      receivedAt: new Date('2025-06-14T12:00:00Z'),
    },
    testPrisma,
  );
}

beforeEach(async () => {
  setExtractor(new MockExtractor());
  await resetDatabase();
  await seedMinimalWorld();
});

describe('an undocumented charge', () => {
  test('reports no attachment and nothing considered', async () => {
    const charge = await testPrisma.transaction.findFirstOrThrow({ select: { id: true } });
    const detail = await getChargeDetail(ACTOR, charge.id, testPrisma);

    expect(detail).not.toBeNull();
    expect(detail!.attached).toBeNull();
    expect(detail!.considered).toEqual([]);
    expect(detail!.status).toBe('MISSING');
  });
});

describe('an auto-attached charge', () => {
  test('carries the evidence the engine attached it on', async () => {
    await ingestExact();
    const charge = await testPrisma.transaction.findFirstOrThrow({
      where: { confirmedDocumentId: { not: null } },
      select: { id: true },
    });

    const detail = await getChargeDetail(ACTOR, charge.id, testPrisma);

    expect(detail!.status).toBe('DOCUMENTED');
    expect(detail!.attached).not.toBeNull();
    // The breakdown the review screen shows in full, which the detail page reduced to a
    // bare percentage.
    expect(Object.keys(detail!.attached!.signals).length).toBeGreaterThan(0);
    expect(detail!.attached!.confidence).toBeGreaterThan(0);
  });

  test('says whether it still needs countersigning, and by whose rule', async () => {
    await ingestExact();
    const charge = await testPrisma.transaction.findFirstOrThrow({
      where: { confirmedDocumentId: { not: null } },
      select: { id: true },
    });

    const detail = await getChargeDetail(ACTOR, charge.id, testPrisma);
    const signOff = detail!.attached!.signOff;

    // Either it needs sign-off and says why it was selected, or it does not need it.
    // What it must never be is silent, which is what the page was before.
    expect(signOff).not.toBeUndefined();
    if (signOff.required) {
      expect(signOff.trigger).not.toBeNull();
      expect(signOff.settled).toBe(false);
    }
  });

  test('records that the engine was the one that attached it', async () => {
    await ingestExact();
    const charge = await testPrisma.transaction.findFirstOrThrow({
      where: { confirmedDocumentId: { not: null } },
      select: { id: true },
    });

    const detail = await getChargeDetail(ACTOR, charge.id, testPrisma);
    expect(detail!.history.map((e) => e.action)).toContain('AUTO_MATCHED');
  });
});

describe('history explains itself when there is none', () => {
  test('a charge documented before the trail existed is described, not hidden', async () => {
    // Attached directly, exactly as the seed, a migration or a bulk import does — no
    // events written. The page used to drop the History section entirely in this case,
    // which reads as "nothing happened" rather than "this predates the trail".
    const charge = await testPrisma.transaction.findFirstOrThrow({ select: { id: true } });
    const document = await testPrisma.document.create({
      data: {
        source: 'EMAIL',
        externalId: 'ext.imported',
        contentHash: 'hash-imported',
        senderIdentifier: 'fleetops@rawabi-logistics.example',
        clientId: 1,
        status: 'MATCHED',
        merchantName: 'IMPORTED RECEIPT',
      },
    });
    await testPrisma.documentMatch.create({
      data: {
        documentId: document.id,
        transactionId: charge.id,
        confidence: 0.91,
        signals: JSON.stringify({ amount: 1 }),
        status: 'CONFIRMED',
      },
    });
    await testPrisma.transaction.update({
      where: { id: charge.id },
      data: { confirmedDocumentId: document.id },
    });
    await syncChargeStatuses();

    const detail = await getChargeDetail(ACTOR, charge.id, testPrisma);

    expect(detail!.attached).not.toBeNull();
    expect(detail!.history).toEqual([]);
    // The section explains its own emptiness rather than disappearing.
    expect(detail!.historyNote.length).toBeGreaterThan(0);
  });
});

describe('a human decision', () => {
  test('names who attached it', async () => {
    const result = await ingestDocument(
      {
        source: 'WHATSAPP',
        externalId: 'wamid.AMB',
        senderIdentifier: '966551234567',
        bytes: readFixtureFile('whatsapp-tamimi-ambiguous'),
        mimeType: 'image/jpeg',
        filename: 'r.jpg',
        receivedAt: new Date('2025-06-17T13:00:00Z'),
      },
      testPrisma,
    );

    const match = await testPrisma.documentMatch.findFirstOrThrow({
      where: { documentId: result.documentId },
    });
    await runAction(confirmMatch, match.id);

    const detail = await getChargeDetail(ACTOR, match.transactionId, prisma);

    expect(detail!.attached!.decidedBy).not.toBeNull();
    expect(detail!.history.map((e) => e.action)).toContain('CONFIRMED');
  });
});

describe('scoping', () => {
  test('a charge outside the actor’s clients is not returned', async () => {
    const charge = await testPrisma.transaction.findFirstOrThrow({ select: { id: true } });
    const detail = await getChargeDetail({ ...ACTOR, clientIds: [999] }, charge.id, testPrisma);
    expect(detail).toBeNull();
  });
});
