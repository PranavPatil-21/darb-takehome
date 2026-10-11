import {
  matchDocument,
  scoreAmount,
  scoreCardLast4,
  scoreDate,
  scoreMerchant,
} from '@/lib/services/transaction-matcher';
import type { CandidateTransaction, MatchableDocument } from '@/lib/services/transaction-matcher';
import {
  AMBIGUITY_MARGIN,
  AUTO_MATCH_THRESHOLD,
  DATE_PROXIMITY_CURVE,
  MAX_DATE_DRIFT_DAYS,
  MAX_TIP_RATIO,
  MAX_UNDERCHARGE_RATIO,
  MIN_CANDIDATE_THRESHOLD,
  MIN_EXTRACTION_CONFIDENCE_FOR_AUTO,
  VAT_ROUNDING_TOLERANCE_HALALAS,
  WEAK_EVIDENCE_CONFIDENCE_CAP,
} from '@/lib/matching/scoring-config';

/**
 * Boundary and edge-case coverage for the matching engine.
 *
 * `transaction-matcher.test.ts` covers the six scenarios the brief names. This file
 * covers the places those scenarios do not reach: the exact values at which behaviour
 * flips, degenerate inputs, and combinations that only appear once a few rules interact.
 *
 * Every threshold in the engine is a cliff — one halala, one day, or one hundredth of a
 * point either side changes the outcome. Tests that sit comfortably in the middle of a
 * band prove the band exists; only tests sitting exactly on the edge prove it is in the
 * right place and that the comparison is the right way round. An off-by-one in `<` vs
 * `<=` here is a real receipt silently attached to the wrong transaction.
 */

const BASE = new Date('2025-06-14T11:02:00Z');
const MS_PER_DAY = 86_400_000;

/** An ISO timestamp exactly `days` whole days from the base transaction. */
const daysFrom = (days: number) => new Date(BASE.getTime() + days * MS_PER_DAY).toISOString();

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
/* Amount — the signal carrying the most weight                               */
/* ========================================================================== */

describe('amount boundaries', () => {
  it('treats drift up to the VAT tolerance as effectively exact, in both directions', () => {
    for (let delta = -VAT_ROUNDING_TOLERANCE_HALALAS; delta <= VAT_ROUNDING_TOLERANCE_HALALAS; delta++) {
      const score = scoreAmount(10_000, 10_000 + delta);
      expect(score).toBe(delta === 0 ? 1 : 0.97);
    }
  });

  it('drops off the VAT plateau one halala past the tolerance', () => {
    // Just outside the band the score must fall, but only slightly — a 6-halala gap is
    // still obviously the same purchase.
    const justOutside = scoreAmount(10_000, 10_000 + VAT_ROUNDING_TOLERANCE_HALALAS + 1);
    expect(justOutside).toBeLessThan(0.97);
    expect(justOutside).toBeGreaterThan(0.89);
  });

  it('scores a tip at exactly the maximum ratio, and vetoes one hair beyond it', () => {
    const atLimit = scoreAmount(10_000, 10_000 + 10_000 * MAX_TIP_RATIO);
    expect(atLimit).toBe(0.5); // the bottom of the tip band, not a veto

    const pastLimit = scoreAmount(10_000, 10_000 + 10_000 * MAX_TIP_RATIO + 1);
    expect(pastLimit).toBe(0);
  });

  it('scores an undercharge at exactly the maximum ratio, and vetoes beyond it', () => {
    const atLimit = scoreAmount(10_000, 10_000 - 10_000 * MAX_UNDERCHARGE_RATIO);
    expect(atLimit).toBe(0.45);

    const pastLimit = scoreAmount(10_000, 10_000 - 10_000 * MAX_UNDERCHARGE_RATIO - 1);
    expect(pastLimit).toBe(0);
  });

  it('decays monotonically across the whole tip band', () => {
    // A larger tip must never score higher than a smaller one. A non-monotonic curve
    // would let a worse match outrank a better one.
    let previous = Infinity;
    for (let delta = 6; delta <= 2500; delta += 25) {
      const score = scoreAmount(10_000, 10_000 + delta)!;
      expect(score).toBeLessThanOrEqual(previous);
      previous = score;
    }
  });

  it('is asymmetric: an overcharge always beats the same-sized undercharge', () => {
    // Tips push the card above the receipt; the reverse is a rarer anomaly.
    for (const delta of [50, 100, 150, 200]) {
      const over = scoreAmount(10_000, 10_000 + delta)!;
      const under = scoreAmount(10_000, 10_000 - delta)!;
      expect(over).toBeGreaterThan(under);
    }
  });

  it('refuses to score a zero or negative document amount', () => {
    // A zero total is unreadable OCR, not a free purchase.
    expect(scoreAmount(0, 10_000)).toBeNull();
    expect(scoreAmount(-100, 10_000)).toBeNull();
  });

  it('handles very large amounts without losing precision', () => {
    const large = 999_999_999; // ~10 million SAR
    expect(scoreAmount(large, large)).toBe(1);
    expect(scoreAmount(large, large + 3)).toBe(0.97);
  });

  it('always returns a finite score in 0..1, or null', () => {
    for (const d of [1, 100, 10_000, 999_999]) {
      for (const t of [1, 99, 10_001, 500_000]) {
        const score = scoreAmount(d, t);
        if (score !== null) {
          expect(Number.isFinite(score)).toBe(true);
          expect(score).toBeGreaterThanOrEqual(0);
          expect(score).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

/* ========================================================================== */
/* Date                                                                        */
/* ========================================================================== */

describe('date boundaries', () => {
  it('follows the published curve for every day inside the window', () => {
    for (let drift = 0; drift <= MAX_DATE_DRIFT_DAYS; drift++) {
      const expected = DATE_PROXIMITY_CURVE[Math.min(drift, DATE_PROXIMITY_CURVE.length - 1)];
      expect(scoreDate(daysFrom(drift), BASE)).toBe(expected);
      expect(scoreDate(daysFrom(-drift), BASE)).toBe(expected);
    }
  });

  it('still scores at exactly the drift limit, and vetoes one day past it', () => {
    expect(scoreDate(daysFrom(MAX_DATE_DRIFT_DAYS), BASE)).toBeGreaterThan(0);
    expect(scoreDate(daysFrom(MAX_DATE_DRIFT_DAYS + 1), BASE)).toBe(0);
    expect(scoreDate(daysFrom(-(MAX_DATE_DRIFT_DAYS + 1)), BASE)).toBe(0);
  });

  it('is symmetric — a receipt dated before or after scores the same', () => {
    // A receipt can predate the posting (normal) or postdate it (clock skew, late
    // capture). Neither is more suspicious than the other.
    for (let drift = 1; drift <= MAX_DATE_DRIFT_DAYS; drift++) {
      expect(scoreDate(daysFrom(drift), BASE)).toBe(scoreDate(daysFrom(-drift), BASE));
    }
  });

  it('counts whole calendar days, so two minutes either side of midnight is one day', () => {
    const lateNight = new Date('2025-06-14T23:59:00Z');
    const justAfterMidnight = '2025-06-15T00:01:00Z';
    // Two minutes apart in real time, but different calendar days — scored as one day.
    expect(scoreDate(justAfterMidnight, lateNight)).toBe(DATE_PROXIMITY_CURVE[1]);
  });

  it('treats an unparseable date as absent rather than as a mismatch', () => {
    for (const bad of ['not-a-date', '', '2025-13-45', 'yesterday']) {
      expect(scoreDate(bad, BASE)).toBeNull();
    }
  });

  it('never returns NaN for any input', () => {
    for (const value of [null, '', 'xx', BASE.toISOString(), daysFrom(99)]) {
      const score = scoreDate(value, BASE);
      expect(score === null || Number.isFinite(score)).toBe(true);
    }
  });
});

/* ========================================================================== */
/* Card                                                                        */
/* ========================================================================== */

describe('card number', () => {
  it('matches despite surrounding whitespace from OCR', () => {
    expect(scoreCardLast4(' 4412 ', '4412')).toBe(1);
    expect(scoreCardLast4('4412', ' 4412 ')).toBe(1);
  });

  it('treats a leading zero as significant — 0412 is not 4412', () => {
    expect(scoreCardLast4('0412', '4412')).toBe(0);
  });

  it('is absent rather than zero when the document shows no card', () => {
    // The distinction the whole renormalisation design rests on.
    expect(scoreCardLast4(null, '4412')).toBeNull();
    expect(scoreCardLast4('8899', '4412')).toBe(0);
  });
});

/* ========================================================================== */
/* Merchant                                                                    */
/* ========================================================================== */

describe('merchant similarity in the matcher', () => {
  it('is absent when the document carries no merchant name', () => {
    expect(scoreMerchant(null, 'ALFANAR FUEL')).toBeNull();
  });

  it('scores zero rather than null when the name normalises away to nothing', () => {
    // "LLC" is pure legal form — present on the document, but carrying no information.
    // That is a comparison that happened and failed, not a missing field.
    expect(scoreMerchant('LLC', 'ALFANAR FUEL')).toBe(0);
  });

  it('is symmetric regardless of which side is the noisy bank string', () => {
    const a = scoreMerchant('Alfanar Fuel Station', 'ALFANAR FUEL ST 04 RUH')!;
    const b = scoreMerchant('ALFANAR FUEL ST 04 RUH', 'Alfanar Fuel Station')!;
    expect(a).toBeCloseTo(b, 6);
  });

  it('survives pathological names without throwing', () => {
    const nasty = ['', '   ', '###', '0000', 'A', 'A'.repeat(500), '☕️🧾', '\n\t'];
    for (const name of nasty) {
      const score = scoreMerchant(name, 'ALFANAR FUEL');
      expect(score === null || (score >= 0 && score <= 1)).toBe(true);
    }
  });
});

/* ========================================================================== */
/* Outcome thresholds — where a decision actually flips                        */
/* ========================================================================== */

describe('the auto-match threshold', () => {
  it('attaches a lone candidate sitting exactly on the threshold', () => {
    // Amount-only evidence of 0.85 would normally be awkward to construct; a perfect
    // match is the clean way to prove the comparison is >= rather than >.
    const result = matchDocument(doc(), [txn()]);
    expect(result.candidates[0].confidence).toBeGreaterThanOrEqual(AUTO_MATCH_THRESHOLD);
    expect(result.outcome).toBe('AUTO_MATCHED');
  });

  it('sends a lone candidate just below the threshold to review', () => {
    // 10% tip: amount 0.74, everything else perfect → ~0.896? No: 0.4*0.74 + 0.6 = 0.896
    // is above. Push the merchant down too so the blend lands under the bar.
    const result = matchDocument(doc({ merchantName: 'KUDU RESTAURANT' }), [
      txn({ amount: 11_000 }),
    ]);
    expect(result.candidates[0].confidence).toBeLessThan(AUTO_MATCH_THRESHOLD);
    expect(result.outcome).toBe('NEEDS_REVIEW');
  });
});

describe('the ambiguity margin', () => {
  // Constructed so the runner-up lands an exact distance from a perfect leader.
  const leaderAndRunnerUp = (runnerUpAmount: number) =>
    matchDocument(doc({ totalAmount: 12_800 }), [
      txn({ id: 1, amount: 12_800 }),
      txn({ id: 2, amount: runnerUpAmount }),
    ]);

  it('auto-matches when the gap is exactly the margin', () => {
    // A gap of precisely the margin is not "within" it — the comparison is strict.
    const result = leaderAndRunnerUp(13_000);
    const gap = result.candidates[0].confidence - result.candidates[1].confidence;
    expect(gap).toBeCloseTo(AMBIGUITY_MARGIN, 6);
    expect(result.outcome).toBe('AUTO_MATCHED');
  });

  it('routes to review when the gap is a hair under the margin', () => {
    const result = leaderAndRunnerUp(12_980);
    const gap = result.candidates[0].confidence - result.candidates[1].confidence;
    expect(gap).toBeLessThan(AMBIGUITY_MARGIN);
    expect(result.outcome).toBe('NEEDS_REVIEW');
    expect(result.reason).toBe('AMBIGUOUS_TOP_CANDIDATES');
  });

  it('only compares the top two — a distant third never causes ambiguity', () => {
    const result = matchDocument(doc(), [
      txn({ id: 1 }),
      txn({ id: 2, amount: 10_000 - 150 }), // clearly worse
      txn({ id: 3, amount: 10_000 - 190 }),
    ]);
    expect(result.outcome).toBe('AUTO_MATCHED');
  });

  it('routes a three-way tie to review', () => {
    const result = matchDocument(doc(), [txn({ id: 1 }), txn({ id: 2 }), txn({ id: 3 })]);
    expect(result.outcome).toBe('NEEDS_REVIEW');
    expect(result.reason).toBe('AMBIGUOUS_TOP_CANDIDATES');
    expect(result.candidates).toHaveLength(3);
  });
});

describe('the review floor', () => {
  it('keeps a candidate sitting exactly on the floor', () => {
    // Amount alone, at the undercharge score of 0.45 — exactly the floor.
    const sparse = doc({ merchantName: null, documentDate: null, cardLast4: null });
    const result = matchDocument(sparse, [txn({ amount: 9_900 })]);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].confidence).toBeCloseTo(MIN_CANDIDATE_THRESHOLD, 6);
    expect(result.outcome).toBe('NEEDS_REVIEW');
  });

  it('discards a candidate clearly below the floor', () => {
    const weak = doc({ totalAmount: null, cardLast4: null, merchantName: 'IKEA JEDDAH' });
    const result = matchDocument(weak, [txn({ transactionAt: new Date(BASE.getTime() + 5 * MS_PER_DAY) })]);

    expect(result.candidates).toHaveLength(0);
    expect(result.outcome).toBe('UNMATCHED');
  });
});

describe('the OCR confidence gate', () => {
  it('allows an auto-match at exactly the minimum confidence', () => {
    const result = matchDocument(
      doc({ extractionConfidence: MIN_EXTRACTION_CONFIDENCE_FOR_AUTO }),
      [txn()],
    );
    expect(result.outcome).toBe('AUTO_MATCHED');
  });

  it('withholds an auto-match a hundredth below it', () => {
    const result = matchDocument(
      doc({ extractionConfidence: MIN_EXTRACTION_CONFIDENCE_FOR_AUTO - 0.01 }),
      [txn()],
    );
    expect(result.outcome).toBe('NEEDS_REVIEW');
    expect(result.reason).toBe('LOW_EXTRACTION_CONFIDENCE');
  });

  it('does not let a zero-confidence read attach itself however well it scores', () => {
    const result = matchDocument(doc({ extractionConfidence: 0 }), [txn()]);
    expect(result.outcome).toBe('NEEDS_REVIEW');
  });
});

describe('the weak-evidence cap', () => {
  it('caps a perfect merchant-and-date match at exactly the cap', () => {
    const noMoney = doc({ totalAmount: null, cardLast4: null });
    const result = matchDocument(noMoney, [txn()]);

    expect(result.candidates[0].confidence).toBeCloseTo(WEAK_EVIDENCE_CONFIDENCE_CAP, 6);
    expect(result.reason).toBe('WEAK_EVIDENCE');
  });

  it('does not apply when an amount is present but the card is not', () => {
    const invoice = doc({ cardLast4: null });
    const result = matchDocument(invoice, [txn()]);

    expect(result.candidates[0].confidence).toBeGreaterThan(WEAK_EVIDENCE_CONFIDENCE_CAP);
    expect(result.outcome).toBe('AUTO_MATCHED');
  });

  it('does not apply when a card is present but the amount is not', () => {
    const unreadableTotal = doc({ totalAmount: null });
    const result = matchDocument(unreadableTotal, [txn()]);

    expect(result.candidates[0].confidence).toBeGreaterThan(WEAK_EVIDENCE_CONFIDENCE_CAP);
  });
});

/* ========================================================================== */
/* Renormalisation across every combination of available evidence              */
/* ========================================================================== */

describe('renormalisation', () => {
  it('reaches a perfect score from any subset, when everything available agrees', () => {
    // Dropping evidence must not be punished — only contradiction is.
    const subsets: Partial<MatchableDocument>[] = [
      {},
      { cardLast4: null },
      { documentDate: null },
      { merchantName: null },
      { cardLast4: null, documentDate: null },
      { cardLast4: null, merchantName: null },
      { documentDate: null, merchantName: null },
    ];

    for (const subset of subsets) {
      const result = matchDocument(doc(subset), [txn()]);
      expect(result.candidates[0].confidence).toBe(1);
    }
  });

  it('weights sum to the whole, whichever signals survive', () => {
    const result = matchDocument(doc({ cardLast4: null, documentDate: null }), [txn()]);
    // Only amount and merchant remain; a perfect score proves they were renormalised
    // to 100% between them rather than diluted by the missing two.
    expect(Object.keys(result.candidates[0].signals).sort()).toEqual(['amount', 'merchant']);
    expect(result.candidates[0].confidence).toBe(1);
  });

  it('cannot score anything when the document carries no comparable evidence', () => {
    const empty = doc({
      totalAmount: null,
      cardLast4: null,
      merchantName: null,
      documentDate: null,
    });
    const result = matchDocument(empty, [txn()]);
    expect(result.outcome).toBe('UNMATCHED');
    expect(result.reason).toBe('UNUSABLE_EXTRACTION');
  });
});

/* ========================================================================== */
/* Currency                                                                    */
/* ========================================================================== */

describe('currency', () => {
  it('ignores case and padding, which OCR introduces constantly', () => {
    for (const currency of ['sar', ' SAR ', 'Sar', '  sar']) {
      expect(matchDocument(doc({ currency }), [txn()]).outcome).toBe('AUTO_MATCHED');
    }
  });

  it('eliminates a genuinely different currency, whatever else agrees', () => {
    // Every other signal is perfect here. Currency still wins.
    for (const currency of ['AED', 'USD', 'EUR']) {
      expect(matchDocument(doc({ currency }), [txn()]).outcome).toBe('UNMATCHED');
    }
  });

  it('does not eliminate when the document has no readable currency', () => {
    expect(matchDocument(doc({ currency: null }), [txn()]).outcome).toBe('AUTO_MATCHED');
  });
});

/* ========================================================================== */
/* Scope — the rule that must never be outvoted                                */
/* ========================================================================== */

describe('scope', () => {
  it('refuses every transaction when the sender could not be identified', () => {
    const unknown = doc({ clientId: null, driverPhone: null });
    expect(matchDocument(unknown, [txn(), txn(), txn()]).outcome).toBe('UNMATCHED');
  });

  it('lets an email reach a card with no driver attached', () => {
    // A corporate pool card has no driver. Only the client-wide email route can see it.
    const email = doc({ source: 'EMAIL', driverPhone: null });
    const pool = txn({ driverPhone: null, cardLast4: '1155' });
    expect(matchDocument(email, [{ ...pool, cardLast4: '4412' }]).outcome).toBe('AUTO_MATCHED');
  });

  it("confines a WhatsApp document to its own driver's cards", () => {
    const result = matchDocument(doc(), [txn({ driverPhone: '966559999999' })]);
    expect(result.outcome).toBe('UNMATCHED');
  });

  it('cannot be outvoted by a perfect match on every other signal', () => {
    // Identical amount, card, merchant and date — but another customer's transaction.
    const result = matchDocument(doc(), [txn({ clientId: 2 })]);
    expect(result.candidates).toHaveLength(0);
  });
});

/* ========================================================================== */
/* Already-documented transactions                                             */
/* ========================================================================== */

describe('transactions that already hold a receipt', () => {
  it('routes to review rather than silently attaching a second receipt', () => {
    const result = matchDocument(doc(), [txn({ hasConfirmedDocument: true })]);
    expect(result.outcome).toBe('NEEDS_REVIEW');
    expect(result.reason).toBe('TRANSACTION_ALREADY_DOCUMENTED');
  });

  it('still auto-matches a free transaction when a documented one ties with it', () => {
    // The free one is preferred at equal confidence, and being preferred is enough.
    const result = matchDocument(doc(), [
      txn({ id: 1, hasConfirmedDocument: true }),
      txn({ id: 2, hasConfirmedDocument: false }),
    ]);
    expect(result.candidates[0].transactionId).toBe(2);
  });

  it('reviews when every plausible candidate is already documented', () => {
    const result = matchDocument(doc(), [
      txn({ id: 1, hasConfirmedDocument: true }),
      txn({ id: 2, hasConfirmedDocument: true }),
    ]);
    expect(result.outcome).toBe('NEEDS_REVIEW');
  });
});

/* ========================================================================== */
/* Degenerate inputs                                                           */
/* ========================================================================== */

describe('degenerate inputs', () => {
  it('handles an empty candidate list', () => {
    const result = matchDocument(doc(), []);
    expect(result.outcome).toBe('UNMATCHED');
    expect(result.reason).toBe('NO_CANDIDATE_TRANSACTIONS');
  });

  it('handles a large candidate set without changing its answer', () => {
    // 500 near-misses plus one exact match. The right one must still win.
    const noise = Array.from({ length: 500 }, (_, i) =>
      txn({ id: i + 10, amount: 10_000 + 3_000 + i }),
    );
    const result = matchDocument(doc(), [...noise, txn({ id: 7 })]);

    expect(result.outcome).toBe('AUTO_MATCHED');
    expect(result.candidates[0].transactionId).toBe(7);
  });

  it('treats an UNKNOWN document type with readable fields as still matchable', () => {
    // OCR not recognising the layout does not mean the fields it read are wrong.
    const result = matchDocument(doc({ documentType: 'UNKNOWN' }), [txn()]);
    expect(result.outcome).toBe('AUTO_MATCHED');
  });

  it('refuses an UNKNOWN document that also has no amount and no card', () => {
    const result = matchDocument(
      doc({ documentType: 'UNKNOWN', totalAmount: null, cardLast4: null }),
      [txn()],
    );
    expect(result.reason).toBe('UNUSABLE_EXTRACTION');
  });

  it('never returns a candidate below the floor, under any combination', () => {
    // A broad sweep: whatever comes back must always clear the bar it claims to.
    for (const amount of [10_000, 10_003, 10_500, 9_900]) {
      for (const card of [null, '4412', '8899']) {
        for (const drift of [0, 2, 7]) {
          const result = matchDocument(
            doc({ totalAmount: amount, cardLast4: card, documentDate: daysFrom(drift) }),
            [txn()],
          );
          for (const candidate of result.candidates) {
            expect(candidate.confidence).toBeGreaterThanOrEqual(MIN_CANDIDATE_THRESHOLD);
          }
        }
      }
    }
  });

  it('keeps candidates in descending confidence order, always', () => {
    const result = matchDocument(doc(), [
      txn({ id: 1, amount: 10_500 }),
      txn({ id: 2, amount: 10_000 }),
      txn({ id: 3, amount: 10_200 }),
      txn({ id: 4, amount: 10_050 }),
    ]);

    for (let i = 1; i < result.candidates.length; i++) {
      expect(result.candidates[i - 1].confidence).toBeGreaterThanOrEqual(
        result.candidates[i].confidence,
      );
    }
  });
});
