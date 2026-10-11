import type { DocumentSource, DocumentType, SignalBreakdown } from '@/lib/domain/enums';
import { merchantSimilarity } from '@/lib/matching/merchant';
import {
  AMBIGUITY_MARGIN,
  AUTO_MATCH_THRESHOLD,
  DATE_PROXIMITY_CURVE,
  MAX_DATE_DRIFT_DAYS,
  MAX_TIP_RATIO,
  MAX_UNDERCHARGE_RATIO,
  MIN_CANDIDATE_THRESHOLD,
  MIN_EXTRACTION_CONFIDENCE_FOR_AUTO,
  SIGNAL_WEIGHTS,
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

/** Why the matcher landed where it did. Surfaced in the review queue and in logs. */
export type MatchReason =
  | 'CONFIDENT_SINGLE_CANDIDATE'
  | 'AMBIGUOUS_TOP_CANDIDATES'
  | 'TRANSACTION_ALREADY_DOCUMENTED'
  | 'LOW_EXTRACTION_CONFIDENCE'
  | 'WEAK_EVIDENCE'
  | 'MID_CONFIDENCE'
  | 'NO_CANDIDATE_TRANSACTIONS'
  | 'NO_PLAUSIBLE_CANDIDATE'
  | 'UNUSABLE_EXTRACTION';

export interface MatchResult {
  outcome: MatchOutcome;
  /** Ranked, best first. Only candidates at or above the review floor appear. */
  candidates: MatchCandidate[];
  reason: MatchReason;
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

  const delta = transactionAmount - documentAmount;
  if (delta === 0) return 1;
  if (Math.abs(delta) <= VAT_ROUNDING_TOLERANCE_HALALAS) return 0.97;

  const ratio = Math.abs(delta) / documentAmount;

  if (delta > 0) {
    // Card charged more than the receipt — tip or service charge.
    if (ratio > MAX_TIP_RATIO) return 0;
    // Linear decay 0.90 (no gap) -> 0.50 (the largest tip we still believe).
    return Number((0.9 - 0.4 * (ratio / MAX_TIP_RATIO)).toFixed(4));
  }

  // Card charged less than the receipt — possible but weak evidence.
  if (ratio > MAX_UNDERCHARGE_RATIO) return 0;
  return 0.45;
}

/**
 * Date proximity, in whole UTC days. Documents arrive late, so the window is generous,
 * but past a week the date carries no information and the candidate is vetoed.
 */
export function scoreDate(documentDate: string | null, transactionAt: Date): number | null {
  if (!documentDate) return null;

  const parsed = new Date(documentDate);
  if (Number.isNaN(parsed.getTime())) return null; // garbage OCR date: absent, not wrong

  const dayOf = (d: Date) => Math.floor(d.getTime() / MS_PER_DAY);
  const drift = Math.abs(dayOf(parsed) - dayOf(transactionAt));

  if (drift > MAX_DATE_DRIFT_DAYS) return 0;
  return DATE_PROXIMITY_CURVE[Math.min(drift, DATE_PROXIMITY_CURVE.length - 1)];
}

/** Last four digits of the card. Near-unique when present; silent when absent. */
export function scoreCardLast4(documentCard: string | null, transactionCard: string): number | null {
  if (!documentCard) return null;
  return documentCard.trim() === transactionCard.trim() ? 1 : 0;
}

/** Fuzzy merchant agreement. See lib/matching/merchant.ts for the normalisation rules. */
export function scoreMerchant(documentName: string | null, transactionName: string): number | null {
  if (!documentName) return null;
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

function scoreTransaction(
  doc: MatchableDocument,
  txn: CandidateTransaction,
): ScoredCandidate | null {
  if (scopeVeto(doc, txn)) return null;
  if (currencyVeto(doc, txn)) return null;

  const amount = scoreAmount(doc.totalAmount, txn.amount);
  const date = scoreDate(doc.documentDate, txn.transactionAt);
  const cardLast4 = scoreCardLast4(doc.cardLast4, txn.cardLast4);
  const merchant = scoreMerchant(doc.merchantName, txn.merchantName);

  // A contradicted signal is a veto, not a low score: these three cannot be outvoted.
  if (amount === 0) return null;
  if (date === 0) return null;
  if (cardLast4 === 0) return null;

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

  return {
    transactionId: txn.id,
    confidence,
    signals,
    hasConfirmedDocument: txn.hasConfirmedDocument,
    weakEvidence,
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
    return { outcome: 'UNMATCHED', candidates: [], reason: 'UNUSABLE_EXTRACTION' };
  }

  if (transactions.length === 0) {
    return { outcome: 'UNMATCHED', candidates: [], reason: 'NO_CANDIDATE_TRANSACTIONS' };
  }

  const scored = transactions
    .map((txn) => scoreTransaction(doc, txn))
    .filter((candidate): candidate is ScoredCandidate => candidate !== null)
    .filter((candidate) => candidate.confidence >= MIN_CANDIDATE_THRESHOLD)
    .sort((a, b) => {
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
    return { outcome: 'UNMATCHED', candidates: [], reason: 'NO_PLAUSIBLE_CANDIDATE' };
  }

  const [top, runnerUp] = scored;
  const review = (reason: MatchReason): MatchResult => ({
    outcome: 'NEEDS_REVIEW',
    candidates,
    reason,
  });

  // Order matters: the most specific explanation wins, because `reason` is shown to a
  // reviewer as the headline for why this landed on their desk.
  if (top.confidence < AUTO_MATCH_THRESHOLD) {
    return review(top.weakEvidence ? 'WEAK_EVIDENCE' : 'MID_CONFIDENCE');
  }

  if (top.hasConfirmedDocument) {
    // Possible duplicate receipt — a human decides which document the transaction keeps.
    return review('TRANSACTION_ALREADY_DOCUMENTED');
  }

  if (runnerUp && top.confidence - runnerUp.confidence < AMBIGUITY_MARGIN) {
    // The lead is within noise. Two plausible transactions, no basis to pick one.
    return review('AMBIGUOUS_TOP_CANDIDATES');
  }

  if (doc.extractionConfidence < MIN_EXTRACTION_CONFIDENCE_FOR_AUTO) {
    // The signals agree, but they were read off a scan the OCR itself distrusts.
    return review('LOW_EXTRACTION_CONFIDENCE');
  }

  return { outcome: 'AUTO_MATCHED', candidates, reason: 'CONFIDENT_SINGLE_CANDIDATE' };
}
