import { confirmMatch, rejectMatch } from '@/lib/actions/review';
import { runAction } from './helpers/actions';
import { documentHistory } from '@/lib/platform/audit';
import { getWorkQueue } from '@/lib/platform/work-queue';
import { resetDatabase, seedMinimalWorld, syncChargeStatuses } from './helpers/db';
import prisma from '@/lib/prisma';

/**
 * Integrity of the audit trail and of the review queue's scoping.
 *
 * The schema advertises an append-only trail that records every decision taken about a
 * document. It did neither: it cascade-deleted with the document, and the rejections that
 * confirming a candidate implies were written to DocumentMatch but never to the trail.
 */

async function seedDocumentWithCandidates(candidates = 3) {
  const document = await prisma.document.create({
    data: {
      source: 'WHATSAPP',
      externalId: 'wamid.audit',
      contentHash: 'hash-audit',
      senderIdentifier: '966551234567',
      clientId: 1,
      status: 'NEEDS_REVIEW',
      totalAmount: 10000,
      merchantName: 'ALFANAR FUEL',
    },
  });

  const matches = [];
  for (let i = 0; i < candidates; i += 1) {
    const transaction = await prisma.transaction.create({
      data: {
        clientId: 1,
        cardLast4: '4412',
        driverPhone: '966551234567',
        merchantName: 'ALFANAR FUEL ST 04 RUH',
        amount: 10000,
        currency: 'SAR',
        transactionAt: new Date('2025-06-14T10:00:00Z'),
      },
    });
    matches.push(
      await prisma.documentMatch.create({
        data: {
          documentId: document.id,
          transactionId: transaction.id,
          confidence: 0.9 - i * 0.1,
          signals: JSON.stringify({ amount: 1 }),
          status: 'CANDIDATE',
        },
      }),
    );
  }

  return { document, matches };
}

beforeEach(async () => {
  await resetDatabase();
  await seedMinimalWorld();
});

/* ========================================================================== */
/* S5 — the trail must outlive the document it describes                      */
/* ========================================================================== */

describe('append-only trail', () => {
  test('survives deletion of the document it describes', async () => {
    const { document, matches } = await seedDocumentWithCandidates(1);
    await runAction(confirmMatch, matches[0]!.id);

    expect(await prisma.reviewEvent.count({ where: { documentId: document.id } })).toBeGreaterThan(0);

    // Simulating a retention purge. A real purge is a write path like any other and
    // would maintain the cached charge status; standing in for it here keeps the
    // suite-wide invariant meaningful rather than making this test the one exception.
    await prisma.documentMatch.deleteMany({ where: { documentId: document.id } });
    await prisma.transaction.updateMany({ data: { confirmedDocumentId: null } });
    await prisma.document.delete({ where: { id: document.id } });
    await syncChargeStatuses();

    // The charge may be purged under a retention policy long after the trail must still
    // read sensibly. An event that vanishes with its document defeats the point — the
    // same argument the schema already makes for transactionId.
    expect(await prisma.reviewEvent.count({ where: { documentId: document.id } })).toBeGreaterThan(0);
  });
});

/* ========================================================================== */
/* S6 — a decision records everything it decided, not just the headline       */
/* ========================================================================== */

describe('completeness of the trail', () => {
  test('records the sibling rejections that confirming a candidate implies', async () => {
    const { document, matches } = await seedDocumentWithCandidates(3);

    await runAction(confirmMatch, matches[0]!.id);

    const history = await documentHistory(document.id);
    const actions = history.map((event) => event.action).sort();

    // One confirmation and two rejections — the trail must be able to answer "who ruled
    // out the alternatives", which is exactly what it exists for.
    expect(actions).toEqual(['CONFIRMED', 'REJECTED', 'REJECTED']);
  });

  test('names the transaction that was ruled out, not just that something was', async () => {
    const { document, matches } = await seedDocumentWithCandidates(2);

    await runAction(confirmMatch, matches[0]!.id);

    const history = await documentHistory(document.id);
    const rejection = history.find((event) => event.action === 'REJECTED');

    expect(rejection?.transactionId).toBe(matches[1]!.transactionId);
  });
});

/* ========================================================================== */
/* S7 — one decision, one event, even on a double submit                      */
/* ========================================================================== */

describe('double-submit', () => {
  test('writes exactly one confirmation event for two concurrent confirms', async () => {
    const { document, matches } = await seedDocumentWithCandidates(1);

    await Promise.all([
      confirmMatch({ matchId: matches[0]!.id }),
      confirmMatch({ matchId: matches[0]!.id }),
    ]);

    const history = await documentHistory(document.id);
    expect(history.filter((event) => event.action === 'CONFIRMED')).toHaveLength(1);
  });
});

/* ========================================================================== */
/* M5 — the sampling draw must not be re-rolled by a retry                    */
/* ========================================================================== */

describe('verification sampling', () => {
  test('draws once per decision rather than once per transaction attempt', async () => {
    const { matches } = await seedDocumentWithCandidates(1);
    const random = jest.spyOn(Math, 'random');

    await runAction(confirmMatch, matches[0]!.id);

    // Called outside the database transaction, so a retry cannot change whether this
    // attachment was selected for sign-off after the fact.
    expect(random).toHaveBeenCalledTimes(1);
    random.mockRestore();
  });
});

/* ========================================================================== */
/* M12 — a misclicked rejection must be recoverable                           */
/* ========================================================================== */

describe('recovering from a rejection', () => {
  test('a reviewer can confirm a pairing they previously rejected', async () => {
    const { document, matches } = await seedDocumentWithCandidates(2);

    const rejected = await runAction(rejectMatch, matches[0]!.id);
    expect(rejected.effect).toBe('REJECTED');

    const confirmed = await runAction(confirmMatch, matches[0]!.id);

    expect(confirmed.effect).toBe('CONFIRMED');
    expect(
      (await prisma.document.findUniqueOrThrow({ where: { id: document.id } })).status,
    ).toBe('MATCHED');
  });

  test('the reversal is itself recorded', async () => {
    const { document, matches } = await seedDocumentWithCandidates(1);

    await runAction(rejectMatch, matches[0]!.id);
    await runAction(confirmMatch, matches[0]!.id);

    const actions = (await documentHistory(document.id)).map((e) => e.action);
    expect(actions).toContain('REJECTED');
    expect(actions).toContain('CONFIRMED');
  });
});

/* ========================================================================== */
/* S8 — the review queue is scoped to what the actor may see                  */
/* ========================================================================== */

describe('review queue scoping', () => {
  test('excludes documents belonging to a client the actor cannot see', async () => {
    await prisma.document.create({
      data: {
        source: 'EMAIL',
        externalId: 'ext.other-client',
        contentHash: 'hash-other-client',
        senderIdentifier: 'someone@other.example',
        clientId: 2,
        status: 'NEEDS_REVIEW',
      },
    });

    const visible = (await getWorkQueue({
      id: 'tester',
      displayName: 'Tester',
      capabilities: ['view', 'decide'],
      clientIds: [1],
    })).flatMap((group) => group.items);

    expect(visible.map((d) => d.id)).not.toContain(
      (await prisma.document.findUniqueOrThrow({ where: { externalId: 'ext.other-client' } })).id,
    );
  });

  test('an operator scoped to every client sees it', async () => {
    await prisma.document.create({
      data: {
        source: 'EMAIL',
        externalId: 'ext.other-client',
        contentHash: 'hash-other-client',
        senderIdentifier: 'someone@other.example',
        clientId: 2,
        status: 'NEEDS_REVIEW',
      },
    });

    const visible = (await getWorkQueue({
      id: 'operator',
      displayName: 'Operator',
      capabilities: ['view', 'decide'],
      clientIds: null,
    })).flatMap((group) => group.items);

    expect(visible).toHaveLength(1);
  });
});
