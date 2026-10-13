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

/**
 * Re-exported from the content layer so existing call sites keep working.
 *
 * The sentences themselves live in `lib/content/messages.ts` — one place to review the
 * wording, one mechanism to override or translate it. These wrappers exist only so a
 * caller asking for "the copy for this reason code" does not need to know the key shape.
 */
export { reasonText as reasonCopy, nextStepText as nextStepCopy, signalLabel } from '@/lib/content/messages';
