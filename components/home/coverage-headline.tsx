import Link from 'next/link';
import { formatMinorUnits, formatPercent } from '@/lib/format';
import type { CoveragePosition } from '@/lib/ui/coverage';

/**
 * The compliance position, in money.
 *
 * The page this replaced opened with "Documents ingested: 18" — a number that goes up
 * whether or not anything is wrong, and which nobody outside the engineering team has a
 * use for. The operator's question is how much of this period's card spend has no receipt
 * behind it, because that is what an auditor asks and what the VAT filing depends on.
 *
 * Deliberately plain text rather than a gauge or a progress ring. The number is small
 * enough to read and large enough to matter; decorating it with a meter would add a
 * second, less precise encoding of the same fact.
 */
export function CoverageHeadline({ position }: { position: CoveragePosition }) {
  const { period, undocumentedSpend, undocumentedCount, chargeCount, vatAtRisk } = position;

  if (chargeCount === 0) {
    return (
      <section>
        <h1 className="text-xl font-semibold tracking-tight">Receipt coverage</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          No card charges have been loaded yet.
        </p>
      </section>
    );
  }

  const allCovered = undocumentedCount === 0;

  return (
    <section>
      <h1 className="text-sm font-medium text-muted-foreground">
        Receipt coverage{period ? ` · ${period.label}` : ''}
      </h1>

      {allCovered ? (
        <p className="mt-2 text-3xl font-semibold tracking-tight">
          Every charge has a receipt
        </p>
      ) : (
        <>
          <p className="mt-2 text-3xl font-semibold tracking-tight tabular-nums">
            {formatMinorUnits(undocumentedSpend)} has no receipt
          </p>
          <p className="mt-1.5 text-sm text-muted-foreground tabular-nums">
            {undocumentedCount} of {chargeCount} charges ·{' '}
            {formatPercent(position.coverageByValue)} of spend is covered ·{' '}
            {formatMinorUnits(vatAtRisk)} of input VAT sits on undocumented spend
          </p>
        </>
      )}

      <WorkDoorways position={position} />
    </section>
  );
}

/**
 * The two piles of outstanding work, which need different actions from different people.
 *
 * Collapsing them into one "outstanding" figure would hide the only useful distinction:
 * one pile is a person's queue, the other resolves itself when the acquirer posts the
 * charge and needs nobody at all.
 */
function WorkDoorways({ position }: { position: CoveragePosition }) {
  const { awaitingDecision, awaitingCharge } = position;

  return (
    <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-2">
      {awaitingDecision > 0 ? (
        <Link
          href="/review"
          className="inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          Review {awaitingDecision} {awaitingDecision === 1 ? 'document' : 'documents'}
        </Link>
      ) : (
        <p className="text-sm text-muted-foreground">Nothing is waiting on a decision.</p>
      )}

      {awaitingCharge > 0 ? (
        <p className="text-sm text-muted-foreground">
          {awaitingCharge} {awaitingCharge === 1 ? 'receipt is' : 'receipts are'} waiting for a
          charge to post — these retry automatically.
        </p>
      ) : null}
    </div>
  );
}
