import { matchDocument, scoreCardLast4 } from '@/lib/services/transaction-matcher';
import type { CandidateTransaction, MatchableDocument } from '@/lib/services/transaction-matcher';
import { merchantSimilarity, normaliseMerchant } from '@/lib/matching/merchant';
import { MIN_CORROBORATING_SIGNALS } from '@/lib/matching/scoring-config';

/**
 * Regression cover for the review findings on weak-but-present evidence.
 *
 * The engine reasoned carefully about *absent* signals and renormalised for them, but
 * treated a signal that was present and uninformative as though it were evidence. These
 * tests pin the corrected behaviour at each place that asymmetry surfaced.
 */

const BASE = new Date('2025-06-14T11:02:00Z');

const doc = (overrides: Partial<MatchableDocument> = {}): MatchableDocument => ({
  source: 'WHATSAPP',
  clientId: 1,
  driverPhone: '966551234567',
  documentType: 'RECEIPT',
  merchantName: 'ALFANAR FUEL',
  vatNumber: null,
  totalAmount: 10000,
  currency: 'SAR',
  documentDate: BASE.toISOString(),
  cardLast4: '4412',
  invoiceNumber: null,
  extractionConfidence: 0.95,
  ...overrides,
});

let nextId = 1;
const txn = (overrides: Partial<CandidateTransaction> = {}): CandidateTransaction => ({
  id: nextId++,
  clientId: 1,
  cardLast4: '4412',
  driverPhone: '966551234567',
  merchantName: 'ALFANAR FUEL',
  amount: 10000,
  currency: 'SAR',
  transactionAt: BASE,
  hasConfirmedDocument: false,
  ...overrides,
});

beforeEach(() => {
  nextId = 1;
});

/* ========================================================================== */
/* B1 — a lone signal must never attach money without corroboration           */
/* ========================================================================== */

describe('minimum corroboration before auto-match', () => {
  test('refuses to auto-match on a matching amount alone', () => {
    const result = matchDocument(
      doc({ merchantName: null, documentDate: null, cardLast4: null }),
      [txn()],
    );

    expect(result.outcome).toBe('NEEDS_REVIEW');
    expect(result.reason).toBe('INSUFFICIENT_CORROBORATION');
    expect(Object.keys(result.candidates[0]!.signals)).toEqual(['amount']);
  });

  test('refuses to auto-match on a matching card number alone', () => {
    const result = matchDocument(
      doc({ merchantName: null, documentDate: null, totalAmount: null }),
      [txn()],
    );

    expect(result.outcome).toBe('NEEDS_REVIEW');
    expect(result.reason).toBe('INSUFFICIENT_CORROBORATION');
  });

  test('auto-matches once a second independent signal corroborates', () => {
    const result = matchDocument(
      doc({ merchantName: null, cardLast4: null }), // amount + date
      [txn()],
    );

    expect(result.outcome).toBe('AUTO_MATCHED');
  });

  test('still surfaces the lone-signal candidate for a human rather than hiding it', () => {
    const result = matchDocument(
      doc({ merchantName: null, documentDate: null, cardLast4: null }),
      [txn()],
    );

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.transactionId).toBe(1);
  });

  test('the corroboration floor is at least two signals', () => {
    expect(MIN_CORROBORATING_SIGNALS).toBeGreaterThanOrEqual(2);
  });
});

/* ========================================================================== */
/* S1 — an uninformative merchant name must not lower confidence              */
/* ========================================================================== */

describe('merchant names that carry no information', () => {
  test('an acquirer name that normalises to nothing is treated as absent, not contradicting', () => {
    const withMerchant = matchDocument(
      doc({ merchantName: 'Alfanar Fuel Station' }),
      [txn({ merchantName: 'POS 04 RUH' })],
    );

    expect(normaliseMerchant('POS 04 RUH')).toEqual([]);
    expect(withMerchant.outcome).toBe('AUTO_MATCHED');
    expect('merchant' in withMerchant.candidates[0]!.signals).toBe(false);
  });

  test('reading a merchant name never scores lower than not reading one', () => {
    const transaction = txn({ merchantName: 'POS 04 RUH' });
    const withName = matchDocument(doc({ merchantName: 'Alfanar Fuel Station' }), [transaction]);
    const withoutName = matchDocument(doc({ merchantName: null }), [transaction]);

    expect(withName.candidates[0]!.confidence).toBeGreaterThanOrEqual(
      withoutName.candidates[0]!.confidence,
    );
  });
});

/* ========================================================================== */
/* S2 — sector vocabulary is not evidence, whichever side it comes from       */
/* ========================================================================== */

describe('generic-token discount', () => {
  test('a content-free acquirer name does not match its whole sector at high confidence', () => {
    expect(merchantSimilarity('FUEL STATION 04 RUH', 'Shell Fuel Station')).toBeLessThan(0.45);
    expect(merchantSimilarity('FUEL STATION 04 RUH', 'Petromin Fuel Station')).toBeLessThan(0.45);
  });

  test('two different merchants in one sector still score alike — neither is preferred', () => {
    const shell = merchantSimilarity('FUEL STATION 04 RUH', 'Shell Fuel Station');
    const petromin = merchantSimilarity('FUEL STATION 04 RUH', 'Petromin Fuel Station');

    expect(Math.abs(shell - petromin)).toBeLessThan(0.1);
  });

  test('the existing distinctive-token case is unaffected', () => {
    expect(merchantSimilarity('ALFANAR FUEL STATION', 'PETROMIN FUEL STATION')).toBeLessThan(0.45);
    expect(merchantSimilarity('ALFANAR FUEL ST 04 RUH', 'Alfanar Fuel Station')).toBeGreaterThan(0.8);
  });
});

/* ========================================================================== */
/* S3 — the Saudi "Al" prefix, attached or detached, is the same merchant     */
/* ========================================================================== */

describe('Al- prefix normalisation', () => {
  test('strips an attached AL prefix so it tokenises like the detached form', () => {
    expect(normaliseMerchant('Aljazira Market')).toEqual(normaliseMerchant('AL JAZIRA MARKET'));
  });

  test('the same merchant written both ways scores as a strong match', () => {
    expect(merchantSimilarity('AL JAZIRA MARKET', 'Aljazira Market')).toBeGreaterThan(0.8);
  });

  test('does not maul a word that merely starts with the letters AL', () => {
    expect(normaliseMerchant('ALFANAR FUEL')).toContain('ALFANAR');
  });
});

/* ========================================================================== */
/* M1 — card formatting variance is not a contradiction                       */
/* ========================================================================== */

describe('card last4 normalisation', () => {
  test('a dropped leading zero still matches', () => {
    expect(scoreCardLast4('412', '0412')).toBe(1);
  });

  test('a masked card number still matches', () => {
    expect(scoreCardLast4('**** 4412', '4412')).toBe(1);
    expect(scoreCardLast4('x4412', '4412')).toBe(1);
  });

  test('genuinely different cards still contradict', () => {
    expect(scoreCardLast4('0412', '4412')).toBe(0);
  });

  test('an unreadable card number is absent rather than contradicting', () => {
    expect(scoreCardLast4('****', '4412')).toBeNull();
  });

  test('a full match survives a formatting difference end to end', () => {
    const result = matchDocument(
      doc({ cardLast4: '412', merchantName: 'Alfanar Fuel Station' }),
      [txn({ cardLast4: '0412', merchantName: 'ALFANAR FUEL ST 04 RUH' })],
    );

    expect(result.outcome).toBe('AUTO_MATCHED');
  });
});

/* ========================================================================== */
/* M2 — a non-finite OCR confidence must not slip past the gate               */
/* ========================================================================== */

describe('extraction confidence gate', () => {
  test('a NaN confidence is distrusted rather than treated as passing', () => {
    const result = matchDocument(doc({ extractionConfidence: NaN }), [txn()]);

    expect(result.outcome).toBe('NEEDS_REVIEW');
    expect(result.reason).toBe('LOW_EXTRACTION_CONFIDENCE');
  });
});

/* ========================================================================== */
/* M3 — a non-match must explain itself                                       */
/* ========================================================================== */

describe('explainability of non-matches', () => {
  test('records why each transaction was vetoed', () => {
    const result = matchDocument(doc({ cardLast4: '9999' }), [txn({ id: 7 })]);

    expect(result.outcome).toBe('UNMATCHED');
    expect(result.vetoed).toEqual([{ transactionId: 7, veto: 'CARD_LAST4_CONTRADICTED' }]);
  });

  test('names a currency veto distinctly from a card veto', () => {
    const result = matchDocument(doc({ currency: 'AED' }), [txn({ id: 3 })]);

    expect(result.vetoed).toEqual([{ transactionId: 3, veto: 'CURRENCY_MISMATCH' }]);
  });

  test('names a scope veto', () => {
    const result = matchDocument(doc(), [txn({ id: 5, clientId: 99 })]);

    expect(result.vetoed).toEqual([{ transactionId: 5, veto: 'OUT_OF_SCOPE' }]);
  });
});

describe('two signals are not automatically enough', () => {
  it('refuses to auto-match on merchant and date alone', () => {
    // Worth pinning because the corroboration floor alone does *not* carry this case.
    // That floor counts signal keys, and merchant plus date is two keys — it passes. What
    // actually holds the line is the weak-evidence cap: without an amount or a card
    // number the confidence is capped below the auto threshold.
    //
    // The distinction matters for anyone adding a signal later. A new cheap signal
    // (currency agreement, document type) raises the key count without adding evidence,
    // so the floor would stop binding; only the cap would remain. If that ever becomes
    // load-bearing on its own, measure corroboration in observed *weight* rather than in
    // key count — same number of lines, and it does not move when the table is re-sliced.
    const result = matchDocument(
      doc({ totalAmount: null, cardLast4: null }),
      [txn()],
    );

    expect(result.outcome).toBe('NEEDS_REVIEW');
  });

  it('auto-matches on an amount and a card number, which are the two that carry weight', () => {
    const result = matchDocument(
      doc({ merchantName: null, documentDate: null }),
      [txn()],
    );

    expect(result.outcome).toBe('AUTO_MATCHED');
  });
});
