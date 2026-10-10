/**
 * Every tunable number the matcher uses, in one place with the reasoning attached.
 *
 * These are deliberately constants rather than magic numbers scattered through the
 * scoring code: a reviewer tuning the engine should be able to read this file alone,
 * and a future change to a threshold should show up as a one-line diff here.
 *
 * Justification for each value is in IMPLEMENTATION.md § "Scoring design".
 */

/** Base signal weights. Renormalised at scoring time over whichever signals are present. */
export const SIGNAL_WEIGHTS = {
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
} as const satisfies Record<string, number>;

export type SignalName = keyof typeof SIGNAL_WEIGHTS;

/**
 * Amounts are integer minor units (halalas), so there is no floating-point epsilon to
 * worry about — only genuine business tolerance.
 */

/** VAT rounding drift is symmetric and tiny: at most a halala or two either way. */
export const VAT_ROUNDING_TOLERANCE_HALALAS = 5;

/**
 * Tips and service charges are *directional*: the card is charged MORE than the printed
 * receipt total, never less. Scoring this asymmetrically is the single highest-value
 * refinement in the amount signal — it lets a 10% tip stay a plausible candidate while
 * a transaction 10% *below* its receipt stays implausible.
 */
export const MAX_TIP_RATIO = 0.25;

/** A card charged slightly less than the receipt total (split bill, partial capture). */
export const MAX_UNDERCHARGE_RATIO = 0.02;

/**
 * Documents arrive late — a driver clears their camera roll on Sunday. Beyond a week
 * the date stops being evidence and the candidate is vetoed outright.
 */
export const MAX_DATE_DRIFT_DAYS = 7;

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
