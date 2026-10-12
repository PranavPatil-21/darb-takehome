import Link from 'next/link';
import { formatMinorUnits, formatPercent } from '@/lib/format';
import { modulePath } from '@/lib/platform/module-config';
import type { DashboardData } from '@/lib/platform/dashboard';

/**
 * The headline: how exposed is this period, and whose desk is the work on.
 *
 * Deliberately one figure with its supporting line, rather than four equal tiles. Four
 * tiles say everything is equally important, and the reader has to decide what to care
 * about before they can start; one headline says what matters and lets the rest support
 * it. The two desks beneath are routes into work, not statistics — they are counts
 * precisely because a person has to go and do them.
 */
export function ExposureSummary({ data }: { data: DashboardData }) {
  const { period, undocumentedSpend, undocumentedCount, chargeCount } = {
    ...data,
    undocumentedCount: data.byStatus
      .filter((s) => s.status !== 'DOCUMENTED')
      .reduce((n, s) => n + s.count, 0),
  };

  if (chargeCount === 0) {
    return (
      <section>
        <h1 className="text-sm font-medium text-muted-foreground">Receipt coverage</h1>
        <p className="mt-2 text-2xl font-semibold tracking-tight">No charges loaded yet</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Card transactions arrive through <code className="text-xs">POST /api/transactions</code>.
        </p>
      </section>
    );
  }

  const clear = undocumentedCount === 0;

  return (
    <section>
      <h1 className="text-sm font-medium text-muted-foreground">
        Receipt coverage{period ? ` · ${period.label}` : ''}
      </h1>

      {clear ? (
        <p className="mt-2 text-3xl font-semibold tracking-tight">Every charge has a receipt</p>
      ) : (
        <>
          <p className="mt-2 text-3xl font-semibold tracking-tight tabular-nums">
            {formatMinorUnits(undocumentedSpend)} unsupported
          </p>
          <p className="mt-1.5 text-sm text-muted-foreground tabular-nums">
            {undocumentedCount} of {chargeCount} charges · {formatPercent(data.coverageByValue)} of
            spend is covered · {formatMinorUnits(data.vatAtRisk)} of input VAT rests on it
          </p>
        </>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Desk
          href={modulePath('review')}
          count={data.awaitingDecision}
          singular="document needs a decision"
          plural="documents need a decision"
          primary
        />
        <Desk
          href={modulePath('assurance')}
          count={data.awaitingVerification}
          singular="attachment needs sign-off"
          plural="attachments need sign-off"
        />
        <Desk
          href={modulePath('exceptions')}
          count={data.exceptions}
          singular="exception"
          plural="exceptions"
        />
      </div>
    </section>
  );
}

/**
 * A pile of work, or silence.
 *
 * An empty desk renders nothing at all rather than a zero. A dashboard full of zeroes
 * trains the reader to skip the row, and then the one that is not zero gets skipped too.
 */
function Desk({
  href,
  count,
  singular,
  plural,
  primary = false,
}: {
  href: string;
  count: number;
  singular: string;
  plural: string;
  primary?: boolean;
}) {
  if (count === 0) return null;

  return (
    <Link
      href={href}
      className={
        primary
          ? 'inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
          : 'inline-flex h-10 items-center rounded-md border px-4 text-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
      }
    >
      {count} {count === 1 ? singular : plural}
    </Link>
  );
}
