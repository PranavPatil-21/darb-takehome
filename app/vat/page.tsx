import { resolveActor } from '@/lib/platform/identity';
import { applyEnvironmentConfig } from '@/lib/platform/bootstrap';
import { getDashboard } from '@/lib/platform/dashboard';
import { formatPercent } from '@/lib/format';
import { ExposureSummary } from '@/components/dashboard/exposure-summary';
import { StatusBar } from '@/components/dashboard/status-bar';
import { AgeingTable } from '@/components/dashboard/ageing-table';

/**
 * The overview.
 *
 * Four questions, in the order a controller asks them: how exposed are we, where does the
 * money sit, how long has the gap been open, and is the automation still working. Nothing
 * on this page is here because it could be computed — every figure either changes what
 * somebody does next or is the one that detects a silent regression.
 */

export const dynamic = 'force-dynamic';

export default async function VatOverviewPage() {
  applyEnvironmentConfig();

  const actor = await resolveActor();
  // Passed in rather than read inside, so the whole page renders against one instant and
  // the ageing buckets cannot disagree with the coverage figure above them.
  const data = await getDashboard(actor, new Date());

  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-10">
      <ExposureSummary data={data} />
      <StatusBar breakdown={data.byStatus} />
      <AgeingTable rows={data.ageing} />
      <EnginePerformance data={data} />
    </main>
  );
}

/**
 * Whether the automation is still earning its place.
 *
 * The auto-attach rate is the number that detects the failure nobody else would notice:
 * an acquirer changes how it formats merchant names, similarity scores fall below the
 * threshold across the board, and the queue quietly fills with work the engine used to
 * do. Coverage would stay flat for weeks while the backlog built.
 */
function EnginePerformance({
  data,
}: {
  data: { autoAttached: number; documentsProcessed: number; autoAttachRate: number; oldestWaitingDays: number | null };
}) {
  if (data.documentsProcessed === 0) return null;

  return (
    <section className="mt-10 border-t pt-5">
      <h2 className="text-sm font-medium">Automation</h2>
      <p className="mt-1.5 text-sm text-muted-foreground tabular-nums">
        {data.autoAttached} of {data.documentsProcessed} documents attached without a person —{' '}
        {formatPercent(data.autoAttachRate)}.
        {data.oldestWaitingDays !== null ? (
          <>
            {' '}
            The longest-waiting document has been in the queue{' '}
            {data.oldestWaitingDays === 0
              ? 'less than a day'
              : `${data.oldestWaitingDays} ${data.oldestWaitingDays === 1 ? 'day' : 'days'}`}
            .
          </>
        ) : null}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        A sustained fall in this rate usually means an acquirer changed how it writes
        merchant names — the queue fills before coverage moves.
      </p>
    </section>
  );
}
