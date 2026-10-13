import {
  buildComparison,
  calendarDaysApart,
  chargeDifferences,
  distinguishingFields,
  pointsOfDifference,
  type ComparableCharge,
  type ComparableDocument,
} from '@/lib/ui/comparison';
import { MAX_DATE_DRIFT_DAYS, VAT_ROUNDING_TOLERANCE_HALALAS } from '@/lib/matching/scoring-config';
import { formatAge, formatDay, formatTime } from '@/lib/format';
import { merchantSimilarity } from '@/lib/matching/merchant';

/**
 * The document-versus-charge comparison shown to a reviewer.
 *
 * This is presentation logic, but it is the presentation logic standing between a human
 * and the one mistake this product exists to prevent: attaching a receipt to the wrong
 * charge. A row that says AGREES when two values differ, or stays silent when the card
 * numbers do not match, is worse than no interface at all — it launders a bad decision as
 * a checked one. So it is tested like engine code rather than like a view.
 */

const doc = (overrides: Partial<ComparableDocument> = {}): ComparableDocument => ({
  merchantName: 'Alfanar Fuel Station',
  totalAmount: 12_500,
  currency: 'SAR',
  documentDate: new Date('2025-06-14T11:02:00Z'),
  cardLast4: '4412',
  ...overrides,
});

const charge = (overrides: Partial<ComparableCharge> = {}): ComparableCharge => ({
  merchantName: 'ALFANAR FUEL ST 04 RUH',
  amount: 12_500,
  currency: 'SAR',
  transactionAt: new Date('2025-06-14T11:02:00Z'),
  cardLast4: '4412',
  ...overrides,
});

const rowFor = (field: string, d = doc(), c = charge()) =>
  buildComparison(d, c).find((row) => row.field === field)!;

describe('amount', () => {
  it('agrees when the two are identical', () => {
    expect(rowFor('amount').verdict).toBe('AGREES');
    expect(rowFor('amount').note).toBeNull();
  });

  it('calls a few halalas rounding rather than a discrepancy', () => {
    // Inside this band the difference carries no information. Reporting it as a
    // difference sends a reviewer hunting for something that is pure arithmetic.
    const row = rowFor(
      'amount',
      doc(),
      charge({ amount: 12_500 + VAT_ROUNDING_TOLERANCE_HALALAS }),
    );
    expect(row.verdict).toBe('CLOSE');
    expect(row.note).toMatch(/rounding/i);
  });

  it('reports a difference one halala past the rounding band', () => {
    const row = rowFor(
      'amount',
      doc(),
      charge({ amount: 12_500 + VAT_ROUNDING_TOLERANCE_HALALAS + 1 }),
    );
    expect(row.verdict).toBe('DIFFERS');
  });

  it('explains an overcharge as a tip, because that is usually what it is', () => {
    const row = rowFor('amount', doc({ totalAmount: 5_750 }), charge({ amount: 6_325 }));
    expect(row.verdict).toBe('DIFFERS');
    expect(row.note).toContain('5.75 SAR more');
    expect(row.note).toMatch(/tip/i);
  });

  it('refuses to explain away an undercharge', () => {
    // The asymmetry is the point. A card charged more than the receipt is routine; less
    // is not, and the copy must not invite a reviewer to wave it through.
    const row = rowFor('amount', doc({ totalAmount: 12_500 }), charge({ amount: 11_000 }));
    expect(row.verdict).toBe('DIFFERS');
    expect(row.note).toContain('15.00 SAR less');
    expect(row.note).toMatch(/cannot explain/i);
  });

  it('says so when the document carried no total at all', () => {
    const row = rowFor('amount', doc({ totalAmount: null }));
    expect(row.verdict).toBe('NOT_ON_DOCUMENT');
    expect(row.documentValue).toBeNull();
  });
});

describe('card', () => {
  it('agrees on identical digits', () => {
    expect(rowFor('card').verdict).toBe('AGREES');
  });

  it('states plainly that a mismatch means another charge', () => {
    // The card number is the field OCR rarely gets subtly wrong, so a mismatch is close
    // to decisive and deserves a sentence rather than a red bar.
    const row = rowFor('card', doc({ cardLast4: '9999' }));
    expect(row.verdict).toBe('DIFFERS');
    expect(row.note).toMatch(/another charge/i);
  });

  it('distinguishes "no card printed" from "a different card"', () => {
    const row = rowFor('card', doc({ cardLast4: null }));
    expect(row.verdict).toBe('NOT_ON_DOCUMENT');
    expect(row.note).toMatch(/no card number printed/i);
  });
});

describe('merchant', () => {
  it('does not call an abbreviated acquirer name a mismatch', () => {
    // "ALFANAR FUEL ST 04 RUH" versus "Alfanar Fuel Station" is the normal case, not a
    // problem, and flagging it as a difference would cry wolf on every single row.
    const row = rowFor('merchant');
    expect(row.verdict).toBe('CLOSE');
    expect(row.note).toMatch(/abbreviated/i);
  });

  it('agrees when the names are the same but for case and spacing', () => {
    const row = rowFor('merchant', doc({ merchantName: '  alfanar fuel st 04 ruh ' }));
    expect(row.verdict).toBe('AGREES');
  });

  it('says so when no name could be read', () => {
    expect(rowFor('merchant', doc({ merchantName: null })).verdict).toBe('NOT_ON_DOCUMENT');
    expect(rowFor('merchant', doc({ merchantName: '   ' })).verdict).toBe('NOT_ON_DOCUMENT');
  });
});

describe('date', () => {
  it('agrees on the same calendar day regardless of clock time', () => {
    const row = rowFor('date', doc(), charge({ transactionAt: new Date('2025-06-14T23:50:00Z') }));
    expect(row.verdict).toBe('AGREES');
  });

  it('reports the distance rather than alarming, inside the drift window', () => {
    const row = rowFor('date', doc(), charge({ transactionAt: new Date('2025-06-18T09:00:00Z') }));
    expect(row.verdict).toBe('CLOSE');
    expect(row.note).toContain('4 days apart');
  });

  it('uses the singular for a single day', () => {
    const row = rowFor('date', doc(), charge({ transactionAt: new Date('2025-06-15T09:00:00Z') }));
    expect(row.note).toContain('1 day apart');
  });

  it('counts whole calendar days, matching how the engine measures drift', () => {
    expect(
      calendarDaysApart(new Date('2025-06-14T23:59:00Z'), new Date('2025-06-15T00:01:00Z')),
    ).toBe(1);
    expect(calendarDaysApart(new Date('2025-06-14T00:01:00Z'), new Date('2025-06-14T23:59:00Z'))).toBe(0);
  });

  it('calls drift past the engine window a genuine difference', () => {
    const far = new Date(
      new Date('2025-06-14T11:02:00Z').getTime() + (MAX_DATE_DRIFT_DAYS + 2) * 86_400_000,
    );
    expect(rowFor('date', doc(), charge({ transactionAt: far })).verdict).toBe('DIFFERS');
  });
});

describe('ordering and triage', () => {
  it('leads with amount and card — the two signals that can settle it alone', () => {
    expect(buildComparison(doc(), charge()).map((r) => r.field)).toEqual([
      'amount',
      'card',
      'merchant',
      'date',
    ]);
  });

  it('surfaces only what a reviewer must actually look at', () => {
    const rows = buildComparison(doc({ cardLast4: '9999', totalAmount: null }), charge());
    const points = pointsOfDifference(rows);

    expect(points.map((r) => r.field)).toEqual(['amount', 'card']);
    // An abbreviated merchant name and a same-day date are not points of difference, and
    // listing them would bury the two rows that matter.
    expect(points.some((r) => r.field === 'merchant')).toBe(false);
  });

  it('reports nothing to look at when everything agrees', () => {
    expect(pointsOfDifference(buildComparison(doc(), charge()))).toEqual([]);
  });
});

describe('telling two tied charges apart', () => {
  it('names the only fields on which they differ', () => {
    // The ambiguous case from the brief: same chain, same amount, same day. Every signal
    // scores 1.00 for both, so showing agreement tells the reviewer nothing. What they
    // need is the short list of things that are not the same.
    const a = charge({
      merchantName: 'TAMIMI MARKETS 0007 RUH',
      amount: 4_500,
      transactionAt: new Date('2025-06-17T12:10:00Z'),
    });
    const b = charge({
      merchantName: 'TAMIMI MARKETS 0012 RUH',
      amount: 4_500,
      transactionAt: new Date('2025-06-17T12:55:00Z'),
    });

    expect(distinguishingFields(a, b)).toEqual(['merchant', 'time']);
  });

  it('returns nothing when the two charges are genuinely indistinguishable', () => {
    // This is the honest answer, and the UI depends on being able to give it: when the
    // data cannot separate two charges, the interface must say so rather than present a
    // choice that is really a coin flip on someone's money.
    expect(distinguishingFields(charge(), charge())).toEqual([]);
  });
});

describe('display primitives', () => {
  it('returns a duration, not a point in time, so callers can write the sentence', () => {
    // The queue rendered "waiting 1 year ago" because formatAge supplied its own "ago"
    // and the template supplied "waiting". A duration composes; a timestamp phrase does
    // not.
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    expect(formatAge(twoHoursAgo)).not.toMatch(/ago/);
    expect(formatAge(twoHoursAgo)).toMatch(/hour/);
  });

  it('separates the day from the clock time, in Riyadh time', () => {
    // Two charges on the same day are told apart by the time, so it has to be available
    // on its own. And it must be Riyadh time, not the server's: this is a single-country
    // product, and a reviewer compares this number against a paper receipt printed at
    // 15:55 local. Rendered in the host's zone it read 18:25 on the machine that wrote
    // this test — a time matching nothing anyone involved could see.
    const at = new Date('2025-06-17T12:55:00Z'); // 15:55 in Riyadh, UTC+3
    expect(formatDay(at)).toBe('17 Jun 2025');
    expect(formatTime(at)).toBe('15:55');
  });

  it('does not drift with the server timezone', () => {
    // The same instant must render identically wherever this runs. A charge just before
    // Riyadh midnight is the case that would silently land on the wrong day.
    const lateEvening = new Date('2025-06-17T20:30:00Z'); // 23:30 in Riyadh, same day
    expect(formatDay(lateEvening)).toBe('17 Jun 2025');
    expect(formatTime(lateEvening)).toBe('23:30');

    const justAfterMidnight = new Date('2025-06-17T21:30:00Z'); // 00:30 on the 18th
    expect(formatDay(justAfterMidnight)).toBe('18 Jun 2025');
    expect(formatTime(justAfterMidnight)).toBe('00:30');
  });

  it('degrades to a dash rather than "Invalid Date"', () => {
    for (const bad of [null, 'not-a-date']) {
      expect(formatAge(bad)).toBe('—');
      expect(formatDay(bad)).toBe('—');
      expect(formatTime(bad)).toBe('—');
    }
  });
});

describe('describing what separates two charges', () => {
  const charge = (over: Partial<ComparableCharge> = {}): ComparableCharge => ({
    merchantName: 'TAMIMI MARKETS 0007 RUH',
    amount: 4_500,
    currency: 'SAR',
    transactionAt: new Date('2025-06-17T12:10:00Z'),
    cardLast4: '4412',
    ...over,
  });

  it('calls two outlets of one chain a difference of branch', () => {
    const difference = (chargeDifferences(
      charge(),
      charge({ merchantName: 'TAMIMI MARKETS 0012 RUH' }),
      merchantSimilarity,
    ))[0]!;
    expect(difference.phrase).toBe('the branch');
  });

  it('calls two unrelated shops a difference of merchant', () => {
    // The bug this replaces: the phrase was looked up by field name, so `merchant` always
    // rendered as "the branch". A reviewer told that Panda and Nahdi "differ only in the
    // branch" has been actively misled on the one screen that exists to prevent a wrong
    // attachment.
    const difference = (chargeDifferences(
      charge({ merchantName: 'PANDA HYPERMARKET BR 220' }),
      charge({ merchantName: 'NAHDI PHARMACY 118' }),
      merchantSimilarity,
    ))[0]!;
    expect(difference.phrase).toBe('the merchant');
  });

  it('separates a difference of clock time from a difference of day', () => {
    // Two charges forty minutes apart and two charges three days apart are resolved by
    // completely different evidence, so they do not get the same sentence.
    const sameDay = chargeDifferences(
      charge(),
      charge({ transactionAt: new Date('2025-06-17T12:55:00Z') }),
      merchantSimilarity,
    );
    expect(sameDay[0]!.phrase).toBe('the time of day');

    const otherDay = chargeDifferences(
      charge(),
      charge({ transactionAt: new Date('2025-06-20T12:10:00Z') }),
      merchantSimilarity,
    );
    expect(otherDay[0]!.phrase).toBe('the date');
  });

  it('carries both values so the reader can see them, not just the field name', () => {
    const difference = (chargeDifferences(
      charge(),
      charge({ amount: 6_325 }),
      merchantSimilarity,
    ))[0]!;
    expect(difference.left).toBe('45.00 SAR');
    expect(difference.right).toBe('63.25 SAR');
  });

  it('returns nothing when the two charges are genuinely indistinguishable', () => {
    expect(chargeDifferences(charge(), charge(), merchantSimilarity)).toEqual([]);
  });

  it('reports every difference when several apply', () => {
    const differences = chargeDifferences(
      charge(),
      charge({ merchantName: 'NAHDI PHARMACY 118', amount: 9_000, cardLast4: '8899' }),
      merchantSimilarity,
    );
    expect(differences.map((d) => d.field)).toEqual(['merchant', 'amount', 'card']);
  });
});

describe('a currency mismatch is a difference, not an agreement', () => {
  it('does not report two different currencies as agreeing', () => {
    // The amount row compared the integers and never the currency, so a 100.00 USD
    // receipt against a 100.00 SAR charge rendered both values side by side under a
    // green "agrees" verdict — on the one screen whose job is to stop a wrong
    // attachment. At roughly 3.75 SAR to the dollar these are not the same payment.
    const rows = buildComparison(
      doc({ totalAmount: 10_000, currency: 'USD' }),
      charge({ amount: 10_000, currency: 'SAR' }),
    );
    const amount = rows.find((row) => row.field === 'amount');

    expect(amount?.verdict).toBe('DIFFERS');
    expect(amount?.note).toBeTruthy();
  });

  it('still agrees when the currencies match', () => {
    const rows = buildComparison(
      doc({ totalAmount: 10_000, currency: 'SAR' }),
      charge({ amount: 10_000, currency: 'SAR' }),
    );

    expect(rows.find((row) => row.field === 'amount')?.verdict).toBe('AGREES');
  });
});

describe('the review screen uses the same date window as the engine', () => {
  /**
   * `buildComparison` explains the matcher's decision to a reviewer. When it judges a
   * date by a different rule than the engine used, it contradicts the thing it is there
   * to explain — and it did: a flat seven-day constant marked an ordinary twenty-day-old
   * supplier invoice as DIFFERS on a pairing the engine scored as plausible. Emailed
   * invoices are the common case for this product.
   */
  const twentyDaysApart = {
    doc: { documentDate: new Date('2025-06-10T00:00:00Z') },
    charge: { transactionAt: new Date('2025-06-30T10:00:00Z') },
  };

  const dateVerdict = (documentType: string, source: string) =>
    buildComparison(
      doc({ ...twentyDaysApart.doc, documentType, source }),
      charge(twentyDaysApart.charge),
    ).find((row) => row.field === 'date')?.verdict;

  it('treats a twenty-day-old tax invoice as close, matching the 45-day invoice window', () => {
    expect(dateVerdict('TAX_INVOICE', 'EMAIL')).toBe('CLOSE');
  });

  it('still calls a twenty-day-old till receipt different, matching the 7-day window', () => {
    expect(dateVerdict('RECEIPT', 'WHATSAPP')).toBe('DIFFERS');
  });

  it('compares currency case-insensitively, as the matcher does', () => {
    // The matcher normalises both sides before comparing; comparing raw strings made the
    // reviewer's view veto a pairing the engine would happily auto-attach.
    const row = buildComparison(
      doc({ currency: 'sar', totalAmount: 12_500 }),
      charge({ currency: 'SAR', amount: 12_500 }),
    ).find((r) => r.field === 'amount');

    expect(row?.verdict).toBe('AGREES');
  });
});
