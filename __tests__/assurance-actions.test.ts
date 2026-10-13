import { readFixtureFile } from '@/fixtures';
import { MockExtractor, setExtractor } from '@/lib/extraction';
import { ingestDocument } from '@/lib/services/document-ingestion';
import { confirmMatch } from '@/lib/actions/review';
import { overturnAttachment, upholdAttachment } from '@/lib/actions/assurance';
import { resetActorResolver, setActorResolver, type Actor } from '@/lib/platform/identity';
import { resetDatabase, seedMinimalWorld, testPrisma } from './helpers/db';
import { expectStatusesConsistent } from './helpers/invariants';

/**
 * The checker's two decisions, driven to completion.
 *
 * Every existing assurance test stops at a refusal, so no test had ever run an overturn
 * or an upheld all the way through — which is why a stale cached charge status survived
 * the suite. These do, and the global status invariant runs after each one.
 */

const MAKER: Actor = { id: 'maker', displayName: 'Maker', capabilities: ['view', 'decide'], clientIds: null };
const CHECKER: Actor = {
  id: 'checker',
  displayName: 'Checker',
  capabilities: ['view', 'decide', 'verify'],
  clientIds: null,
};

/** Ingests a receipt, confirms its best candidate as the maker, returns that match. */
async function attachAsMaker() {
  setActorResolver(async () => MAKER);

  const ingested = await ingestDocument(
    {
      source: 'WHATSAPP',
      externalId: 'wamid.ASSURANCE',
      senderIdentifier: '966551234567',
      bytes: readFixtureFile('whatsapp-tamimi-ambiguous'),
      mimeType: 'image/jpeg',
      filename: 'tamimi-receipt.jpg',
      receivedAt: new Date('2025-06-17T13:00:00Z'),
    },
    testPrisma,
  );

  const candidate = await testPrisma.documentMatch.findFirstOrThrow({
    where: { documentId: ingested.documentId },
    orderBy: [{ confidence: 'desc' }, { transactionId: 'asc' }],
  });

  await confirmMatch({ matchId: candidate.id });
  return { documentId: ingested.documentId, matchId: candidate.id, transactionId: candidate.transactionId };
}

beforeEach(async () => {
  setExtractor(new MockExtractor());
  await resetDatabase();
  await seedMinimalWorld();
});

afterEach(() => resetActorResolver());

afterAll(async () => {
  await testPrisma.$disconnect();
});

describe('overturnAttachment', () => {
  it('detaches the document and leaves the charge status agreeing with its matches', async () => {
    const { matchId, transactionId } = await attachAsMaker();
    setActorResolver(async () => CHECKER);

    const result = await overturnAttachment({ matchId, reason: 'Receipt is for another branch.' });

    expect(result).toMatchObject({ ok: true, effect: 'OVERTURNED' });

    const charge = await testPrisma.transaction.findUniqueOrThrow({ where: { id: transactionId } });
    expect(charge.confirmedDocumentId).toBeNull();
    // The cached column is what the registers read. It used to be recomputed *before* the
    // match flipped to REJECTED, so it still described the pre-overturn world.
    expect(charge.documentationStatus).toBe('REJECTED');

    await expectStatusesConsistent(testPrisma);
  });

  it('returns the document to the queue rather than reporting it attached', async () => {
    const { documentId, matchId } = await attachAsMaker();
    setActorResolver(async () => CHECKER);

    await overturnAttachment({ matchId, reason: 'Receipt is for another branch.' });

    const document = await testPrisma.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(document.status).not.toBe('MATCHED');
  });
});

describe('upholdAttachment', () => {
  it('signs off another person’s attachment and leaves the charge documented', async () => {
    const { matchId, transactionId } = await attachAsMaker();
    setActorResolver(async () => CHECKER);

    const result = await upholdAttachment({ matchId });

    expect(result).toMatchObject({ ok: true, effect: 'UPHELD' });

    const charge = await testPrisma.transaction.findUniqueOrThrow({ where: { id: transactionId } });
    expect(charge.documentationStatus).toBe('DOCUMENTED');

    await expectStatusesConsistent(testPrisma);
  });
});
