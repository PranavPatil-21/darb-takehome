import { matchDocument } from '@/lib/services/transaction-matcher';
import type { CandidateTransaction, MatchableDocument } from '@/lib/services/transaction-matcher';
import { AUTO_MATCH_THRESHOLD, MIN_CANDIDATE_THRESHOLD } from '@/lib/matching/scoring-config';

/* -------------------------------------------------------------------------- */
/* Builders — keep each test's intent visible by overriding only what matters   */
/* -------------------------------------------------------------------------- */

const baseDocument = (overrides: Partial<MatchableDocument> = {}): MatchableDocument => ({
  source: 'WHATSAPP',
  clientId: 1,
  driverPhone: '966551234567',
  documentType: 'RECEIPT',
  merchantName: 'Alfanar Fuel Station',
  vatNumber: '300000000000003',
  totalAmount: 12500,
  currency: 'SAR',
  documentDate: '2025-06-14T00:00:00Z',
  cardLast4: '4412',
  invoiceNumber: null,
  extractionConfidence: 0.95,
  ...overrides,
});

let nextId = 1;
const baseTransaction = (overrides: Partial<CandidateTransaction> = {}): CandidateTransaction => ({
  id: nextId++,
  clientId: 1,
  cardLast4: '4412',
  driverPhone: '966551234567',
  merchantName: 'ALFANAR FUEL ST 04 RUH',
  amount: 12500,
  currency: 'SAR',
  transactionAt: new Date('2025-06-14T11:02:00Z'),
  hasConfirmedDocument: false,
  ...overrides,
});

beforeEach(() => {
  nextId = 1;
});

/* -------------------------------------------------------------------------- */
/* Edge case 1 — exact match, one obvious winner                               */
/* -------------------------------------------------------------------------- */

describe('edge case 1: exact match', () => {
  it('auto-matches a receipt whose amount, card, merchant and date all agree', () => {
    const result = matchDocument(baseDocument(), [baseTransaction()]);

    expect(result.outcome).toBe('AUTO_MATCHED');
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].confidence).toBeGreaterThanOrEqual(AUTO_MATCH_THRESHOLD);
  });

  it('publishes a per-signal breakdown so the score is explainable', () => {
    const [candidate] = matchDocument(baseDocument(), [baseTransaction()]).candidates;

    expect(candidate.signals).toEqual(
      expect.objectContaining({
        amount: 1,
        cardLast4: 1,
        date: 1,
        merchant: expect.any(Number),
      }),
    );
    expect(candidate.signals.merchant).toBeGreaterThan(0.6);
  });

  it('picks the right transaction out of a realistic candidate set', () => {
    const correct = baseTransaction({ id: 7 });
    const noise = [
      baseTransaction({ id: 8, amount: 9900, merchantName: 'TAMIMI MARKETS RUH' }),
      baseTransaction({ id: 9, amount: 31000, merchantName: 'SACO HARDWARE' }),
    ];

    const result = matchDocument(baseDocument(), [...noise, correct]);

    expect(result.outcome).toBe('AUTO_MATCHED');
    expect(result.candidates[0].transactionId).toBe(7);
  });
});

/* -------------------------------------------------------------------------- */
/* Edge case 2 — two indistinguishable transactions                            */
/* -------------------------------------------------------------------------- */

describe('edge case 2: ambiguous same-amount same-day same-chain', () => {
  const twins: CandidateTransaction[] = [
    baseTransaction({ id: 1, merchantName: 'ALFANAR FUEL ST 04 RUH' }),
    baseTransaction({ id: 2, merchantName: 'ALFANAR FUEL ST 11 RUH' }),
  ];

  it('routes to review rather than guessing between them', () => {
    const result = matchDocument(baseDocument(), twins);

    expect(result.outcome).toBe('NEEDS_REVIEW');
    expect(result.reason).toBe('AMBIGUOUS_TOP_CANDIDATES');
  });

  it('still returns both candidates, ranked, so a reviewer can choose', () => {
    const result = matchDocument(baseDocument(), twins);

    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0].confidence).toBeGreaterThanOrEqual(result.candidates[1].confidence);
  });

  it('does not route to review when the leader is clear of the runner-up', () => {
    const clear = [
      baseTransaction({ id: 1 }),
      baseTransaction({ id: 2, amount: 48000, merchantName: 'SACO HARDWARE RUH', cardLast4: '9001' }),
    ];

    expect(matchDocument(baseDocument(), clear).outcome).toBe('AUTO_MATCHED');
  });
});

/* -------------------------------------------------------------------------- */
/* Edge case 3 — amount off by a tip                                           */
/* -------------------------------------------------------------------------- */

describe('edge case 3: tip and rounding tolerance', () => {
  it('keeps a 10% restaurant tip as a review candidate, not an auto-match', () => {
    // Receipt 57.50 SAR, card charged 63.25 SAR — the brief's worked example.
    const doc = baseDocument({ totalAmount: 5750, merchantName: 'Najd Village Restaurant' });
    const txn = baseTransaction({ amount: 6325, merchantName: 'NAJD VILLAGE REST RUH' });

    const result = matchDocument(doc, [txn]);

    expect(result.outcome).toBe('NEEDS_REVIEW');
    expect(result.candidates[0].signals.amount).toBeGreaterThan(0.5);
    expect(result.candidates[0].signals.amount).toBeLessThan(0.9);
  });

  it('treats a few halalas of VAT rounding as effectively exact', () => {
    const result = matchDocument(baseDocument({ totalAmount: 12498 }), [baseTransaction()]);

    expect(result.candidates[0].signals.amount).toBeGreaterThan(0.95);
    expect(result.outcome).toBe('AUTO_MATCHED');
  });

  it('scores an overcharge higher than an equal-sized undercharge', () => {
    // Tips push the card ABOVE the receipt. The reverse is a different, rarer anomaly
    // and must not score the same.
    const over = matchDocument(baseDocument({ totalAmount: 10000 }), [
      baseTransaction({ amount: 11000 }),
    ]).candidates[0];
    const under = matchDocument(baseDocument({ totalAmount: 11000 }), [
      baseTransaction({ amount: 10000 }),
    ]);

    expect(over.signals.amount).toBeGreaterThan(0.5);
    expect(under.candidates[0]?.signals.amount ?? 0).toBeLessThan(over.signals.amount as number);
  });

  it('vetoes a transaction whose amount is nowhere near the receipt', () => {
    const result = matchDocument(baseDocument({ totalAmount: 12500 }), [
      baseTransaction({ amount: 98000 }),
    ]);

    expect(result.outcome).toBe('UNMATCHED');
    expect(result.candidates).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Edge case 5 — no transaction to match                                       */
/* -------------------------------------------------------------------------- */

describe('edge case 5: invoice with no corresponding transaction', () => {
  it('returns UNMATCHED when the candidate set is empty', () => {
    const result = matchDocument(baseDocument(), []);

    expect(result.outcome).toBe('UNMATCHED');
    expect(result.reason).toBe('NO_CANDIDATE_TRANSACTIONS');
    expect(result.candidates).toEqual([]);
  });

  it('returns UNMATCHED when every candidate scores below the review floor', () => {
    const result = matchDocument(baseDocument(), [
      baseTransaction({
        amount: 77000,
        merchantName: 'IKEA JEDDAH',
        cardLast4: '9999',
        transactionAt: new Date('2025-05-02T08:00:00Z'),
      }),
    ]);

    expect(result.outcome).toBe('UNMATCHED');
    expect(result.candidates).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Edge case 6 — garbage extraction                                            */
/* -------------------------------------------------------------------------- */

describe('edge case 6: unusable extraction', () => {
  it('returns UNMATCHED for an UNKNOWN document with no usable fields, without throwing', () => {
    const garbage = baseDocument({
      documentType: 'UNKNOWN',
      merchantName: null,
      totalAmount: null,
      currency: null,
      documentDate: null,
      cardLast4: null,
      vatNumber: null,
      extractionConfidence: 0.08,
    });

    const result = matchDocument(garbage, [baseTransaction()]);

    expect(result.outcome).toBe('UNMATCHED');
    expect(result.reason).toBe('UNUSABLE_EXTRACTION');
  });

  it('survives a malformed document date instead of producing NaN scores', () => {
    const result = matchDocument(baseDocument({ documentDate: 'not-a-date' }), [baseTransaction()]);

    expect(result.candidates[0]?.signals.date ?? null).toBeNull();
    expect(Number.isFinite(result.candidates[0].confidence)).toBe(true);
  });

  it('never returns NaN confidence even when every signal is missing', () => {
    const sparse = baseDocument({
      merchantName: null,
      totalAmount: null,
      documentDate: null,
      cardLast4: null,
      documentType: 'RECEIPT',
    });

    const result = matchDocument(sparse, [baseTransaction()]);

    expect(result.outcome).toBe('UNMATCHED');
    for (const candidate of result.candidates) {
      expect(Number.isFinite(candidate.confidence)).toBe(true);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Duplicate-receipt protection                                                */
/* -------------------------------------------------------------------------- */

describe('one confirmed document per transaction', () => {
  it('refuses to auto-match a transaction that already has a confirmed document', () => {
    const result = matchDocument(baseDocument(), [baseTransaction({ hasConfirmedDocument: true })]);

    expect(result.outcome).toBe('NEEDS_REVIEW');
    expect(result.reason).toBe('TRANSACTION_ALREADY_DOCUMENTED');
  });

  it('still surfaces the candidate so a reviewer can judge the possible duplicate', () => {
    const result = matchDocument(baseDocument(), [baseTransaction({ hasConfirmedDocument: true })]);

    expect(result.candidates[0].transactionId).toBe(1);
    expect(result.candidates[0].confidence).toBeGreaterThanOrEqual(MIN_CANDIDATE_THRESHOLD);
  });

  it('prefers an undocumented transaction over an equally-scoring documented one', () => {
    const result = matchDocument(baseDocument(), [
      baseTransaction({ id: 1, hasConfirmedDocument: true }),
      baseTransaction({ id: 2, hasConfirmedDocument: false }),
    ]);

    expect(result.candidates[0].transactionId).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/* Sender scoping — a hard filter, not a soft signal                           */
/* -------------------------------------------------------------------------- */

describe('sender scoping', () => {
  it('refuses a transaction belonging to another client', () => {
    const result = matchDocument(baseDocument({ clientId: 1 }), [
      baseTransaction({ clientId: 2 }),
    ]);

    expect(result.outcome).toBe('UNMATCHED');
    expect(result.candidates).toEqual([]);
  });

  it("refuses another driver's card even inside the same client", () => {
    const result = matchDocument(baseDocument({ source: 'WHATSAPP', driverPhone: '966551234567' }), [
      baseTransaction({ driverPhone: '966559999999' }),
    ]);

    expect(result.outcome).toBe('UNMATCHED');
  });

  it('lets an email document reach any transaction of its client', () => {
    const emailDoc = baseDocument({ source: 'EMAIL', driverPhone: null });
    const result = matchDocument(emailDoc, [baseTransaction({ driverPhone: '966559999999' })]);

    expect(result.outcome).toBe('AUTO_MATCHED');
  });
});

/* -------------------------------------------------------------------------- */
/* Signal-level behaviour                                                      */
/* -------------------------------------------------------------------------- */

describe('signal handling', () => {
  it('treats a missing card number as absent, not as a mismatch', () => {
    const withCard = matchDocument(baseDocument(), [baseTransaction()]).candidates[0];
    const withoutCard = matchDocument(baseDocument({ cardLast4: null }), [baseTransaction()])
      .candidates[0];

    expect(withoutCard.signals.cardLast4).toBeNull();
    // Dropping a signal must not be punished as if it contradicted — the remaining
    // weights renormalise, so confidence stays high.
    expect(withoutCard.confidence).toBeGreaterThan(0.8);
    expect(withCard.confidence).toBeGreaterThanOrEqual(withoutCard.confidence);
  });

  it('vetoes a candidate whose card number contradicts the receipt', () => {
    const result = matchDocument(baseDocument({ cardLast4: '4412' }), [
      baseTransaction({ cardLast4: '8899' }),
    ]);

    expect(result.outcome).toBe('UNMATCHED');
  });

  it('vetoes a currency mismatch', () => {
    const result = matchDocument(baseDocument({ currency: 'AED' }), [
      baseTransaction({ currency: 'SAR' }),
    ]);

    expect(result.outcome).toBe('UNMATCHED');
  });

  it('decays the date signal as the document drifts from the transaction', () => {
    const scoreAt = (iso: string) =>
      matchDocument(baseDocument({ documentDate: iso }), [baseTransaction()]).candidates[0]
        ?.signals.date ?? null;

    expect(scoreAt('2025-06-14T00:00:00Z')).toBe(1);
    expect(scoreAt('2025-06-13T00:00:00Z')).toBeLessThan(1);
    expect(scoreAt('2025-06-11T00:00:00Z')).toBeLessThan(scoreAt('2025-06-13T00:00:00Z') as number);
  });

  it('vetoes a document more than a week away from the transaction', () => {
    const result = matchDocument(baseDocument({ documentDate: '2025-05-01T00:00:00Z' }), [
      baseTransaction(),
    ]);

    expect(result.outcome).toBe('UNMATCHED');
  });

  it('caps confidence into review when only merchant and date are available', () => {
    const weak = baseDocument({ totalAmount: null, cardLast4: null });

    const result = matchDocument(weak, [baseTransaction()]);

    expect(result.outcome).toBe('NEEDS_REVIEW');
    expect(result.reason).toBe('WEAK_EVIDENCE');
  });

  it('withholds auto-match when the OCR itself had low confidence', () => {
    const blurry = baseDocument({ extractionConfidence: 0.3 });

    const result = matchDocument(blurry, [baseTransaction()]);

    expect(result.outcome).toBe('NEEDS_REVIEW');
    expect(result.reason).toBe('LOW_EXTRACTION_CONFIDENCE');
  });

  it('reports the OCR confidence separately from the match confidence', () => {
    // The breakdown must describe document-vs-transaction evidence only; folding OCR
    // confidence into it would make the explanation to a reviewer misleading.
    const sharp = matchDocument(baseDocument({ extractionConfidence: 0.99 }), [baseTransaction()]);
    const blurry = matchDocument(baseDocument({ extractionConfidence: 0.3 }), [baseTransaction()]);

    expect(blurry.candidates[0].confidence).toBe(sharp.candidates[0].confidence);
  });
});

/* -------------------------------------------------------------------------- */
/* Purity                                                                      */
/* -------------------------------------------------------------------------- */

describe('purity', () => {
  it('does not mutate its inputs', () => {
    const doc = baseDocument();
    const txns = [baseTransaction(), baseTransaction({ id: 2, amount: 999 })];
    const docBefore = JSON.stringify(doc);
    const txnsBefore = JSON.stringify(txns);

    matchDocument(doc, txns);

    expect(JSON.stringify(doc)).toBe(docBefore);
    expect(JSON.stringify(txns)).toBe(txnsBefore);
  });

  it('is deterministic across repeated calls', () => {
    const doc = baseDocument();
    const txns = [baseTransaction(), baseTransaction({ id: 2 })];

    expect(matchDocument(doc, txns)).toEqual(matchDocument(doc, txns));
  });

  it('ranks candidates stably when scores tie exactly', () => {
    const txns = [baseTransaction({ id: 5 }), baseTransaction({ id: 3 })];

    const ids = matchDocument(baseDocument(), txns).candidates.map((c) => c.transactionId);

    expect(ids).toEqual([3, 5]); // lowest id first on an exact tie — deterministic
  });
});
