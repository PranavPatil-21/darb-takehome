import { t } from '@/lib/content/messages';
import { VAT_ROUNDING_TOLERANCE_HALALAS } from '@/lib/matching/scoring-config';
import { maxDateDriftDaysFor } from '@/lib/services/transaction-matcher';

/**
 * The document-versus-charge comparison a reviewer actually makes.
 *
 * The matcher produces four numbers. A number is a summary of a comparison, not the
 * comparison itself, and a reviewer confirming that money belongs to a receipt needs the
 * comparison: *this* amount against *that* amount, and whether they agree. Today the two
 * sides are rendered as separate prose lines and the reader performs the diff in their
 * head — on the one screen where the cost of a mistake is a receipt attached to the wrong
 * charge.
 *
 * This module is pure and has no opinion about presentation: it pairs the fields and
 * states the verdict. It deliberately does not re-score anything — `signals` on the match
 * row remains the authority on confidence, and these rows explain *why* that number came
 * out as it did rather than recomputing it. Keeping the two separate is what stops the UI
 * quietly disagreeing with the engine.
 */

/** Which side of the comparison a value came from, when only one side has it. */
export type ComparisonVerdict =
  /** Both sides present and equivalent for matching purposes. */
  | 'AGREES'
  /** Both present, not equal, but within the tolerance the engine allows. */
  | 'CLOSE'
  /** Both present and materially different — the thing a reviewer must look at. */
  | 'DIFFERS'
  /** The document did not carry this field, so there is nothing to compare. */
  | 'NOT_ON_DOCUMENT';

export interface ComparisonRow {
  field: 'amount' | 'date' | 'card' | 'merchant';
  label: string;
  /** Pre-formatted for display; `null` means the document carried nothing. */
  documentValue: string | null;
  chargeValue: string;
  verdict: ComparisonVerdict;
  /** A plain sentence shown only when it adds something a reader cannot see themselves. */
  note: string | null;
}

export interface ComparableDocument {
  merchantName: string | null;
  totalAmount: number | null;
  currency: string | null;
  documentDate: Date | null;
  cardLast4: string | null;
  /**
   * What the document is, and how it arrived. Both optional, and both only used to ask
   * the engine which date window applies — a supplier invoice is allowed to lag the
   * charge by far longer than a till receipt. Without them this screen judged every
   * document by the receipt window and told the reviewer a perfectly ordinary 20-day-old
   * invoice "differs", on a pairing the engine considered fully inside tolerance.
   */
  documentType?: string | null;
  source?: string | null;
}

export interface ComparableCharge {
  merchantName: string;
  amount: number;
  currency: string;
  transactionAt: Date;
  cardLast4: string;
}

const MS_PER_DAY = 86_400_000;

function money(amount: number, currency: string): string {
  return `${(amount / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ${currency}`;
}

/** Whole calendar days between two instants, matching how the engine counts drift. */
export function calendarDaysApart(a: Date, b: Date): number {
  const dayOf = (d: Date) => Math.floor(d.getTime() / MS_PER_DAY);
  return Math.abs(dayOf(a) - dayOf(b));
}

function compareAmount(doc: ComparableDocument, charge: ComparableCharge): ComparisonRow {
  const label = 'Amount';
  const chargeValue = money(charge.amount, charge.currency);

  if (doc.totalAmount === null) {
    return {
      field: 'amount',
      label,
      documentValue: null,
      chargeValue,
      verdict: 'NOT_ON_DOCUMENT',
      note: t('compare.note.noAmount'),
    };
  }

  const documentValue = money(doc.totalAmount, doc.currency ?? charge.currency);

  // Currency before magnitude. Comparing the integers alone reported a 100.00 USD receipt
  // as agreeing with a 100.00 SAR charge — the two values rendered side by side under a
  // green verdict, on the screen whose entire job is to stop a wrong attachment. The
  // matcher already vetoes this pairing; the reviewer's own view must not contradict it.
  // Normalised on both sides, exactly as the matcher does. Comparing raw strings made
  // `'sar'` differ from `'SAR'`, so the reviewer's view vetoed a pairing the engine was
  // happy to auto-attach — the contradiction this gate exists to prevent, inverted.
  const documentCurrency = doc.currency?.trim().toUpperCase() ?? null;
  const chargeCurrency = charge.currency.trim().toUpperCase();
  if (documentCurrency !== null && documentCurrency !== chargeCurrency) {
    return {
      field: 'amount',
      label,
      documentValue,
      chargeValue,
      verdict: 'DIFFERS',
      note: t('compare.note.currencyMismatch'),
    };
  }

  const difference = charge.amount - doc.totalAmount;

  if (difference === 0) {
    return { field: 'amount', label, documentValue, chargeValue, verdict: 'AGREES', note: null };
  }

  // Inside the VAT-rounding band the difference carries no information, so saying
  // "differs" would send a reviewer looking for a discrepancy that is pure arithmetic.
  if (Math.abs(difference) <= VAT_ROUNDING_TOLERANCE_HALALAS) {
    return {
      field: 'amount',
      label,
      documentValue,
      chargeValue,
      verdict: 'CLOSE',
      note: t('compare.note.rounding'),
    };
  }

  // The direction matters more than the size. A card charged *more* than the receipt is
  // an everyday tip or service charge; charged *less* is not something a reviewer should
  // wave through.
  const note =
    difference > 0
      ? `Charged ${money(difference, charge.currency)} more than the receipt — a tip or service charge would explain this.`
      : `Charged ${money(-difference, charge.currency)} less than the receipt. A tip cannot explain this.`;

  return { field: 'amount', label, documentValue, chargeValue, verdict: 'DIFFERS', note };
}

function compareDate(doc: ComparableDocument, charge: ComparableCharge): ComparisonRow {
  const label = 'Date';
  const chargeValue = charge.transactionAt.toISOString();

  if (doc.documentDate === null) {
    return {
      field: 'date',
      label,
      documentValue: null,
      chargeValue,
      verdict: 'NOT_ON_DOCUMENT',
      note: t('compare.note.noDate'),
    };
  }

  const days = calendarDaysApart(doc.documentDate, charge.transactionAt);

  if (days === 0) {
    return {
      field: 'date',
      label,
      documentValue: doc.documentDate.toISOString(),
      chargeValue,
      verdict: 'AGREES',
      note: null,
    };
  }

  // A receipt dated before the charge settles is routine; the engine treats the whole
  // window as plausible, so the reviewer is told the distance rather than alarmed by it.
  const plural = days === 1 ? 'day' : 'days';
  return {
    field: 'date',
    label,
    documentValue: doc.documentDate.toISOString(),
    chargeValue,
    // The engine's own window for *this* document, not a flat constant. Keeping the two
    // separate is what stops the UI quietly disagreeing with the matcher it explains.
    verdict: days <= driftWindowFor(doc) ? 'CLOSE' : 'DIFFERS',
    note: `${days} ${plural} apart. Card settlement routinely lags the receipt.`,
  };
}

/** The engine's date window for this document, defaulting to the receipt window. */
function driftWindowFor(doc: ComparableDocument): number {
  return maxDateDriftDaysFor({
    documentType: (doc.documentType ?? 'UNKNOWN') as 'RECEIPT' | 'TAX_INVOICE' | 'UNKNOWN',
    source: (doc.source ?? 'WHATSAPP') as 'EMAIL' | 'WHATSAPP',
  } as Parameters<typeof maxDateDriftDaysFor>[0]);
}

function compareCard(doc: ComparableDocument, charge: ComparableCharge): ComparisonRow {
  const label = 'Card';
  const chargeValue = `•••• ${charge.cardLast4}`;

  if (doc.cardLast4 === null) {
    return {
      field: 'card',
      label,
      documentValue: null,
      chargeValue,
      verdict: 'NOT_ON_DOCUMENT',
      note: t('compare.note.noCard'),
    };
  }

  const documentValue = `•••• ${doc.cardLast4}`;
  const same = doc.cardLast4.trim() === charge.cardLast4.trim();

  return {
    field: 'card',
    label,
    documentValue,
    chargeValue,
    verdict: same ? 'AGREES' : 'DIFFERS',
    // The card number is the one field OCR rarely gets subtly wrong, so a mismatch here
    // is close to decisive — worth saying out loud rather than leaving as a red bar.
    note: same ? null : t('compare.note.otherCard'),
  };
}

function compareMerchant(doc: ComparableDocument, charge: ComparableCharge): ComparisonRow {
  const label = 'Merchant';

  if (doc.merchantName === null || doc.merchantName.trim() === '') {
    return {
      field: 'merchant',
      label,
      documentValue: null,
      chargeValue: charge.merchantName,
      verdict: 'NOT_ON_DOCUMENT',
      note: t('compare.note.noMerchant'),
    };
  }

  // Names are compared by the engine with normalisation and a similarity measure; the
  // verdict here is deliberately coarse, because a reviewer reading both strings side by
  // side is a better judge of "same shop" than any threshold this module could apply.
  const normalise = (value: string) => value.trim().toUpperCase();
  const exact = normalise(doc.merchantName) === normalise(charge.merchantName);

  return {
    field: 'merchant',
    label,
    documentValue: doc.merchantName,
    chargeValue: charge.merchantName,
    verdict: exact ? 'AGREES' : 'CLOSE',
    note: exact ? null : t('compare.note.acquirer'),
  };
}

/**
 * Builds the four comparison rows, strongest evidence first.
 *
 * Amount and card lead because they are the two signals that can settle the question on
 * their own; merchant and date follow because on their own they are a coincidence rather
 * than an identification.
 */
export function buildComparison(
  doc: ComparableDocument,
  charge: ComparableCharge,
): ComparisonRow[] {
  return [
    compareAmount(doc, charge),
    compareCard(doc, charge),
    compareMerchant(doc, charge),
    compareDate(doc, charge),
  ];
}

/**
 * What a reviewer should look at first: the rows that do not simply agree.
 *
 * Returned in the order above, so "the amount is 5.75 short" outranks "the names are
 * spelled differently" without the caller needing to know the ranking.
 */
export function pointsOfDifference(rows: ComparisonRow[]): ComparisonRow[] {
  return rows.filter((row) => row.verdict === 'DIFFERS' || row.verdict === 'NOT_ON_DOCUMENT');
}

/**
 * What distinguishes two charges competing for the same document.
 *
 * When candidates tie on every signal, every bar reads 100% for both and the interface has
 * nothing left to say with scores — it is showing agreement to someone whose problem is
 * that everything agrees. The useful move is the opposite: name only what differs, so the
 * reviewer knows the specific thing to check against the paper receipt.
 *
 * Each difference carries its own description, derived from the values rather than looked
 * up by field name. That distinction is the whole point of this rewrite: the previous
 * version mapped `merchant` to the fixed phrase "the branch", which is true for two
 * outlets of one chain and false for two unrelated shops — and it rendered the same
 * sentence for both. A reviewer told that Panda and Nahdi "differ only in the branch" has
 * been actively misled on the screen whose entire job is preventing a wrong attachment.
 *
 * When this returns an empty list, nothing in the data separates the two charges, and the
 * interface must say so rather than present a choice that is really a coin flip.
 */

export type DifferenceField = 'merchant' | 'amount' | 'card' | 'date' | 'time';

export interface ChargeDifference {
  field: DifferenceField;
  /** A phrase that fits "they differ only in ___", accurate for these two values. */
  phrase: string;
  left: string;
  right: string;
}

/** Same calendar day, in UTC terms — the engine's own notion of "same day". */
function sameDay(a: Date, b: Date): boolean {
  return Math.floor(a.getTime() / MS_PER_DAY) === Math.floor(b.getTime() / MS_PER_DAY);
}

export function chargeDifferences(
  a: ComparableCharge,
  b: ComparableCharge,
  /**
   * How alike the two merchant names are, 0..1. Injected rather than imported so this
   * module stays free of the matching engine — the caller passes `merchantSimilarity`,
   * which is the same function the matcher scores with, so the UI and the engine agree
   * about what "the same chain" means.
   */
  merchantAlikeness: (left: string, right: string) => number,
): ChargeDifference[] {
  const differences: ChargeDifference[] = [];

  if (a.merchantName.trim() !== b.merchantName.trim()) {
    // Two outlets of one chain and two unrelated shops are different problems and need
    // different sentences. The threshold is deliberately generous: a reviewer reading
    // "the branch" must be able to trust it, so anything short of clearly-the-same-name
    // is described as a different merchant.
    const alike = merchantAlikeness(a.merchantName, b.merchantName) >= 0.6;
    differences.push({
      field: 'merchant',
      phrase: alike ? 'the branch' : 'the merchant',
      left: a.merchantName,
      right: b.merchantName,
    });
  }

  if (a.amount !== b.amount) {
    differences.push({
      field: 'amount',
      phrase: 'the amount',
      left: money(a.amount, a.currency),
      right: money(b.amount, b.currency),
    });
  }

  if (a.cardLast4 !== b.cardLast4) {
    differences.push({
      field: 'card',
      phrase: 'the card',
      left: `•••• ${a.cardLast4}`,
      right: `•••• ${b.cardLast4}`,
    });
  }

  if (a.transactionAt.getTime() !== b.transactionAt.getTime()) {
    // Two charges minutes apart and two charges a week apart are told apart by completely
    // different evidence, so they do not get the same sentence either.
    const within = sameDay(a.transactionAt, b.transactionAt);
    differences.push({
      field: within ? 'time' : 'date',
      phrase: within ? 'the time of day' : 'the date',
      left: a.transactionAt.toISOString(),
      right: b.transactionAt.toISOString(),
    });
  }

  return differences;
}

export interface ChargeSpread {
  field: DifferenceField;
  /** A phrase that fits "they differ only in ___", accurate for these values. */
  phrase: string;
  /** Every distinct value present, in candidate order. */
  values: string[];
}

/**
 * What separates a set of competing charges — any number of them.
 *
 * The two-charge version below is a special case of this and remains for callers that
 * genuinely have a pair. This exists because the review screen does not: a chain with
 * several outlets in one district routinely produces three tied candidates, and the
 * interface was built around `const [a, b] = charges`, so the third was dropped from the
 * one screen whose job is to show everything that is competing.
 *
 * A field counts as differing if *any* two charges differ on it, and every distinct value
 * is reported rather than just the first pair — a reviewer deciding between three outlets
 * needs all three branch numbers, not two of them.
 */
export function chargeDifferencesAcross(
  charges: readonly ComparableCharge[],
  merchantAlikeness: (left: string, right: string) => number,
): ChargeSpread[] {
  if (charges.length < 2) return [];

  const spreads: ChargeSpread[] = [];

  const distinct = <T>(values: T[], key: (value: T) => string): T[] => {
    const seen = new Set<string>();
    return values.filter((value) => {
      const k = key(value);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };

  const merchants = distinct(
    charges.map((c) => c.merchantName.trim()),
    (m) => m,
  );
  if (merchants.length > 1) {
    // "The branch" only if *every* pair reads as the same chain. One unrelated merchant
    // among three outlets makes the whole set a merchant difference, because telling a
    // reviewer to check the branch when the names are genuinely different sends them
    // looking for the wrong thing.
    const allSameChain = merchants.every((left, i) =>
      merchants.slice(i + 1).every((right) => merchantAlikeness(left, right) >= 0.6),
    );
    spreads.push({
      field: 'merchant',
      phrase: allSameChain ? 'the branch' : 'the merchant',
      values: merchants,
    });
  }

  const amounts = distinct([...charges], (c) => `${c.amount}|${c.currency}`);
  if (amounts.length > 1) {
    spreads.push({
      field: 'amount',
      phrase: 'the amount',
      values: amounts.map((c) => money(c.amount, c.currency)),
    });
  }

  const cards = distinct(charges.map((c) => c.cardLast4), (c) => c);
  if (cards.length > 1) {
    spreads.push({ field: 'card', phrase: 'the card', values: cards.map((c) => `•••• ${c}`) });
  }

  const times = distinct(charges.map((c) => c.transactionAt), (d) => String(d.getTime()));
  if (times.length > 1) {
    // Charges minutes apart and charges a week apart are told apart by completely
    // different evidence, so they do not get the same sentence either.
    const within = times.every((time) => sameDay(time, times[0]!));
    spreads.push({
      field: within ? 'time' : 'date',
      phrase: within ? 'the time of day' : 'the date',
      values: times.map((d) => d.toISOString()),
    });
  }

  return spreads;
}

/**
 * The field names alone, kept for callers that only need to know *whether* anything
 * separates two charges.
 */
export function distinguishingFields(a: ComparableCharge, b: ComparableCharge): string[] {
  const differences: string[] = [];
  if (a.merchantName.trim() !== b.merchantName.trim()) differences.push('merchant');
  if (a.amount !== b.amount) differences.push('amount');
  if (a.cardLast4 !== b.cardLast4) differences.push('card');
  if (a.transactionAt.getTime() !== b.transactionAt.getTime()) differences.push('time');
  return differences;
}
