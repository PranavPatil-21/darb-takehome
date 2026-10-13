import { readFixtureFile } from '@/fixtures';
import { MockExtractor, setExtractor } from '@/lib/extraction';
import { ingestDocument } from '@/lib/services/document-ingestion';
import { confirmMatch, rejectMatch } from '@/lib/actions/review';
import { runAction } from './helpers/actions';
import { resetDatabase, seedMinimalWorld, syncChargeStatuses, testPrisma } from './helpers/db';

/**
 * Review-queue behaviour.
 *
 * The server actions in `lib/actions/review.ts` are `'use server'` modules, which Jest
 * cannot invoke outside a Next request context. These harnesses mirror the action bodies
 * and, critically, call the *same* `slot-claim` helpers the actions call — so the
 * concurrency guarantee under test is the production one, not a re-implementation of it.
 */

/**
 * Both helpers call the real server actions.
 *
 * They used to be re-implementations of the action bodies, which passed happily while the
 * production code diverged — and it did: the terminal-status list mirrored here still said
 * a REJECTED match could never be confirmed, months after `confirmMatch` was changed to
 * allow exactly that. A test that mirrors the code under test asserts only that the mirror
 * is self-consistent.
 */
const confirm = (matchId: number) => runAction(confirmMatch, matchId);
const reject = (matchId: number) => runAction(rejectMatch, matchId);

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

    await confirm(matches[0]!.id);

    const after = await testPrisma.documentMatch.findMany({ where: { documentId } });
    expect(after.find((m) => m.id === matches[0]!.id)?.status).toBe('CONFIRMED');
    expect(after.find((m) => m.id === matches[1]!.id)?.status).toBe('REJECTED');
  });

  it('moves the document to MATCHED', async () => {
    const { documentId, matches } = await ingestAmbiguous();

    await confirm(matches[0]!.id);

    const document = await testPrisma.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(document.status).toBe('MATCHED');
  });

  it('is a no-op on a double submit rather than a second confirmation', async () => {
    const { matches } = await ingestAmbiguous();

    const first = await confirm(matches[0]!.id);
    const second = await confirm(matches[0]!.id);

    expect(first.effect).toBe('CONFIRMED');
    expect(second.effect).toBe('ALREADY_DECIDED');
  });

  it('refuses a second document for a transaction that already has one', async () => {
    // The database constraint is the guard, not an application-level if.
    const { matches } = await ingestAmbiguous();
    await confirm(matches[0]!.id);

    const transactionId = matches[0]!.transactionId;
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
    // The compare-and-set refuses instead, and the action reports that refusal rather
    // than throwing — a working control is not an error.
    const blocked = await confirm(rivalMatch.id);
    expect(blocked.ok).toBe(false);
    expect(blocked.effect).toBe('BLOCKED');

    const transaction = await testPrisma.transaction.findUniqueOrThrow({
      where: { id: transactionId },
    });
    expect(transaction.confirmedDocumentId).toBe(matches[0]!.documentId);
    expect(transaction.confirmedDocumentId).not.toBe(otherDocument.id);
  });

  it('refuses to attach a document that is already confirmed for another transaction', async () => {
    // Through `confirmMatch`, not around it.
    //
    // This used to call `prisma.transaction.update` directly and assert Prisma threw —
    // which proves the index exists and nothing about the action. Deleting the entire
    // P2002 branch in `confirmMatch` left it green, so the test named a behaviour it did
    // not exercise. What matters to a reviewer is that the *action* refuses, and reports
    // the refusal rather than throwing.
    const { documentId, matches } = await ingestAmbiguous();
    await confirm(matches[0]!.id);

    const blocked = await confirm(matches[1]!.id);

    expect(blocked.ok).toBe(false);
    expect(blocked.effect).toBe('BLOCKED');
    expect(blocked.message).not.toMatch(/something went wrong/i);

    // The first charge keeps the document; the second gets nothing.
    const second = await testPrisma.transaction.findUniqueOrThrow({
      where: { id: matches[1]!.transactionId },
    });
    expect(second.confirmedDocumentId).toBeNull();
    const confirmedElsewhere = await testPrisma.transaction.count({
      where: { confirmedDocumentId: documentId },
    });
    expect(confirmedElsewhere).toBe(1);
  });

  it('survives two reviewers confirming different candidates at the same time', async () => {
    const { documentId, matches } = await ingestAmbiguous();

    const outcomes = await Promise.allSettled([confirm(matches[0]!.id), confirm(matches[1]!.id)]);
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

    const result = await reject(matches[0]!.id);

    expect(result.effect).toBe('REJECTED');
    const document = await testPrisma.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(document.status).toBe('NEEDS_REVIEW');
  });

  it('returns the document to UNMATCHED once every candidate is rejected', async () => {
    const { documentId, matches } = await ingestAmbiguous();

    await reject(matches[0]!.id);
    await reject(matches[1]!.id);

    const document = await testPrisma.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(document.status).toBe('UNMATCHED');
    expect(document.failureReason).toBe('ALL_CANDIDATES_REJECTED');
  });

  it('keeps the document MATCHED when a confirmed match survives the rejection', async () => {
    // A document can hold a confirmed match on one charge *and* a live candidate on
    // another: an AUTO_MATCHED ingestion persists the whole ranked list, winner
    // AUTO_CONFIRMED and runners-up CANDIDATE. Rejecting the runner-up must not report
    // the receipt as unmatched while a charge still carries it as evidence.
    const { documentId, matches } = await ingestAmbiguous();
    const [winner, runnerUp] = matches;

    await confirm(winner!.id);
    // Re-open the runner-up so the document holds CONFIRMED + CANDIDATE at once.
    await testPrisma.documentMatch.update({
      where: { id: runnerUp!.id },
      data: { status: 'CANDIDATE', decidedBy: null, decidedAt: null },
    });

    await reject(runnerUp!.id);

    const document = await testPrisma.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(document.status).toBe('MATCHED');
    expect(document.failureReason).toBeNull();
  });

  it('is a no-op on a double submit', async () => {
    const { matches } = await ingestAmbiguous();

    await reject(matches[0]!.id);
    const second = await reject(matches[0]!.id);

    expect(second.effect).toBe('ALREADY_DECIDED');
  });

  it('detaches a confirmed match and frees the transaction for the correct document', async () => {
    const { matches } = await ingestAmbiguous();
    await confirm(matches[0]!.id);

    // Rejecting a *confirmed* match is the undo path — it must release the slot.
    const result = await reject(matches[0]!.id);
    expect(result.effect).toBe('REJECTED');

    const transaction = await testPrisma.transaction.findUniqueOrThrow({
      where: { id: matches[0]!.transactionId },
    });
    expect(transaction.confirmedDocumentId).toBeNull();
  });

  it('lets a rejected-then-reconsidered candidate be confirmed after the slot is freed', async () => {
    const { matches } = await ingestAmbiguous();
    await confirm(matches[0]!.id);
    await reject(matches[0]!.id);

    await testPrisma.documentMatch.update({
      where: { id: matches[1]!.id },
      data: { status: 'CANDIDATE' },
    });

    const reconsidered = await confirm(matches[1]!.id);
    expect(reconsidered.effect).toBe('CONFIRMED');
  });
});

describe('a decision does not erase why the document is in the queue', () => {
  it('keeps the matcher’s reason when a sibling candidate is rejected', async () => {
    // `failureReason` carries two different things: *why unmatched* for UNMATCHED rows,
    // and *why a human is looking* for NEEDS_REVIEW rows — which is what the work queue
    // groups by and what the reviewer reads as the headline. The status recompute treated
    // it as the first meaning only and nulled it otherwise, so rejecting one candidate
    // silently stripped the reason from the document and moved it to a different queue.
    const { documentId, matches } = await ingestAmbiguous();
    const before = await testPrisma.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(before.failureReason).toBe('AMBIGUOUS_TOP_CANDIDATES');

    await reject(matches[0]!.id);

    const after = await testPrisma.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(after.status).toBe('NEEDS_REVIEW');
    expect(after.failureReason).toBe('AMBIGUOUS_TOP_CANDIDATES');
  });
});

describe('the database refuses a second confirmed document for one charge', () => {
  it('rejects the write even when the application guard is bypassed entirely', async () => {
    // The brief asks for this rule "at the data layer, not just in UI logic". The scalar
    // `confirmedDocumentId` column gives one *mirror* per charge; what the rest of the
    // system reads as the truth is `DocumentMatch.status`, and nothing constrained it —
    // so a lost race in `overturnAttachment` left one charge holding two CONFIRMED rows.
    //
    // This goes around `confirmMatch` on purpose: a constraint that only holds when the
    // application remembers to check is not a constraint.
    const { matches } = await ingestAmbiguous();
    const transactionId = matches[0]!.transactionId;

    // The slot moves with the match, because that is the state production reaches and
    // the global invariants check for it.
    await testPrisma.documentMatch.update({
      where: { id: matches[0]!.id },
      data: { status: 'CONFIRMED' },
    });
    await testPrisma.transaction.update({
      where: { id: transactionId },
      data: { confirmedDocumentId: matches[0]!.documentId },
    });
    await syncChargeStatuses();

    const rival = await testPrisma.document.create({
      data: {
        source: 'WHATSAPP',
        externalId: 'wamid.RIVAL-CONFIRMED',
        contentHash: 'hash-rival-confirmed',
        senderIdentifier: '966551234567',
        clientId: 1,
        status: 'NEEDS_REVIEW',
      },
    });

    await expect(
      testPrisma.documentMatch.create({
        data: {
          documentId: rival.id,
          transactionId,
          confidence: 0.99,
          signals: '{}',
          status: 'CONFIRMED',
        },
      }),
    ).rejects.toThrow(/Unique constraint|P2002/i);

    // And the charge still holds exactly one.
    const confirmed = await testPrisma.documentMatch.count({
      where: { transactionId, status: { in: ['CONFIRMED', 'AUTO_CONFIRMED'] } },
    });
    expect(confirmed).toBe(1);
  });

  it('still allows many live candidates on one charge', async () => {
    // The index is partial for this reason: a plain `@@unique(transactionId)` would stop
    // two documents ever being *proposed* for one charge, which is the review queue's
    // whole job.
    const { matches } = await ingestAmbiguous();
    const transactionId = matches[0]!.transactionId;

    const second = await testPrisma.document.create({
      data: {
        source: 'WHATSAPP',
        externalId: 'wamid.SECOND-CANDIDATE',
        contentHash: 'hash-second-candidate',
        senderIdentifier: '966551234567',
        clientId: 1,
        status: 'NEEDS_REVIEW',
      },
    });

    await expect(
      testPrisma.documentMatch.create({
        data: { documentId: second.id, transactionId, confidence: 0.8, signals: '{}' },
      }),
    ).resolves.toBeDefined();
  });
});
