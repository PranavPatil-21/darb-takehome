import { formatDistanceToNowStrict, isValid } from 'date-fns';

/**
 * Presentation helpers. Money lives in minor units everywhere in this codebase; this is
 * the only place it becomes a human-readable string.
 *
 * Every date and time is rendered in **Riyadh time**, explicitly, rather than in whatever
 * zone the server happens to run in. This is a single-country product: a charge stamped
 * 12:10 UTC happened at 15:10 to the fleet operator reading about it, and it must say so
 * whether the container is in Frankfurt or the laptop is in Mumbai. Leaving it implicit
 * meant the queue displayed 17:40 for that charge on this machine — a number matching
 * nothing on the receipt, on the statement, or on the clock of anyone involved.
 *
 * The clock time is not decoration here: when two charges fall on the same day at the
 * same merchant for the same amount, the time is the only thing distinguishing them, and
 * a reviewer will compare it against a paper receipt.
 */

const RIYADH = 'Asia/Riyadh';

function toDate(value: Date | string | null): Date | null {
  if (!value) return null;
  const date = typeof value === 'string' ? new Date(value) : value;
  return isValid(date) ? date : null;
}

export function formatMinorUnits(amount: number | null, currency = 'SAR'): string {
  if (amount === null) return '—';
  return `${(amount / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ${currency}`;
}

/**
 * How long something has been waiting, as a duration rather than a point in time.
 *
 * Returns "3 hours", not "3 hours ago": the caller's sentence supplies the preposition.
 * The previous form returned the "ago" itself and the review queue rendered
 * "waiting 1 year ago", which is both ungrammatical and, with fixture data dated in the
 * past, the only thing on the card that drew the eye.
 */
export function formatAge(value: Date | string | null): string {
  const date = toDate(value);
  if (!date) return '—';
  return formatDistanceToNowStrict(date);
}

/** Date only, in Riyadh time, for places where the clock time is noise. */
export function formatDay(value: Date | string | null): string {
  const date = toDate(value);
  if (!date) return '—';
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: RIYADH,
  });
}

/** Clock time in Riyadh — the differentiator when two charges share a day. */
export function formatTime(value: Date | string | null): string {
  const date = toDate(value);
  if (!date) return '—';
  return date.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: RIYADH,
  });
}

export function formatPercent(value: number | null): string {
  if (value === null || Number.isNaN(value)) return '—';
  return `${Math.round(value * 100)}%`;
}

/** Human sentence for each matcher reason code, shown as the headline in the queue. */
export const REASON_COPY: Readonly<Record<string, string>> = {
  AMBIGUOUS_TOP_CANDIDATES:
    'Two transactions score almost identically — there is no evidence favouring either.',
  TRANSACTION_ALREADY_DOCUMENTED:
    'The best-matching transaction already has a confirmed document. Possible duplicate receipt.',
  LOW_EXTRACTION_CONFIDENCE:
    'The signals agree, but the OCR distrusted its own read of this document.',
  WEAK_EVIDENCE:
    'No amount and no card number could be read — merchant and date alone cannot attach money.',
  MID_CONFIDENCE: 'Plausible but short of the auto-match threshold.',
  NO_PLAUSIBLE_CANDIDATE: 'No transaction in scope came close enough to be worth reviewing.',
  NO_CANDIDATE_TRANSACTIONS: 'No transactions exist in this document’s scope and date window.',
  UNUSABLE_EXTRACTION: 'OCR returned nothing usable — no amount, no card, no merchant.',
  ALL_CANDIDATES_REJECTED: 'Every candidate was rejected by a reviewer.',
  CONFIDENT_SINGLE_CANDIDATE: 'One clear winner, well clear of the runner-up.',
};

export const SIGNAL_COPY: Readonly<Record<string, string>> = {
  amount: 'Amount',
  cardLast4: 'Card ••••',
  merchant: 'Merchant',
  date: 'Date',
};

/**
 * What the reader should actually do, paired with each reason.
 *
 * `REASON_COPY` explains why the matcher stopped; on its own that leaves a reviewer
 * correctly informed and still stuck. These are the next move — and in two cases the
 * honest next move is "do not decide this from the screen", which an interface is
 * reluctant to say and which is exactly when it matters most.
 */
export const NEXT_STEP_COPY: Readonly<Record<string, string>> = {
  AMBIGUOUS_TOP_CANDIDATES:
    'Check the paper receipt for the branch or the time, or ask the driver which purchase this was.',
  TRANSACTION_ALREADY_DOCUMENTED:
    'Compare this against the receipt already attached. Only one of them belongs to that charge.',
  LOW_EXTRACTION_CONFIDENCE:
    'Read the amount and card number off the receipt below and check they match the charge.',
  WEAK_EVIDENCE:
    'The receipt shows no total and no card number. Confirm only if you can tell from the receipt itself which charge this is.',
  MID_CONFIDENCE: 'Check the difference flagged below, then attach it or reject it.',
};
