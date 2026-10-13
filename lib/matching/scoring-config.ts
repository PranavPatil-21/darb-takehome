import type { SignalName } from '@/lib/matching/signal-names';

/**
 * Every tunable number the matcher uses, in one place with the reasoning attached.
 *
 * These are deliberately constants rather than magic numbers scattered through the
 * scoring code: a reviewer tuning the engine should be able to read this file alone,
 * and a future change to a threshold should show up as a one-line diff here.
 *
 * Justification for each value is in IMPLEMENTATION.md § "Scoring design".
 */

/**
 * Base signal weights. Renormalised at scoring time over whichever signals are present.
 *
 * Keyed by `SignalName` so adding a signal to that list without weighting it here is a
 * compile error rather than a signal silently scored and then silently ignored.
 */
export const SIGNAL_WEIGHTS: Record<SignalName, number> = {
  /**
   * 0.40 — the strongest discriminator. Within one client's statement for one day,
   * the exact halala amount is very nearly a primary key.
   */
  amount: 0.4,
  /**
   * 0.25 — near-unique when the receipt prints it, but OCR finds it on well under half
   * of crumpled thermal receipts, so it cannot carry more weight than amount.
   */
  cardLast4: 0.25,
  /**
   * 0.20 — always present on both sides but fuzzy and chain-repetitive: ten Alfanar
   * stations look identical here. Corroborating, not deciding.
   */
  merchant: 0.2,
  /**
   * 0.15 — weakest alone (a fleet books dozens of transactions a day) but an effective
   * tiebreaker between two otherwise equal candidates.
   */
  date: 0.15,
};

export type { SignalName };

/**
 * Amounts are integer minor units (halalas), so there is no floating-point epsilon to
 * worry about — only genuine business tolerance.
 */

/** VAT rounding drift is symmetric and tiny: at most a halala or two either way. */
export const VAT_ROUNDING_TOLERANCE_HALALAS = 5;

/** Score awarded inside the VAT-rounding band. Just short of 1: agreement, not identity. */
export const VAT_ROUNDING_SCORE = 0.97;

/**
 * Tips and service charges are *directional*: the card is charged MORE than the printed
 * receipt total, never less. Scoring this asymmetrically is the single highest-value
 * refinement in the amount signal — it lets a 10% tip stay a plausible candidate while
 * a transaction 10% *below* its receipt stays implausible.
 */
export const MAX_TIP_RATIO = 0.25;

/**
 * The tip band decays linearly from `TIP_BAND_MAX_SCORE` at no gap down to
 * `TIP_BAND_MAX_SCORE - TIP_BAND_DECAY` at the largest tip we still believe. Both
 * endpoints live here rather than inline in the scorer so the curve can be reshaped
 * without reading the scoring code.
 */
export const TIP_BAND_MAX_SCORE = 0.9;
export const TIP_BAND_DECAY = 0.4;

/** A card charged slightly less than the receipt total (split bill, partial capture). */
export const MAX_UNDERCHARGE_RATIO = 0.02;

/**
 * Flat score for an undercharge inside that band. Flat rather than decaying because the
 * band is only 2% wide — a curve across it would imply a precision the evidence does not
 * have — and it is set *equal to* `MIN_CANDIDATE_THRESHOLD`, which is the lowest score
 * that still reaches a reviewer. So an undercharge is always surfaced and can never carry
 * an auto-match on its own. The two constants are deliberately the same number; if either
 * moves, this one should move with it.
 */
export const UNDERCHARGE_SCORE = 0.45;

/**
 * How far a document's date may sit from the charge before the candidate is vetoed.
 *
 * Two windows, because the two document types mean different things by "date".
 *
 * A photographed till receipt is printed *at* the till, so its date and the card
 * authorisation are the same event. A week of slack covers a driver clearing their camera
 * roll on Sunday and the odd settlement delay; past that the date genuinely disagrees and
 * the candidate should go.
 *
 * A supplier tax invoice is dated when it was *raised*, which is a different event from
 * when the card settled — and it reaches the fleet manager's inbox later still, after the
 * supplier's billing run and a forward. Thirty-day terms are ordinary. Holding invoices to
 * the receipt window discarded invoices that agreed on amount, card *and* merchant, which
 * is as close to certain as this engine gets.
 *
 * Widening the window does not make a stale date look fresh: the proximity curve below is
 * flat at its tail, so everything past a week scores the same low value. The date simply
 * stops discriminating instead of vetoing.
 */
export const MAX_DATE_DRIFT_DAYS = 7;
export const INVOICE_MAX_DATE_DRIFT_DAYS = 45;

/** Score for each whole day of drift between document date and transaction date. */
export const DATE_PROXIMITY_CURVE: readonly number[] = [1, 0.85, 0.7, 0.55, 0.3, 0.3, 0.3, 0.3];

/** At or above this, a lone unambiguous candidate is attached without a human. */
export const AUTO_MATCH_THRESHOLD = 0.85;

/** Below this a transaction is not worth a reviewer's attention at all. */
export const MIN_CANDIDATE_THRESHOLD = 0.45;

/**
 * If the top two candidates are within this margin, the lead is noise rather than
 * signal — route to review EVEN IF the top score clears the auto threshold. This is
 * what stops two same-amount, same-day transactions at the same chain from being
 * silently attached to the wrong one.
 */
export const AMBIGUITY_MARGIN = 0.05;

/**
 * The OCR's own confidence gates auto-matching but does not dilute the match score.
 * Keeping them separate means the signal breakdown shown to a reviewer reflects only
 * document-versus-transaction evidence, while a blurry scan still cannot auto-attach.
 */
export const MIN_EXTRACTION_CONFIDENCE_FOR_AUTO = 0.6;

/**
 * Merchant name and date alone cannot auto-match: a fleet refuels at the same station
 * every day. Without an amount or a card number the result is capped into review.
 */
export const WEAK_EVIDENCE_CONFIDENCE_CAP = 0.6;

/**
 * How many signals must actually agree before a document is attached without a human.
 *
 * Renormalising over available signals (see `combine`) is what stops an unreadable card
 * number from forcing every receipt into manual review — but taken alone it has a sharp
 * edge: a document where OCR read *one* field renormalises that single signal to the full
 * weight and scores 1.0. A lone matching amount would then auto-attach to the first charge
 * in the window carrying that total, with nothing corroborating it.
 *
 * Two is the floor rather than three because requiring three would exclude the common and
 * entirely legitimate case of a thermal receipt showing only a total and a date.
 */
export const MIN_CORROBORATING_SIGNALS = 2;

/* -------------------------------------------------------------------------- */
/* Merchant similarity                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Blend of the two similarity measures. Containment leads because the dominant real-world
 * failure is the receipt carrying extra words the acquirer dropped, which containment
 * handles exactly and Dice only approximates.
 */
export const CONTAINMENT_WEIGHT = 0.55;
export const DICE_WEIGHT = 0.45;

/**
 * Multiplier applied when two names overlap *only* on sector vocabulary ("FUEL",
 * "RESTAURANT"). Half a fleet's statement contains the word FUEL, so that overlap is
 * close to no evidence at all — but not quite none, which is why this is a heavy discount
 * rather than a zero.
 */
export const GENERIC_ONLY_PENALTY = 0.4;
