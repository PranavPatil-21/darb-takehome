import { chargeDifferencesAcross, type ComparableCharge } from '@/lib/ui/comparison';
import { merchantSimilarity } from '@/lib/matching/merchant';

/**
 * Comparing more than two candidates.
 *
 * The callout was written against exactly two charges — `const [a, b] = charges` — so a
 * third tied candidate was silently dropped from a screen whose entire purpose is to show
 * the reviewer everything that is competing. Three-way ties are not exotic: a chain with
 * several outlets in one district produces them routinely.
 */

const BASE = new Date('2025-06-17T15:10:00Z');

const charge = (over: Partial<ComparableCharge> = {}): ComparableCharge => ({
  merchantName: 'TAMIMI MARKETS 0007 RUH',
  amount: 4500,
  currency: 'SAR',
  cardLast4: '4412',
  transactionAt: BASE,
  ...over,
});

describe('differences across N charges', () => {
  test('still works for the two-charge case', () => {
    const differences = chargeDifferencesAcross(
      [charge(), charge({ merchantName: 'TAMIMI MARKETS 0012 RUH' })],
      merchantSimilarity,
    );

    expect(differences.map((d) => d.phrase)).toEqual(['the branch']);
  });

  test('reports a field that differs in only one of three charges', () => {
    const differences = chargeDifferencesAcross(
      [
        charge(),
        charge(),
        charge({ cardLast4: '8899' }),
      ],
      merchantSimilarity,
    );

    expect(differences.map((d) => d.field)).toContain('card');
  });

  test('lists every distinct value, not just the first pair', () => {
    const differences = chargeDifferencesAcross(
      [
        charge({ merchantName: 'TAMIMI MARKETS 0007 RUH' }),
        charge({ merchantName: 'TAMIMI MARKETS 0012 RUH' }),
        charge({ merchantName: 'TAMIMI MARKETS 0003 RUH' }),
      ],
      merchantSimilarity,
    );

    const merchant = differences.find((d) => d.field === 'merchant');
    expect(merchant?.values).toHaveLength(3);
  });

  test('says nothing when all three are genuinely identical', () => {
    const differences = chargeDifferencesAcross(
      [charge(), charge(), charge()],
      merchantSimilarity,
    );

    expect(differences).toEqual([]);
  });

  test('calls outlets of one chain a branch difference, unrelated shops a merchant one', () => {
    const chain = chargeDifferencesAcross(
      [charge(), charge({ merchantName: 'TAMIMI MARKETS 0012 RUH' })],
      merchantSimilarity,
    );
    const unrelated = chargeDifferencesAcross(
      [charge(), charge({ merchantName: 'JARIR BOOKSTORE RUH' })],
      merchantSimilarity,
    );

    expect(chain[0]?.phrase).toBe('the branch');
    expect(unrelated[0]?.phrase).toBe('the merchant');
  });

  test('a chain difference survives a third outlet joining the tie', () => {
    const differences = chargeDifferencesAcross(
      [
        charge(),
        charge({ merchantName: 'TAMIMI MARKETS 0012 RUH' }),
        charge({ merchantName: 'TAMIMI MARKETS 0003 RUH' }),
      ],
      merchantSimilarity,
    );

    expect(differences.find((d) => d.field === 'merchant')?.phrase).toBe('the branch');
  });

  test('fewer than two charges have nothing to compare', () => {
    expect(chargeDifferencesAcross([charge()], merchantSimilarity)).toEqual([]);
    expect(chargeDifferencesAcross([], merchantSimilarity)).toEqual([]);
  });

  test('distinguishes same-day minutes apart from different days', () => {
    const sameDay = chargeDifferencesAcross(
      [charge(), charge({ transactionAt: new Date('2025-06-17T15:55:00Z') })],
      merchantSimilarity,
    );
    const otherDay = chargeDifferencesAcross(
      [charge(), charge({ transactionAt: new Date('2025-06-19T15:10:00Z') })],
      merchantSimilarity,
    );

    expect(sameDay[0]?.phrase).toBe('the time of day');
    expect(otherDay[0]?.phrase).toBe('the date');
  });
});
