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
  /** Passed through so the date verdict uses the engine's window for this document type. */
  documentType: string | null;
  source: string | null;
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
}: {
  candidate: CandidateCharge;
  document: CandidateDocument;
  rank: number;
  showRank: boolean;
}) {
  const rows = buildComparison(document, candidate);

  const chargeLabel = `${formatMinorUnits(candidate.amount, candidate.currency)} at ${
    candidate.merchantName
  }, ${formatDay(candidate.transactionAt)} ${formatTime(candidate.transactionAt)}`;

  return (
    <article
      className={cn(
        'overflow-hidden rounded-xl border bg-card shadow-xs',
        // The leading candidate is lifted only when leading means something. On an
        // ambiguous document the engine declined to choose, and emphasising one of two
        // indistinguishable charges is the interface placing a bet with someone's money.
        showRank && rank === 1 && 'border-foreground/20 shadow-sm',
      )}
    >
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 border-b bg-surface-sunken px-5 py-3.5">
        <div className="min-w-0 flex-1">
          <h4 className="flex items-baseline gap-2 text-sm font-semibold">
            {showRank ? (
              <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-md bg-card text-[11px] font-medium tabular-nums text-muted-foreground ring-1 ring-inset ring-border">
                {rank}
              </span>
            ) : null}
            <span className="min-w-0 truncate">{candidate.merchantName}</span>
          </h4>
          <p className="mt-1 text-xs text-muted-foreground tabular-nums">
            {formatDay(candidate.transactionAt)} · {formatTime(candidate.transactionAt)} · card
            ••••{candidate.cardLast4}
          </p>
        </div>

        <p className="shrink-0 text-xs font-medium tabular-nums text-muted-foreground">
          {formatPercent(candidate.confidence)} match
        </p>
      </header>

      <div className="px-5 py-4">
        <ComparisonTable rows={rows} formatValue={presentValue} />
        <EngineDisclosure signals={decodeSignals(candidate.signals)} />
      </div>

      {/* The decision sits in its own footer band, pinned to the bottom of the charge it
          decides. Floating it in the body made it ambiguous which of two stacked
          candidates a button belonged to. */}
      <div className="flex justify-end border-t bg-surface-sunken px-5 py-3">
        <MatchActions
          matchId={candidate.matchId}
          chargeLabel={chargeLabel}
        />
      </div>
    </article>
  );
}
