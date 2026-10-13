import { rematchUnmatchedDocuments, REMATCH_SWEEP_LIMIT } from '@/lib/services/rematch';
import { POST as transactionsPost } from '@/app/api/transactions/route';
import { MockExtractor, setExtractor } from '@/lib/extraction';
import { resetDatabase, seedMinimalWorld, testPrisma } from './helpers/db';
import prisma from '@/lib/prisma';

/**
 * Bounds on the re-match sweep.
 *
 * The sweep was unbounded, pulled every unscoped document in the system regardless of
 * the client filter, and was invoked once per client concurrently — so a batch spanning
 * three clients ran three overlapping passes over the same rows. These tests pin the
 * corrected shape: one pass, bounded, honestly reported when it truncates.
 */

const post = (body: unknown) =>
  new Request('http://localhost/api/transactions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(async () => {
  setExtractor(new MockExtractor());
  await resetDatabase();
  await seedMinimalWorld();
});

describe('sweep bounds', () => {
  test('exposes a limit so the sweep can never be unbounded', () => {
    expect(REMATCH_SWEEP_LIMIT).toBeGreaterThan(0);
    expect(Number.isFinite(REMATCH_SWEEP_LIMIT)).toBe(true);
  });

  test('never scans more documents than the limit in one pass', async () => {
    const rows = Array.from({ length: REMATCH_SWEEP_LIMIT + 5 }, (_, i) => ({
      source: 'WHATSAPP',
      externalId: `ext_${i}`,
      contentHash: `hash_${i}`,
      senderIdentifier: '966551234567',
      clientId: 1,
      status: 'UNMATCHED',
    }));
    await testPrisma.document.createMany({ data: rows });

    const result = await rematchUnmatchedDocuments({ clientIds: [1] }, testPrisma);

    expect(result.outcomes.length).toBeLessThanOrEqual(REMATCH_SWEEP_LIMIT);
  });

  test('reports truncation rather than silently capping', async () => {
    const rows = Array.from({ length: REMATCH_SWEEP_LIMIT + 1 }, (_, i) => ({
      source: 'WHATSAPP',
      externalId: `ext_${i}`,
      contentHash: `hash_${i}`,
      senderIdentifier: '966551234567',
      clientId: 1,
      status: 'UNMATCHED',
    }));
    await testPrisma.document.createMany({ data: rows });

    const result = await rematchUnmatchedDocuments({ clientIds: [1] }, testPrisma);

    expect(result.truncated).toBe(true);
  });

  test('does not report truncation when everything fitted', async () => {
    const result = await rematchUnmatchedDocuments({ clientIds: [1] }, testPrisma);
    expect(result.truncated).toBe(false);
  });

  test('sweeps many clients in one pass rather than one overlapping pass each', async () => {
    await testPrisma.document.create({
      data: {
        source: 'WHATSAPP',
        externalId: 'ext_unscoped',
        contentHash: 'hash_unscoped',
        senderIdentifier: '966559999999',
        clientId: null,
        status: 'UNMATCHED',
      },
    });

    const result = await rematchUnmatchedDocuments({ clientIds: [1, 2] }, testPrisma);

    // The unscoped document is considered exactly once, not once per client.
    const unscopedSeen = result.outcomes.filter((o) => o.documentId !== undefined);
    expect(new Set(unscopedSeen.map((o) => o.documentId)).size).toBe(unscopedSeen.length);
  });
});

/* ========================================================================== */
/* M7 — the endpoint that feeds the matcher needs the same hardening          */
/* ========================================================================== */

describe('transaction ingestion idempotency', () => {
  const batch = {
    transactions: [
      {
        clientId: 1,
        cardLast4: '4412',
        merchantName: 'ALFANAR FUEL ST 04 RUH',
        amount: 10000,
        currency: 'SAR',
        transactionAt: '2025-06-14T10:00:00Z',
      },
    ],
  };

  test('a replayed batch does not create the transactions twice', async () => {
    const headers = { 'Idempotency-Key': 'batch-abc' };

    const first = await transactionsPost(
      new Request('http://localhost/api/transactions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(batch),
      }),
    );
    const second = await transactionsPost(
      new Request('http://localhost/api/transactions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(batch),
      }),
    );

    expect(first.status).toBe(201); // created
    expect(second.status).toBe(200); // replay — nothing new was created

    const firstBody = await first.json();
    const secondBody = await second.json();

    expect(firstBody.duplicate).toBeFalsy();
    expect(secondBody.duplicate).toBe(true);
    // The decisive assertion: one batch of charges, not two.
    expect(await prisma.transaction.count({ where: { cardLast4: '4412', amount: 10000 } })).toBe(1);
  });

  test('a batch without an idempotency key is rejected', async () => {
    const response = await transactionsPost(post(batch));
    expect(response.status).toBe(400);
  });
});
