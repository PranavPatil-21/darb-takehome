/**
 * Where a charge stands on documentation.
 *
 * `Transaction` has no status column, and deliberately still does not get one. The truth
 * is already in the data — a charge is documented when `confirmedDocumentId` points at a
 * document, and that column is the same one the compare-and-set slot claim writes under a
 * unique constraint. A denormalised status column would be a second copy of that fact,
 * maintained by application code, free to drift from it; and the moment the two disagree,
 * the UI confidently shows a figure that is wrong. So the status is derived, here, in one
 * pure function.
 *
 * Derivation has a cost: it needs the candidate matches loaded alongside the charge, and
 * it cannot be filtered on in SQL without a join. At the scale where that hurts, the right
 * answer is a materialised view or a maintained column with a reconciliation job — not a
 * column written by hand from four call sites, which is how the drift starts.
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
