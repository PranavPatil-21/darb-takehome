import type { DocumentStatus, MatchStatus } from '@/lib/domain/enums';
import { CONFIRMED_MATCH_STATUSES } from '@/lib/domain/enums';

/**
 * Where a document stands, derived from its matches.
 *
 * This is the document-side counterpart of `documentationStatusOf`, and it exists for the
 * reason that function's history records: a status column written by hand from several
 * call sites is a column that drifts. `Document.status` was exactly that — written from
 * six places, with no single definition of what it should be — and it drifted. Rejecting
 * a runner-up candidate on a document that still held a confirmed match reported the
 * receipt as `UNMATCHED` while a charge still carried it as evidence, because the count
 * driving that decision only looked at `CANDIDATE` rows.
 *
 * One pure function, no I/O, total over its inputs. The rule in one place means there is
 * no second copy to disagree with.
 */

export interface DocumentStatusInputs {
  /**
   * What the document says about itself today.
   *
   * Needed because two states are *not* derivable from matches: a document whose
   * extraction failed is terminally `FAILED` however its matches look, and a document
   * that has not reached matching yet is `RECEIVED`/`EXTRACTED` rather than unmatched.
   */
  currentStatus: DocumentStatus;
  matches: readonly { status: MatchStatus }[];
}

/** Statuses that mean matching has not run yet, so match counts say nothing. */
const PRE_MATCH_STATUSES: readonly DocumentStatus[] = ['RECEIVED', 'EXTRACTED'];

export function documentStatusOf({ currentStatus, matches }: DocumentStatusInputs): DocumentStatus {
  // Terminal. An unreadable scan does not become matchable because a match row exists.
  if (currentStatus === 'FAILED') return 'FAILED';

  // Nothing has been proposed yet; the document is still moving through the pipeline.
  if (matches.length === 0 && PRE_MATCH_STATUSES.includes(currentStatus)) return currentStatus;

  // A confirmed match outranks everything else: the document is evidence for a charge,
  // whatever its other candidates were decided to be.
  if (matches.some((m) => CONFIRMED_MATCH_STATUSES.includes(m.status))) return 'MATCHED';

  if (matches.some((m) => m.status === 'CANDIDATE')) return 'NEEDS_REVIEW';

  // Every candidate ruled out, or none ever found. Either way a later transaction can
  // still rescue this document through the re-match sweep, so `UNMATCHED`, not `FAILED`.
  return 'UNMATCHED';
}

/**
 * The document's `failureReason` after a status recompute.
 *
 * The column carries two different meanings, which is why this is not a one-liner:
 *
 *  - on an `UNMATCHED` row it says *why nothing matched* — and if candidates existed and
 *    were all ruled out, that fact is the reason;
 *  - on a `NEEDS_REVIEW` row it says *why a person is looking* — the matcher's reason
 *    code, which the work queue groups by and the reviewer reads as the headline.
 *
 * Treating it as the first meaning only — nulling it for every other status — stripped
 * the matcher's reason off a document the moment anyone rejected one of its candidates.
 * The document stayed in review with no explanation, and the queue silently moved it to
 * the fallback kind, so a `CHOOSE_CHARGE` item became a `CHECK_FIGURES` one because
 * somebody acted on it.
 */
export function documentFailureReasonOf(
  status: DocumentStatus,
  matches: readonly { status: MatchStatus }[],
  currentReason: string | null = null,
): string | null {
  if (status === 'UNMATCHED') {
    return matches.length > 0 ? 'ALL_CANDIDATES_REJECTED' : currentReason;
  }
  // Settled. Nothing is outstanding, so there is nothing to explain.
  if (status === 'MATCHED') return null;

  // Still in review, or terminal: whatever the matcher or the extractor said stands.
  return currentReason;
}
