/**
 * Where a charge stands on documentation.
 *
 * This function is the definition of truth. A charge is documented when
 * `confirmedDocumentId` points at a document — the same column the compare-and-set slot
 * claim writes under a unique constraint — and the rest follows from the candidate
 * matches. One pure function, no I/O, total over its inputs.
 *
 * **`Transaction.documentationStatus` now caches it, and this comment used to argue it
 * never should.** The argument was right about the danger and right about the remedy:
 * derivation cannot be filtered or counted in SQL, so the register had to load every
 * charge *and its matches* into Node to tally four numbers, and the stated condition for
 * materialising it was "a maintained column with a reconciliation job — not a column
 * written by hand from four call sites, which is how the drift starts."
 *
 * That condition is met, and it is worth being specific about how, because the warning
 * stands for anyone tempted to write to the column directly:
 *
 *  - `recomputeDocumentationStatus` is the only writer, and it calls *this* function
 *    rather than restating the rule. There is no second copy of the logic to drift.
 *  - Every write path that can change the inputs goes through it, inside the same
 *    database transaction as the change itself.
 *  - `expectStatusesConsistent` re-derives every charge in the database and runs after
 *    *every* test in the suite, not in one dedicated test — so a future write path that
 *    forgets to recompute fails somebody else's test rather than shipping.
 *
 * The reconciliation job the comment asked for is `scripts/backfill-status.ts`.
 */

import { ageLabel, chargeStatusHint, chargeStatusLabel } from '@/lib/content/messages';

export type TransactionDocumentationStatus =
  /** A document is attached. Nothing to do. */
  | 'DOCUMENTED'
  /** A document is proposed and a person has to decide. Work for the review queue. */
  | 'IN_REVIEW'
  /** A document was proposed and rejected. Someone looked and said no. */
  | 'REJECTED'
  /** Nothing has ever been proposed for this charge. Work for whoever chases drivers. */
  | 'MISSING';

export interface StatusPresentation {
  label: string;
  /** One line a finance person can act on. */
  hint: string;
  /** Drives the badge palette; colour is never the only channel. */
  tone: 'settled' | 'attention' | 'waiting' | 'neutral';
}

/**
 * Tone per status; the words come from the content layer.
 *
 * Only the colour role is a code decision — the label and the hint are copy, and copy has
 * one home so it can be reviewed, overridden by a host and translated.
 */
const STATUS_TONE: Readonly<Record<TransactionDocumentationStatus, StatusPresentation['tone']>> = {
  DOCUMENTED: 'settled',
  IN_REVIEW: 'attention',
  REJECTED: 'attention',
  MISSING: 'waiting',
};

export function presentChargeStatus(
  status: TransactionDocumentationStatus,
): StatusPresentation {
  return {
    label: chargeStatusLabel(status),
    hint: chargeStatusHint(status),
    tone: STATUS_TONE[status],
  };
}

/** Kept as a lookup for call sites that read it like a table. */
export const TRANSACTION_STATUS: Readonly<
  Record<TransactionDocumentationStatus, StatusPresentation>
> = {
  get DOCUMENTED() { return presentChargeStatus('DOCUMENTED'); },
  get IN_REVIEW() { return presentChargeStatus('IN_REVIEW'); },
  get REJECTED() { return presentChargeStatus('REJECTED'); },
  get MISSING() { return presentChargeStatus('MISSING'); },
};

export interface StatusInput {
  confirmedDocumentId: number | null;
  /** The match rows pointing at this charge. Only `status` is read. */
  matches: readonly { status: string }[];
}

/**
 * The order matters and encodes a precedence.
 *
 * `DOCUMENTED` wins outright because the slot claim is the authority — a charge with a
 * confirmed document is settled regardless of what other candidates say about it.
 * `IN_REVIEW` then outranks `REJECTED` because a live candidate is work in hand, while a
 * rejection is only history; a charge with one rejected receipt and one still waiting is
 * on somebody's desk, not finished.
 */
export function documentationStatusOf(input: StatusInput): TransactionDocumentationStatus {
  if (input.confirmedDocumentId !== null) return 'DOCUMENTED';

  const hasLiveCandidate = input.matches.some((m) => m.status === 'CANDIDATE');
  if (hasLiveCandidate) return 'IN_REVIEW';

  const hasRejection = input.matches.some((m) => m.status === 'REJECTED');
  if (hasRejection) return 'REJECTED';

  return 'MISSING';
}

/**
 * Statuses that represent an undocumented charge, for coverage arithmetic.
 *
 * Expressed as a set rather than `!== 'DOCUMENTED'` so that adding a future status forces
 * a decision about which side of the line it falls on. A new state that silently counts as
 * covered would overstate the compliance position, which is the one number nobody should
 * find out is optimistic during an audit.
 */
export const UNDOCUMENTED_STATUSES: readonly TransactionDocumentationStatus[] = [
  'IN_REVIEW',
  'REJECTED',
  'MISSING',
];

export function isUndocumented(status: TransactionDocumentationStatus): boolean {
  return UNDOCUMENTED_STATUSES.includes(status);
}

/**
 * How long a charge has gone undocumented, in whole days.
 *
 * Ageing is what turns a list into a worklist: a charge from three days ago is noise, the
 * same charge five weeks before a filing is an exception. Takes `now` as an argument so
 * the function stays pure and the tests do not depend on the clock.
 */
export function daysUndocumented(transactionAt: Date, now: Date): number {
  const MS_PER_DAY = 86_400_000;
  const days = Math.floor((now.getTime() - transactionAt.getTime()) / MS_PER_DAY);
  return days > 0 ? days : 0;
}

/**
 * Ageing buckets, in the language a finance team uses on a debtors report.
 *
 * The thresholds are deliberately the familiar ones rather than anything derived from this
 * product: a controller reading "31-60 days" already knows what it means and roughly how
 * worried to be, and inventing bespoke bands would cost them that.
 */
export type AgeBucket = '0-7' | '8-30' | '31-60' | '60+';

export function ageBucket(days: number): AgeBucket {
  if (days <= 7) return '0-7';
  if (days <= 30) return '8-30';
  if (days <= 60) return '31-60';
  return '60+';
}

export const AGE_BUCKET_LABEL: Readonly<Record<AgeBucket, string>> = {
  get '0-7'() { return ageLabel('0-7'); },
  get '8-30'() { return ageLabel('8-30'); },
  get '31-60'() { return ageLabel('31-60'); },
  get '60+'() { return ageLabel('60+'); },
};

/**
 * The date ageing is measured against, given the period under review.
 *
 * For a period still open that is today. For one already closed it is the period's last
 * day, because the question about a finished month is how long each charge went
 * undocumented *within it* — not how many months have elapsed since. Measuring a June
 * period against today puts every charge in the oldest bucket and the ageing stops saying
 * anything.
 *
 * Lives here rather than on either screen so the overview and the register cannot report
 * different ages for the same charge.
 */
export function ageingReference(periodEnd: Date | null, now: Date): Date {
  if (periodEnd === null) return now;
  return periodEnd < now ? periodEnd : now;
}

/**
 * The `transactionAt` range that produces a given age bucket, as of a reference date.
 *
 * Age is a function of *now*, so it can never be stored — but it is a monotonic function
 * of `transactionAt`, which means filtering by it is a range query on a column that is
 * already indexed. This is what lets the register ask the database for "charges between
 * one and four weeks old" instead of loading every charge to compute each one's age in
 * JavaScript and then discarding most of them.
 *
 * Returned as a Prisma-shaped filter so the inversion of the comparison — older charges
 * have *smaller* timestamps — lives here once rather than at each call site, where
 * getting it backwards would silently return the wrong half of the register.
 */
export function ageBucketRange(bucket: AgeBucket, asOf: Date): { gt?: Date; lte?: Date } {
  const MS_PER_DAY = 86_400_000;
  const at = (days: number) => new Date(asOf.getTime() - days * MS_PER_DAY);

  // `daysUndocumented` *floors* the elapsed days, so age <= 7 means the gap is strictly
  // less than eight days — the lower edge is exclusive, not inclusive. Getting that
  // backwards moves every charge sitting exactly on a day boundary into the neighbouring
  // bucket, which is both wrong and almost invisible. `age-range.test.ts` checks the two
  // definitions against each other either side of every boundary for this reason.
  //
  // The newest bucket has no upper bound: the day count clamps negatives to zero, so a
  // charge posted ahead of the reference date is age 0, and bounding at `asOf` would drop
  // it from the register entirely.
  switch (bucket) {
    case '0-7':
      return { gt: at(8) };
    case '8-30':
      return { gt: at(31), lte: at(8) };
    case '31-60':
      return { gt: at(61), lte: at(31) };
    case '60+':
      return { lte: at(61) };
  }
}
