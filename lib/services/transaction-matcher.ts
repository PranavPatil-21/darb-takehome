import type { DocumentSource, DocumentType, SignalBreakdown } from '@/lib/domain/enums';
import { merchantSimilarity, normaliseMerchant } from '@/lib/matching/merchant';
import {
  AMBIGUITY_MARGIN,
  AUTO_MATCH_THRESHOLD,
  DATE_PROXIMITY_CURVE,
  INVOICE_MAX_DATE_DRIFT_DAYS,
  MAX_DATE_DRIFT_DAYS,
  MAX_TIP_RATIO,
  MAX_UNDERCHARGE_RATIO,
  MIN_CANDIDATE_THRESHOLD,
  MIN_CORROBORATING_SIGNALS,
  MIN_EXTRACTION_CONFIDENCE_FOR_AUTO,
  SIGNAL_WEIGHTS,
  TIP_BAND_DECAY,
  TIP_BAND_MAX_SCORE,
  UNDERCHARGE_SCORE,
  VAT_ROUNDING_SCORE,
  VAT_ROUNDING_TOLERANCE_HALALAS,
  WEAK_EVIDENCE_CONFIDENCE_CAP,
  type SignalName,
} from '@/lib/matching/scoring-config';

/* ========================================================================== */
/* Inputs                                                                      */
/* ========================================================================== */

/**
 * Everything the matcher is allowed to know about a document: the OCR output plus the
 * scope resolved from the sender at ingestion time.
 *
 * The brief types this parameter `ExtractedFields`; it carries the resolved scope too
 * because "a WhatsApp document may only match that driver's cards" is a property of the
 * *delivery*, not of the pixels. Keeping it on the same input is what lets the matcher
 * enforce scoping itself rather than trusting its caller — see `scopeVeto`.
 */
export interface MatchableDocument {
  source: DocumentSource;
  /** Resolved from the sender identity. Null means the sender is unknown to us. */
  clientId: number | null;
  /** Set for WhatsApp documents from a known driver; null for a client-wide mailbox. */
  driverPhone: string | null;

  documentType: DocumentType;
  merchantName: string | null;
  vatNumber: string | null;
  /** Minor units (halalas). */
  totalAmount: number | null;
  currency: string | null;
  /** ISO 8601, or any string — malformed values degrade to an absent date signal. */
  documentDate: string | null;
  cardLast4: string | null;
  invoiceNumber: string | null;
  /** 0..1, the OCR's own confidence. Gates auto-match; never dilutes the match score. */
  extractionConfidence: number;
}

/** The brief's name for the same shape. */
export type ExtractedFields = MatchableDocument;

export interface CandidateTransaction {
  id: number;
  clientId: number;
  cardLast4: string;
  driverPhone: string | null;
  merchantName: string;
  /** Minor units (halalas). */
  amount: number;
  currency: string;
  transactionAt: Date;
  /**
   * Whether this transaction already has a confirmed document attached.
   *
   * Loaded by the caller and passed in rather than queried here, so that `matchDocument`
   * stays a pure function with no I/O — the property the brief asks for and the reason
   * the whole engine is trivially testable.
   */
  hasConfirmedDocument: boolean;
}

/* ========================================================================== */
/* Outputs                                                                     */
/* ========================================================================== */

export interface MatchCandidate {
  transactionId: number;
  /** 0..1 — weighted blend of the signals below. */
  confidence: number;
  /**
   * Per-signal scores, `Record<string, number>` as the brief specifies.
   *
   * A signal that could not be read is **absent from this object**, not present as 0 —
   * see `signalBreakdownSchema`. Test availability with `'cardLast4' in signals`.
   */
  signals: SignalBreakdown;
}

export type MatchOutcome = 'AUTO_MATCHED' | 'NEEDS_REVIEW' | 'UNMATCHED';

/**
 * Why a transaction was excluded from scoring outright.
 *
 * A veto removes a candidate silently, which is correct for the decision and useless for
 * the human who has to explain it. The operational question in a VAT-compliance product
 * is at least as often "why was this *not* matched to the obvious charge" as "why was it
 * matched to this one", and before this existed the system had no answer: the reviewer
 * saw NO_PLAUSIBLE_CANDIDATE and an empty list.
 */
export type VetoReason =
  | 'OUT_OF_SCOPE'
  | 'CURRENCY_MISMATCH'
  | 'AMOUNT_CONTRADICTED'
  | 'DATE_OUT_OF_WINDOW'
  | 'CARD_LAST4_CONTRADICTED';

export interface VetoedTransaction {
  transactionId: number;
  veto: VetoReason;
}

/**
 * Why the matcher landed where it did. Surfaced in the review queue and in logs.
 *
 * Exported as a value as well as a type so the interface layer can prove it handles every
 * one of them. A reason added here without a home in the work queue's taxonomy fails
 * `work-queue.test.ts` rather than quietly disappearing from the queue.
 */
export const MATCH_REASONS = [
  'CONFIDENT_SINGLE_CANDIDATE',
  'AMBIGUOUS_TOP_CANDIDATES',
  'TRANSACTION_ALREADY_DOCUMENTED',
  'LOW_EXTRACTION_CONFIDENCE',
  'WEAK_EVIDENCE',
  'MID_CONFIDENCE',
  'NO_CANDIDATE_TRANSACTIONS',
  'NO_PLAUSIBLE_CANDIDATE',
  'INSUFFICIENT_CORROBORATION',
  'UNEXPLAINED_AMOUNT_GAP',
  'UNUSABLE_EXTRACTION',
] as const;

export type MatchReason = (typeof MATCH_REASONS)[number];

type LegacyMatchReason =
  | 'CONFIDENT_SINGLE_CANDIDATE'
  | 'AMBIGUOUS_TOP_CANDIDATES'
  | 'TRANSACTION_ALREADY_DOCUMENTED'
  | 'LOW_EXTRACTION_CONFIDENCE'
  | 'WEAK_EVIDENCE'
  | 'MID_CONFIDENCE'
  | 'NO_CANDIDATE_TRANSACTIONS'
  | 'NO_PLAUSIBLE_CANDIDATE'
  | 'INSUFFICIENT_CORROBORATION'
  | 'UNEXPLAINED_AMOUNT_GAP'
  | 'UNUSABLE_EXTRACTION';

/** Fails to compile if the list above and the union drift apart. */
type _ReasonsAgree = [LegacyMatchReason] extends [MatchReason]
  ? [MatchReason] extends [LegacyMatchReason]
    ? true
    : never
  : never;
const _reasonsAgree: _ReasonsAgree = true;
void _reasonsAgree;

export interface MatchResult {
  outcome: MatchOutcome;
  /** Ranked, best first. Only candidates at or above the review floor appear. */
  candidates: MatchCandidate[];
  reason: MatchReason;
  /**
   * Transactions excluded before scoring, with the rule that excluded them. Ordered as
   * the candidates were supplied. Empty when nothing was vetoed.
   */
  vetoed: VetoedTransaction[];
}

/* ========================================================================== */
/* Signal scorers — each returns 0..1, or null when the signal is unavailable  */
/* ========================================================================== */

const MS_PER_DAY = 86_400_000;

/**
 * Amount agreement.
 *
 * Asymmetric on purpose. A card charged *more* than the printed receipt is the everyday
 * tip/service-charge case and stays plausible; a card charged *less* is a rarer anomaly
 * (split bill, partial capture) and is scored far lower for the same absolute gap.
 */
export function scoreAmount(documentAmount: number | null, transactionAmount: number): number | null {
  if (documentAmount === null || !Number.isFinite(documentAmount) || documentAmount <= 0) {
    return null;
  }
  // The charge side is validated too. Prisma's `Int` cannot deliver a non-finite value
  // today, but a summed amount can — which is exactly what the multi-transaction invoice
  // design does — and every comparison below is false for NaN, so an unreadable total
  // would fall through to the undercharge branch and be scored "plausible".
  if (!Number.isFinite(transactionAmount)) return null;
  // Zero or negative is *contradicting*, not absent. Returning null here removed the
  // signal and let the candidate survive on card, merchant and date — so a receipt could
  // auto-attach to a charge of 0.00. A charge that cannot be what the receipt describes
  // should veto the pairing, which is what a score of 0 does.
  if (transactionAmount <= 0) return 0;

  const delta = transactionAmount - documentAmount;
  if (delta === 0) return 1;
  if (Math.abs(delta) <= VAT_ROUNDING_TOLERANCE_HALALAS) return VAT_ROUNDING_SCORE;

  const ratio = Math.abs(delta) / documentAmount;

  if (delta > 0) {
    // Card charged more than the receipt — tip or service charge.
    if (ratio > MAX_TIP_RATIO) return 0;
    // Linear decay from TIP_BAND_MAX_SCORE at no gap to the largest tip we still believe.
    return Number((TIP_BAND_MAX_SCORE - TIP_BAND_DECAY * (ratio / MAX_TIP_RATIO)).toFixed(4));
  }

  // Card charged less than the receipt — possible but weak evidence.
  if (ratio > MAX_UNDERCHARGE_RATIO) return 0;
  return UNDERCHARGE_SCORE;
}

/**
 * The date window this document is held to.
 *
 * Keyed on what the document *is* rather than how it arrived, with the channel as a
 * fallback: an invoice forwarded as a WhatsApp photo is still an invoice, and an email
 * whose type the OCR could not read is more likely a forwarded invoice than a till slip.
 * Exported because `candidateWindow` must use the same answer — a query narrower than the
 * matcher silently drops candidates the matcher would have scored, and a candidate that
 * never arrives cannot be overruled.
 */
export function maxDateDriftDaysFor(doc: MatchableDocument): number {
  if (doc.documentType === 'TAX_INVOICE') return INVOICE_MAX_DATE_DRIFT_DAYS;
  if (doc.documentType === 'RECEIPT') return MAX_DATE_DRIFT_DAYS;
  return doc.source === 'EMAIL' ? INVOICE_MAX_DATE_DRIFT_DAYS : MAX_DATE_DRIFT_DAYS;
}

/**
 * Date proximity, in whole UTC days. Documents arrive late, so the window is generous,
 * but past a week the date carries no information and the candidate is vetoed.
 */
export function scoreDate(
  documentDate: string | null,
  transactionAt: Date,
  maxDriftDays: number = MAX_DATE_DRIFT_DAYS,
): number | null {
  if (!documentDate) return null;

  const parsed = new Date(documentDate);
  if (Number.isNaN(parsed.getTime())) return null; // garbage OCR date: absent, not wrong

  const dayOf = (d: Date) => Math.floor(d.getTime() / MS_PER_DAY);
  const drift = Math.abs(dayOf(parsed) - dayOf(transactionAt));

  if (drift > maxDriftDays) return 0;
  // The curve is indexed by whole days of drift, and the `Math.min` clamp is load-bearing
  // rather than defensive: the curve deliberately spans only the *receipt* window (8
  // entries, 0-7 days), while `maxDriftDays` reaches 45 for a supplier invoice. Everything
  // past the end of the curve clamps to its flat tail of 0.30.
  //
  // That is the intended behaviour, not an oversight. The tail is flat from day 4 onward
  // because by then the date has stopped discriminating between candidates — so extending
  // the curve to 46 entries would add forty-odd copies of the same number and imply a
  // precision that is not there. The date stops being evidence; it does not become wrong.
  //
  // `?? 0` covers the one case the clamp cannot: an empty curve.
  return DATE_PROXIMITY_CURVE[Math.min(drift, DATE_PROXIMITY_CURVE.length - 1)] ?? 0;
}

/**
 * Reduces whatever OCR produced for a card number to four comparable digits.
 *
 * Receipts print the last four in every imaginable way — "4412", "**** 4412", "x4412",
 * and, when the leading digit is a zero the scanner dropped, "412". Returns null when no
 * digits survive, which keeps "the receipt shows no card number" distinct from "the
 * receipt shows a different one" — the difference between an absent signal and a veto.
 */
function normaliseCardLast4(raw: string | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 0) return null;
  return digits.slice(-4).padStart(4, '0');
}

/**
 * Last four digits of the card. Near-unique when present; silent when absent.
 *
 * Both sides are normalised before comparison. Comparing raw strings made a dropped
 * leading zero look like a different card, and because a card mismatch is a veto rather
 * than a low score, that one formatting difference discarded an otherwise perfect match
 * — exact amount, exact date, strong merchant — and returned UNMATCHED.
 */
export function scoreCardLast4(documentCard: string | null, transactionCard: string): number | null {
  const document = normaliseCardLast4(documentCard);
  if (document === null) return null;

  const transaction = normaliseCardLast4(transactionCard);
  if (transaction === null) return null;

  return document === transaction ? 1 : 0;
}

/**
 * Fuzzy merchant agreement. See lib/matching/merchant.ts for the normalisation rules.
 *
 * Returns null — signal unavailable — when *either* name reduces to no identifying
 * tokens. Acquirer strings like "POS 04 RUH" are pure terminal metadata: every token is
 * noise, so there is nothing to agree or disagree with.
 *
 * This matters more than it looks. `combine` renormalises over available signals but
 * averages in a present one at full weight, so scoring this 0 meant that reading a
 * merchant name off the receipt actively *lowered* confidence against such a transaction
 * — a document carrying more information scoring worse than the same document carrying
 * less. Absent is the honest answer, and it restores the monotonicity.
 */
export function scoreMerchant(documentName: string | null, transactionName: string): number | null {
  if (!documentName) return null;
  if (normaliseMerchant(documentName).length === 0) return null;
  if (normaliseMerchant(transactionName).length === 0) return null;
  return merchantSimilarity(transactionName, documentName);
}

/* ========================================================================== */
/* Vetoes — reasons a candidate is excluded outright rather than scored low    */
/* ========================================================================== */

/**
 * Scope is a filter, not a signal.
 *
 * The brief lists sender scoping among the signals, but scoring it 0..1 would let a
 * strong amount-and-merchant match outvote it and attach one client's receipt to another
 * client's transaction. In a VAT-compliance product that is a correctness bug, not a
 * ranking preference — so it is enforced as a hard veto here and as a query filter in
 * candidate selection. Defence in depth: a careless caller cannot widen the scope.
 */
function scopeVeto(doc: MatchableDocument, txn: CandidateTransaction): boolean {
  if (doc.clientId === null) return true; // unknown sender: matches nothing
  if (doc.clientId !== txn.clientId) return true;

  // A WhatsApp document from a known driver is confined to that driver's cards. An email
  // document (no driverPhone) is scoped to the client as a whole, because a fleet manager
  // legitimately forwards invoices for any driver.
  if (doc.source === 'WHATSAPP' && doc.driverPhone !== null) {
    if (txn.driverPhone !== doc.driverPhone) return true;
  }

  return false;
}

/** Currencies must agree when both are known. A SAR receipt is not an AED charge. */
function currencyVeto(doc: MatchableDocument, txn: CandidateTransaction): boolean {
  if (!doc.currency) return false;
  return doc.currency.trim().toUpperCase() !== txn.currency.trim().toUpperCase();
}

/**
 * An extraction is unusable when it has no identifying content at all. Scoring it would
 * produce confident-looking noise, so the pipeline stops here and the document goes to a
 * terminal state instead of into a reviewer's queue.
 */
function isUnusable(doc: MatchableDocument): boolean {
  const hasAnyEvidence =
    doc.totalAmount !== null ||
    doc.cardLast4 !== null ||
    (doc.merchantName !== null && doc.merchantName.trim() !== '');

  if (!hasAnyEvidence) return true;
  // UNKNOWN type with no amount and no card is OCR failure dressed up as output.
  return doc.documentType === 'UNKNOWN' && doc.totalAmount === null && doc.cardLast4 === null;
}

/* ========================================================================== */
/* Scoring                                                                     */
/* ========================================================================== */

interface ScoredCandidate extends MatchCandidate {
  hasConfirmedDocument: boolean;
  /** True when neither amount nor card number was available to score. */
  weakEvidence: boolean;
  /**
   * True when the receipt total and the charge differ by more than VAT rounding — a tip,
   * a service charge or a partial capture. Plausible, but never self-evident.
   */
  unexplainedAmountGap: boolean;
}

/**
 * Combines the per-signal scores into one confidence.
 *
 * Signals that are unavailable are *excluded and the remaining weights renormalised*,
 * rather than scored zero. This matters: OCR fails to read a card number on most thermal
 * receipts, and treating that silence as contradiction would push every such document
 * into manual review — exactly the cost this system exists to remove.
 */
function combine(signals: SignalBreakdown): number {
  let weighted = 0;
  let totalWeight = 0;

  for (const [name, weight] of Object.entries(SIGNAL_WEIGHTS) as [SignalName, number][]) {
    const score = signals[name];
    if (score === undefined) continue; // signal unavailable — excluded, not zeroed
    weighted += score * weight;
    totalWeight += weight;
  }

  if (totalWeight === 0) return 0;
  return Number((weighted / totalWeight).toFixed(4));
}

type ScoreOutcome =
  | { kind: 'scored'; candidate: ScoredCandidate }
  | { kind: 'vetoed'; veto: VetoReason };

function scoreTransaction(doc: MatchableDocument, txn: CandidateTransaction): ScoreOutcome {
  if (scopeVeto(doc, txn)) return { kind: 'vetoed', veto: 'OUT_OF_SCOPE' };
  if (currencyVeto(doc, txn)) return { kind: 'vetoed', veto: 'CURRENCY_MISMATCH' };

  const amount = scoreAmount(doc.totalAmount, txn.amount);
  const date = scoreDate(doc.documentDate, txn.transactionAt, maxDateDriftDaysFor(doc));
  const cardLast4 = scoreCardLast4(doc.cardLast4, txn.cardLast4);
  const merchant = scoreMerchant(doc.merchantName, txn.merchantName);

  // A contradicted signal is a veto, not a low score: these three cannot be outvoted.
  if (amount === 0) return { kind: 'vetoed', veto: 'AMOUNT_CONTRADICTED' };
  if (date === 0) return { kind: 'vetoed', veto: 'DATE_OUT_OF_WINDOW' };
  if (cardLast4 === 0) return { kind: 'vetoed', veto: 'CARD_LAST4_CONTRADICTED' };

  // Absent signals are omitted rather than set to null, so the stored breakdown matches
  // the `Record<string, number>` contract and "unavailable" stays distinguishable from
  // "scored zero".
  const signals: SignalBreakdown = {};
  if (amount !== null) signals.amount = amount;
  if (cardLast4 !== null) signals.cardLast4 = cardLast4;
  if (merchant !== null) signals.merchant = merchant;
  if (date !== null) signals.date = date;

  let confidence = combine(signals);

  // Merchant and date alone are not enough to attach a document to money. A fleet
  // refuels at the same station daily; without an amount or a card number, the most
  // this can ever be is a suggestion for a human.
  const weakEvidence = amount === null && cardLast4 === null;
  if (weakEvidence) confidence = Math.min(confidence, WEAK_EVIDENCE_CONFIDENCE_CAP);

  // A gap the receipt itself does not explain. Deliberately *not* a confidence cap: the
  // score still reflects how well the evidence agrees, and the reviewer still sees the
  // real number. It gates the automatic attachment instead, the same way the OCR's own
  // confidence does — keeping "how good is this match" separate from "may it settle
  // itself", which is what makes the signal breakdown readable.
  const unexplainedAmountGap =
    amount !== null && amount < VAT_ROUNDING_SCORE;

  return {
    kind: 'scored',
    candidate: {
      transactionId: txn.id,
      confidence,
      signals,
      hasConfirmedDocument: txn.hasConfirmedDocument,
      weakEvidence,
      unexplainedAmountGap,
    },
  };
}

/* ========================================================================== */
/* The matcher                                                                 */
/* ========================================================================== */

/**
 * Match one extracted document against a set of candidate transactions.
 *
 * Pure: no I/O, no clock, no mutation of its arguments. Everything it needs — including
 * whether a transaction is already documented — arrives as an argument, which is what
 * makes every edge case in the brief expressible as a plain unit test.
 */
export function matchDocument(
  doc: MatchableDocument,
  transactions: readonly CandidateTransaction[],
): MatchResult {
  if (isUnusable(doc)) {
    return { outcome: 'UNMATCHED', candidates: [], reason: 'UNUSABLE_EXTRACTION', vetoed: [] };
  }

  if (transactions.length === 0) {
    return { outcome: 'UNMATCHED', candidates: [], reason: 'NO_CANDIDATE_TRANSACTIONS', vetoed: [] };
  }

  const vetoed: VetoedTransaction[] = [];
  const scored: ScoredCandidate[] = [];

  for (const txn of transactions) {
    const outcome = scoreTransaction(doc, txn);
    if (outcome.kind === 'vetoed') {
      vetoed.push({ transactionId: txn.id, veto: outcome.veto });
      continue;
    }
    if (outcome.candidate.confidence >= MIN_CANDIDATE_THRESHOLD) scored.push(outcome.candidate);
  }

  scored.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    // Deterministic tie-breaking. An undocumented transaction outranks an already
    // documented one at equal confidence, then lowest id wins so repeated runs — and
    // the tests that assert on them — are stable.
    if (a.hasConfirmedDocument !== b.hasConfirmedDocument) {
      return a.hasConfirmedDocument ? 1 : -1;
    }
    return a.transactionId - b.transactionId;
  });

  const candidates: MatchCandidate[] = scored.map(({ transactionId, confidence, signals }) => ({
    transactionId,
    confidence,
    signals,
  }));

  if (scored.length === 0) {
    return { outcome: 'UNMATCHED', candidates: [], reason: 'NO_PLAUSIBLE_CANDIDATE', vetoed };
  }

  const top = scored[0];
  if (!top) {
    return { outcome: 'UNMATCHED', candidates: [], reason: 'NO_PLAUSIBLE_CANDIDATE', vetoed };
  }
  const runnerUp = scored[1];

  const review = (reason: MatchReason): MatchResult => ({
    outcome: 'NEEDS_REVIEW',
    candidates,
    reason,
    vetoed,
  });

  // Rounded before comparing, not compared raw. Confidences are already quantised to four
  // decimals by `combine`, but their IEEE-754 *difference* is not: 0.95 - 0.90 is
  // 0.04999999999999993 while 0.90 - 0.85 is 0.050000000000000044, so two pairs with the
  // identical nominal gap of exactly 0.05 would land on opposite sides of this threshold.
  // The direction of the error is harmless — one extra review — but a documented rule
  // that holds for some values and not others is not a rule, and it is the kind of thing
  // that makes a confidence boundary impossible to reason about later.
  const margin = Number((top.confidence - (runnerUp?.confidence ?? 0)).toFixed(4));

  // Order matters: `reason` is the headline a reviewer reads to know what to do, so the
  // ordering is by what the reviewer has to *decide*, not by how the code happens to
  // read. Two of these used to sit below a generic confidence check that swallowed them —
  // a duplicate receipt and an unexplained amount gap both reported `MID_CONFIDENCE`,
  // burying the one fact that changes the action.
  //
  //   1. the charge already holds a receipt   -> which document does it keep?
  //   2. two charges fit equally well         -> which charge is it?
  //   3. the totals do not agree              -> is the difference a tip?
  //   4. everything is merely weak            -> is this the right charge at all?

  if (top.hasConfirmedDocument) {
    // Possible duplicate receipt — a human decides which document the transaction keeps.
    return review('TRANSACTION_ALREADY_DOCUMENTED');
  }

  if (runnerUp && margin < AMBIGUITY_MARGIN) {
    // The lead is within noise. Two plausible transactions, no basis to pick one.
    return review('AMBIGUOUS_TOP_CANDIDATES');
  }

  // A tip, a service charge or a partial capture is a legitimate reason for the numbers
  // to differ — and exactly the situation a person should confirm rather than a rule.
  // The brief's own worked example (57.50 receipt, 63.25 charge) lives here.
  //
  // Deliberately a gate on the automatic attachment, not a cap on the confidence: the
  // score still reports how well the evidence agrees and the reviewer still sees the real
  // number, the same separation the OCR-confidence gate keeps. Before it existed the
  // outcome depended on how the acquirer abbreviated the merchant name — `NAJD VILLAGE
  // REST RUH` stayed in review by 0.0065 while `NAJD VILLAGE RESTAURANT RUH` auto-
  // attached a 57.50 receipt to a 63.25 charge. For a VAT filing, a receipt that does not
  // substantiate the amount charged is precisely what a person is there to look at.
  if (top.unexplainedAmountGap) {
    return review('UNEXPLAINED_AMOUNT_GAP');
  }

  if (top.confidence < AUTO_MATCH_THRESHOLD) {
    return review(top.weakEvidence ? 'WEAK_EVIDENCE' : 'MID_CONFIDENCE');
  }

  // One signal agreeing perfectly is still one signal. `combine` renormalises over the
  // signals that were available, so a document where OCR read nothing but a total scores
  // a flawless 1.0 against any charge carrying that amount — and would attach itself to
  // the money with nothing corroborating it. The candidate is still shown; it just cannot
  // settle itself.
  if (Object.keys(top.signals).length < MIN_CORROBORATING_SIGNALS) {
    return review('INSUFFICIENT_CORROBORATION');
  }

  // Written as a positive test so a NaN confidence fails it. `NaN < 0.6` is false, so the
  // negated form let an unreadable confidence through the gate it exists to close.
  if (!(doc.extractionConfidence >= MIN_EXTRACTION_CONFIDENCE_FOR_AUTO)) {
    // The signals agree, but they were read off a scan the OCR itself distrusts.
    return review('LOW_EXTRACTION_CONFIDENCE');
  }

  return { outcome: 'AUTO_MATCHED', candidates, reason: 'CONFIDENT_SINGLE_CANDIDATE', vetoed };
}
