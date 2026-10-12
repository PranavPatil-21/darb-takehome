import { cn } from '@/lib/utils';
import { decodeSignals } from '@/lib/domain/enums';
import { formatDay, formatMinorUnits, formatPercent, formatTime } from '@/lib/format';
import { buildComparison, type ComparisonRow } from '@/lib/ui/comparison';
import { ComparisonTable } from '@/components/review/comparison-table';
import { EngineDisclosure } from '@/components/review/engine-disclosure';
import { MatchActions } from '@/components/review/match-actions';

/**
 * One charge this receipt might belong to, and everything needed to decide.
 *
 * The ranking numeral and the confidence percentage both stay: the brief asks for ranked
 * candidates, and removing the number would read as hiding the matcher rather than
 * improving on it. What changes is which of them leads. The comparison is the evidence;
 * the percentage is a summary of it, so the percentage sits quietly to the right while
 * the field-by-field diff takes the width.
 */

export interface CandidateCharge {
  matchId: number;
  confidence: number;
  signals: string;
  merchantName: string;
  amount: number;
  currency: string;
  transactionAt: Date;
  cardLast4: string;
}

export interface CandidateDocument {
  merchantName: string | null;
  totalAmount: number | null;
  currency: string | null;
  documentDate: Date | null;
  cardLast4: string | null;
}

/**
 * Dates travel through `ComparisonRow` as ISO strings so the comparison module can stay
 * pure; they become Riyadh-time text here, at the edge, where formatting belongs.
 *
 * A receipt carries a *date*, not a timestamp — "Date: 05/06/2025" with no clock — and
 * the extractor stores that as midnight UTC. Rendering it alongside the charge's real
 * time produces a precise-looking "03:00" that appears nowhere on the paper and invites
 * a reviewer to compare two times, one of which is an artefact of storage. So a value
 * sitting exactly on midnight UTC is shown as a day, and only a real time is printed as
 * one.
 */
function presentValue(row: ComparisonRow, value: string): string {
  if (row.field !== 'date') return value;
  const dateOnly = value.endsWith('T00:00:00.000Z');
  return dateOnly ? formatDay(value) : `${formatDay(value)} · ${formatTime(value)}`;
}

export function CandidateCard({
  candidate,
  document,
  rank,
  /** Suppressed when the engine itself could not separate the candidates. */
  showRank,
  documentId,
}: {
  candidate: CandidateCharge;
  document: CandidateDocument;
  rank: number;
  showRank: boolean;
  documentId: number;
}) {
  const rows = buildComparison(document, candidate);

  const chargeLabel = `${formatMinorUnits(candidate.amount, candidate.currency)} at ${
    candidate.merchantName
  }, ${formatDay(candidate.transactionAt)} ${formatTime(candidate.transactionAt)}`;

  return (
    <article
      className={cn(
        'rounded-lg border bg-card p-4',
        // The leading candidate is lifted only when leading means something. On an
        // ambiguous document the engine declined to choose, and emphasising one of two
        // indistinguishable charges is the interface placing a bet with someone's money.
        showRank && rank === 1 && 'border-foreground/15 shadow-sm',
      )}
    >
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <h4 className="flex items-baseline gap-2 text-base font-medium">
            {showRank ? (
              <span className="text-xs text-muted-foreground tabular-nums">{rank}</span>
            ) : null}
            <span className="truncate">{candidate.merchantName}</span>
          </h4>
          <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
            {formatDay(candidate.transactionAt)} · {formatTime(candidate.transactionAt)} · card
            ••••{candidate.cardLast4}
          </p>
        </div>

        <p className="text-sm tabular-nums text-muted-foreground">
          {formatPercent(candidate.confidence)} match
        </p>
      </header>

      <div className="mt-3">
        <ComparisonTable rows={rows} formatValue={presentValue} />
      </div>

      <EngineDisclosure signals={decodeSignals(candidate.signals)} />

      <div className="mt-4 flex justify-end">
        <MatchActions
          matchId={candidate.matchId}
          documentId={documentId}
          chargeLabel={chargeLabel}
        />
      </div>
    </article>
  );
}
