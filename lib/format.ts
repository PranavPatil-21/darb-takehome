/**
 * Presentation helpers. Money lives in minor units everywhere in this codebase; this is
 * the only place it becomes a human-readable string.
 */

export function formatMinorUnits(amount: number | null, currency = 'SAR'): string {
  if (amount === null) return '—';
  return `${(amount / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ${currency}`;
}

export function formatDate(value: Date | string | null): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';
  return date.toISOString().slice(0, 16).replace('T', ' ') + 'Z';
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
