import { POST as transactionsPost } from '@/app/api/transactions/route';
import { readFixtureFile } from '@/fixtures';
import { MockExtractor, setExtractor } from '@/lib/extraction';
import { ingestDocument } from '@/lib/services/document-ingestion';
import { resetDatabase, seedMinimalWorld, testPrisma } from './helpers/db';

/**
 * Transaction ingestion and the re-match trigger.
 *
 * The re-match service is only useful if something calls it. These tests exercise the
 * full loop: a receipt arrives before its transaction and goes UNMATCHED, the transaction
 * is later ingested here, and the sweep rescues the document — without a human and
 * without re-running OCR.
 */

/**
 * Every call carries a fresh Idempotency-Key. The endpoint creates financial records and
 * now requires one; a replay of the *same* key is covered in rematch-bounds.test.ts.
 */
let keySeq = 0;
const post = (body: unknown, idempotencyKey?: string) =>
  new Request('http://localhost/api/transactions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey ?? `test-batch-${(keySeq += 1)}`,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

/** The transaction that eventually arrives for the orphaned Kudu receipt. */
const lateArrival = {
  clientId: 1,
  cardLast4: '4412',
  driverPhone: '966551234567',
  merchantName: 'KUDU REST 118 RUH',
  amount: 3300,
  currency: 'SAR',
  transactionAt: '2025-06-19T13:12:00Z',
};

async function ingestOrphanReceipt() {
  return ingestDocument(
    {
      source: 'WHATSAPP',
      externalId: 'wamid.KUDU',
      senderIdentifier: '966551234567',
      bytes: readFixtureFile('whatsapp-orphan-receipt'),
      mimeType: 'image/jpeg',
      filename: 'kudu-receipt.jpg',
      receivedAt: new Date('2025-06-19T14:00:00Z'),
    },
    testPrisma,
  );
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

describe('creating transactions', () => {
  it('creates a transaction and returns 201 with its id', async () => {
    const response = await transactionsPost(post({ transactions: [lateArrival] }));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.created).toHaveLength(1);
    expect(await testPrisma.transaction.count()).toBeGreaterThan(0);
  });

  it('creates a whole batch atomically', async () => {
    const response = await transactionsPost(
      post({ transactions: [lateArrival, { ...lateArrival, amount: 9900 }] }),
    );
    const body = await response.json();

    expect(body.created).toHaveLength(2);
  });

  it('returns 400 with field-level issues for a malformed transaction', async () => {
    const response = await transactionsPost(
      post({ transactions: [{ ...lateArrival, cardLast4: '44', amount: -5 }] }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.issues.map((issue: { path: string }) => issue.path)).toEqual(
      expect.arrayContaining(['transactions.0.cardLast4', 'transactions.0.amount']),
    );
  });

  it('rejects a float amount — money is always integer minor units', async () => {
    const response = await transactionsPost(
      post({ transactions: [{ ...lateArrival, amount: 33.5 }] }),
    );

    expect(response.status).toBe(400);
  });

  it('rejects an unknown client without creating anything', async () => {
    const response = await transactionsPost(
      post({ transactions: [{ ...lateArrival, clientId: 999 }] }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain('999');
    expect(await testPrisma.transaction.findMany({ where: { merchantName: lateArrival.merchantName } }))
      .toHaveLength(0);
  });

  it('returns 400 for a body that is not JSON', async () => {
    expect((await transactionsPost(post('{not json'))).status).toBe(400);
  });
});

/* -------------------------------------------------------------------------- */

describe('re-match on arrival', () => {
  it('rescues a document that arrived before its transaction', async () => {
    const orphan = await ingestOrphanReceipt();
    expect(orphan.status).toBe('UNMATCHED');

    const response = await transactionsPost(post({ transactions: [lateArrival] }));
    const body = await response.json();

    expect(body.rematch.changed).toBe(1);
    expect(body.rematch.documents[0]).toMatchObject({
      documentId: orphan.documentId,
      from: 'UNMATCHED',
      to: 'MATCHED',
    });
  });

  it('attaches the document to the newly created transaction', async () => {
    const orphan = await ingestOrphanReceipt();
    const response = await transactionsPost(post({ transactions: [lateArrival] }));
    const { created } = await response.json();

    const transaction = await testPrisma.transaction.findUniqueOrThrow({
      where: { id: created[0] },
    });
    expect(transaction.confirmedDocumentId).toBe(orphan.documentId);
  });

  it('reports nothing changed when the new transaction rescues no document', async () => {
    await ingestOrphanReceipt();

    const response = await transactionsPost(
      post({ transactions: [{ ...lateArrival, merchantName: 'IKEA JEDDAH', amount: 77000 }] }),
    );
    const body = await response.json();

    expect(body.rematch.scanned).toBe(1);
    expect(body.rematch.changed).toBe(0);
  });

  it('does not disturb documents a human is already reviewing', async () => {
    const ambiguous = await ingestDocument(
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
    expect(ambiguous.status).toBe('NEEDS_REVIEW');

    await transactionsPost(post({ transactions: [lateArrival] }));

    const document = await testPrisma.document.findUniqueOrThrow({
      where: { id: ambiguous.documentId },
    });
    expect(document.status).toBe('NEEDS_REVIEW');
  });

  it('only sweeps the clients whose transactions arrived', async () => {
    await ingestOrphanReceipt();

    // A client-2 transaction must not trigger a scan of client 1's backlog.
    const response = await transactionsPost(
      post({
        transactions: [
          {
            ...lateArrival,
            clientId: 2,
            cardLast4: '7731',
            driverPhone: '966561112233',
          },
        ],
      }),
    );
    const body = await response.json();

    expect(body.rematch.scanned).toBe(0);
  });

  it('is idempotent — re-posting the sweep creates no duplicate matches', async () => {
    const orphan = await ingestOrphanReceipt();
    await transactionsPost(post({ transactions: [lateArrival] }));
    await transactionsPost(post({ transactions: [{ ...lateArrival, amount: 4100 }] }));

    expect(await testPrisma.documentMatch.count({ where: { documentId: orphan.documentId } })).toBe(
      1,
    );
  });
});

describe('the idempotency key is claimed before the charges exist', () => {
  /**
   * The key was written *after* the charges, so the window between them was unprotected:
   * concurrent retries of one key each passed the "have I seen this?" pre-check, and each
   * created its own charges. The losing writes were not even recoverable — the stored key
   * records only one batch's ids, so a later replay returns a subset and the rest are
   * unreachable.
   *
   * Ingestion already solves this one directory over, by catching the unique-constraint
   * violation rather than pre-checking. This is the same guarantee, on money.
   */
  const charge = {
    clientId: 1,
    cardLast4: '4412',
    driverPhone: '966551234567',
    merchantName: 'CONCURRENT PROBE',
    amount: 7700,
    currency: 'SAR',
    transactionAt: '2025-06-20T10:00:00Z',
  };

  it('creates one set of charges when the same key arrives four times at once', async () => {
    const body = { transactions: [charge] };

    const responses = await Promise.all(
      Array.from({ length: 4 }, () => transactionsPost(post(body, 'concurrent-probe-1'))),
    );

    // 201 for the request that claimed the key, 200 for a replay that found the finished
    // record, 409 for one that found the claim still in flight. All three are correct
    // answers; what must never happen is two requests both creating charges.
    for (const response of responses) {
      expect([200, 201, 409]).toContain(response.status);
    }
    // Exactly one winner — the rest were told the key was taken, not handed a 500.
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);

    const created = await testPrisma.transaction.count({
      where: { merchantName: 'CONCURRENT PROBE' },
    });
    expect(created).toBe(1);
  });
});
