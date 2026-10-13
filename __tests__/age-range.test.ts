import {
  ageBucket,
  ageBucketRange,
  daysUndocumented,
  type AgeBucket,
} from '@/lib/platform/transaction-status';

/**
 * The SQL range and the JavaScript bucket must agree exactly.
 *
 * `ageBucketRange` exists so the register can filter by age in an indexed query instead of
 * computing every charge's age in Node. That is only safe if the range selects precisely
 * the charges `ageBucket` would have selected — and the boundaries are where it would go
 * wrong, because `daysUndocumented` floors the day count, so "7 days old" and "7 days and
 * one second old" are the same bucket while being different timestamps.
 *
 * Rather than assert a handful of hand-picked cases, this checks the two definitions
 * against each other across every day boundary and either side of it.
 */

const MS_PER_DAY = 86_400_000;
const AS_OF = new Date('2025-07-01T12:00:00Z');
const BUCKETS: AgeBucket[] = ['0-7', '8-30', '31-60', '60+'];

/** Does this timestamp fall inside the Prisma-shaped range? */
function withinRange(at: Date, range: { gt?: Date; gte?: Date; lte?: Date }): boolean {
  if (range.gt && !(at > range.gt)) return false;
  if (range.gte && !(at >= range.gte)) return false;
  if (range.lte && !(at <= range.lte)) return false;
  return true;
}

describe('age ranges select exactly what the bucket function would', () => {
  // Every whole day from 0 to 90, plus a second either side of each boundary.
  const offsets: number[] = [];
  for (let day = 0; day <= 90; day += 1) {
    offsets.push(day * MS_PER_DAY, day * MS_PER_DAY + 1000, day * MS_PER_DAY - 1000);
  }

  test.each(BUCKETS)('%s', (bucket) => {
    const range = ageBucketRange(bucket, AS_OF);

    for (const offset of offsets) {
      if (offset < 0) continue;
      const at = new Date(AS_OF.getTime() - offset);
      const expected = ageBucket(daysUndocumented(at, AS_OF)) === bucket;

      expect({ offset, inRange: withinRange(at, range) }).toEqual({
        offset,
        inRange: expected,
      });
    }
  });

  test('every charge lands in exactly one bucket range', () => {
    for (const offset of offsets) {
      if (offset < 0) continue;
      const at = new Date(AS_OF.getTime() - offset);
      const hits = BUCKETS.filter((bucket) => withinRange(at, ageBucketRange(bucket, AS_OF)));
      expect({ offset, hits: hits.length }).toEqual({ offset, hits: 1 });
    }
  });

  test('a future-dated charge is treated as new, as the day count already does', () => {
    // `daysUndocumented` clamps negatives to zero, so a charge posted ahead of the
    // reference is age 0 — the range must not silently drop it.
    const future = new Date(AS_OF.getTime() + 2 * MS_PER_DAY);
    expect(ageBucket(daysUndocumented(future, AS_OF))).toBe('0-7');
    expect(withinRange(future, ageBucketRange('0-7', AS_OF))).toBe(true);
  });
});
