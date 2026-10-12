import { t } from '@/lib/content/messages';
import { moduleConfig } from '@/lib/platform/module-config';

/**
 * Maker-checker: who gets a second pair of eyes, and why.
 *
 * The maker's act in this product is *the attachment of one specific document to one
 * specific charge* — `confirmMatch` for a person, the auto-match path for the engine. The
 * checker's act is confirming, afterwards, that the attachment was right.
 *
 * Three decisions shape this, and they are the ones worth arguing about.
 *
 * **It is post-hoc, not blocking, by default.** A blocking gate puts a human round-trip in
 * front of money that has already been spent. It would double the length of the only
 * screen in the product that produces value, and a control that halves throughput is a
 * control that gets switched off within a month — after which the material attachments
 * are unverified along with the trivial ones. Post-hoc sampling keeps the queue moving
 * and still produces the evidence an auditor wants: that somebody independent looked.
 *
 * **It is risk-based, not blanket.** Four-eyes on every attachment is four-eyes on
 * nothing, because nobody can sustain it. Materiality carries the expensive path; a
 * sample rate covers the rest so that "under the threshold" does not quietly become a
 * known blind spot.
 *
 * **Automatic matches are the real gap.** A human confirmation has already had one pair
 * of eyes on it. An auto-match has had none — the engine decided, the document went
 * straight to MATCHED, and in a working deployment that is most of the volume. If only
 * one thing here is verified, it should be those.
 *
 * The functions below are pure and take their inputs explicitly, including the random
 * draw, so that sampling is testable and so no caller can accidentally re-roll it.
 */

export interface VerificationInput {
  /** Minor units. */
  amount: number;
  /** True when the engine attached this with no human involved. */
  automatic: boolean;
  /**
   * A draw in [0, 1). Supplied by the caller rather than taken from `Math.random()` here,
   * because this function is called inside the ingestion transaction and must stay pure
   * and reproducible in tests.
   */
  draw: number;
}

export type VerificationTrigger =
  | 'MATERIAL'
  | 'AUTOMATIC'
  | 'SAMPLED'
  | 'NOT_REQUIRED';

export interface VerificationDecision {
  required: boolean;
  trigger: VerificationTrigger;
  /** Shown to the checker so they know why this landed on their desk. */
  reason: string;
}

export function decideVerification(input: VerificationInput): VerificationDecision {
  const { makerChecker } = moduleConfig();

  if (makerChecker.mode === 'OFF') {
    return {
      required: false,
      trigger: 'NOT_REQUIRED',
      reason: t('verify.off'),
    };
  }

  // Order is a priority, not a sequence of independent tests: an attachment can satisfy
  // several triggers and the checker should be told the strongest reason it is here.
  if (input.amount >= makerChecker.materialityThreshold) {
    return {
      required: true,
      trigger: 'MATERIAL',
      reason: t('verify.material'),
    };
  }

  if (input.automatic && makerChecker.verifyAutoMatches) {
    return {
      required: true,
      trigger: 'AUTOMATIC',
      reason: t('verify.automatic'),
    };
  }

  if (input.draw < makerChecker.sampleRate) {
    return {
      required: true,
      trigger: 'SAMPLED',
      reason: t('verify.sampled'),
    };
  }

  return {
    required: false,
    trigger: 'NOT_REQUIRED',
    reason: t('verify.notRequired'),
  };
}

/**
 * Whether this actor may sign off this attachment.
 *
 * The segregation rule, stated once. A maker cannot check their own work — that is the
 * entire control, and enforcing it anywhere other than in one function invites a second
 * call site that forgets. The `system` actor is not special-cased: an automatic match has
 * no human maker, so any checker is independent of it.
 */
export function canVerify(options: {
  verifierId: string;
  makerId: string | null;
}): { allowed: boolean; reason: string } {
  if (options.makerId !== null && options.makerId === options.verifierId) {
    return {
      allowed: false,
      reason: t('verify.ownWork'),
    };
  }

  return { allowed: true, reason: '' };
}

export const TRIGGER_COPY: Readonly<Record<VerificationTrigger, string>> = {
  get MATERIAL() { return t('trigger.MATERIAL'); },
  get AUTOMATIC() { return t('trigger.AUTOMATIC'); },
  get SAMPLED() { return t('trigger.SAMPLED'); },
  get NOT_REQUIRED() { return t('trigger.NOT_REQUIRED'); },
};
