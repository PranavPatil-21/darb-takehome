import {
  ageBucket,
  daysUndocumented,
  documentationStatusOf,
  isUndocumented,
  TRANSACTION_STATUS,
  UNDOCUMENTED_STATUSES,
  type TransactionDocumentationStatus,
} from '@/lib/platform/transaction-status';

/**
 * Where a charge stands on documentation.
 *
 * Derived rather than stored, which means this function is the single definition of a
 * number the operator will quote to their accountant. A precedence bug here does not
 * crash anything — it silently moves charges between "settled" and "needs work", which is
 * the failure that gets discovered during an audit rather than in testing.
 */

const input = (
  confirmedDocumentId: number | null,
  ...statuses: string[]
) => ({ confirmedDocumentId, matches: statuses.map((status) => ({ status })) });

describe('documentation status', () => {
  it('is DOCUMENTED when a document holds the slot', () => {
    expect(documentationStatusOf(input(7))).toBe('DOCUMENTED');
  });

  it('is MISSING when nothing was ever proposed', () => {
    expect(documentationStatusOf(input(null))).toBe('MISSING');
  });

  it('is IN_REVIEW while a candidate is live', () => {
    expect(documentationStatusOf(input(null, 'CANDIDATE'))).toBe('IN_REVIEW');
  });

  it('is REJECTED when every proposal was turned down', () => {
    expect(documentationStatusOf(input(null, 'REJECTED', 'REJECTED'))).toBe('REJECTED');
  });

  it('lets the slot claim win over anything the candidates say', () => {
    // The confirmed-document column is written under a unique constraint by the
    // compare-and-set; it is the authority. A stray CANDIDATE row alongside it must not
    // drag a settled charge back into the queue.
    expect(documentationStatusOf(input(7, 'CANDIDATE', 'REJECTED'))).toBe('DOCUMENTED');
  });

  it('ranks work in hand above history', () => {
    // One receipt was rejected and another is still waiting: this charge is on somebody's
    // desk, not finished with. Reporting it as REJECTED would drop it out of the queue
    // view a reviewer works from.
    expect(documentationStatusOf(input(null, 'REJECTED', 'CANDIDATE'))).toBe('IN_REVIEW');
  });

  it('treats an auto-confirmed match with no slot as still in review', () => {
    // This combination means a confirm lost the compare-and-set race — the match row was
    // written but the slot went to another document. Calling it DOCUMENTED here would
    // claim coverage the data does not support.
    expect(documentationStatusOf(input(null, 'AUTO_CONFIRMED'))).toBe('MISSING');
  });
});

describe('coverage arithmetic', () => {
  it('counts every non-documented status as undocumented', () => {
    expect(UNDOCUMENTED_STATUSES).toEqual(['IN_REVIEW', 'REJECTED', 'MISSING']);
    expect(isUndocumented('DOCUMENTED')).toBe(false);
  });

  it('accounts for every status exactly once', () => {
    // A new status that nobody classified would silently count as covered and overstate
    // the compliance position — the one number that must never turn out optimistic.
    const all = Object.keys(TRANSACTION_STATUS) as TransactionDocumentationStatus[];
    const classified = all.filter((s) => isUndocumented(s) || s === 'DOCUMENTED');

    expect(classified).toHaveLength(all.length);
  });

  it('gives every status a label and an actionable hint', () => {
    for (const presentation of Object.values(TRANSACTION_STATUS)) {
      expect(presentation.label.length).toBeGreaterThan(0);
      expect(presentation.hint.length).toBeGreaterThan(0);
    }
  });
});

describe('ageing', () => {
  const now = new Date('2025-07-15T00:00:00Z');

  it('counts whole days since the charge', () => {
    expect(daysUndocumented(new Date('2025-07-14T00:00:00Z'), now)).toBe(1);
    expect(daysUndocumented(new Date('2025-06-15T00:00:00Z'), now)).toBe(30);
  });

  it('never reports a negative age for a charge dated in the future', () => {
    // Acquirer clock skew and post-dated test data both produce this; "-3 days old" in a
    // worklist reads as a bug in the product rather than in the feed.
    expect(daysUndocumented(new Date('2025-07-20T00:00:00Z'), now)).toBe(0);
  });

  it('uses the ageing bands a finance team already reads', () => {
    expect(ageBucket(0)).toBe('0-7');
    expect(ageBucket(7)).toBe('0-7');
    expect(ageBucket(8)).toBe('8-30');
    expect(ageBucket(30)).toBe('8-30');
    expect(ageBucket(31)).toBe('31-60');
    expect(ageBucket(60)).toBe('31-60');
    expect(ageBucket(61)).toBe('60+');
  });
});
