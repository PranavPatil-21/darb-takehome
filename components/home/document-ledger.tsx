import Link from 'next/link';
import { formatDay, formatMinorUnits, REASON_COPY } from '@/lib/format';
import { StatusPill } from '@/components/documents/status-pill';

/**
 * Every document and what became of it.
 *
 * This is what remains of the eight-column table that used to be the front page. It is
 * kept because "where did that invoice go?" is a real question and there was nowhere else
 * to answer it — but it is demoted to the bottom of the page and filtered by default to
 * the documents that did not simply attach themselves, because the settled ones generate
 * no work and reading past them is the whole problem with the table it replaces.
 */

export interface LedgerRow {
  id: number;
  merchantName: string | null;
  totalAmount: number | null;
  currency: string | null;
  documentDate: Date | null;
  status: string;
  failureReason: string | null;
}

export function DocumentLedger({
  rows,
  showingAll,
  hiddenCount,
}: {
  rows: LedgerRow[];
  showingAll: boolean;
  hiddenCount: number;
}) {
  return (
    <section className="mt-10">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium">
          {showingAll ? 'All documents' : 'Documents that need attention'}
        </h2>

        {showingAll ? (
          <Link
            href="/"
            className="text-xs text-muted-foreground underline underline-offset-4 hover:no-underline"
          >
            Hide attached
          </Link>
        ) : hiddenCount > 0 ? (
          <Link
            href="/?docs=all"
            className="text-xs text-muted-foreground underline underline-offset-4 hover:no-underline"
          >
            Show all {hiddenCount} attached
          </Link>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">
          Every document that arrived is attached to a charge.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-border/60 border-y border-border/60">
          {rows.map((row) => (
            <li key={row.id} className="py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <span className="truncate text-sm">
                  {row.merchantName ?? 'Unreadable document'}
                </span>

                <span className="flex items-center gap-3">
                  <span className="text-sm tabular-nums text-muted-foreground">
                    {formatMinorUnits(row.totalAmount, row.currency ?? 'SAR')}
                  </span>
                  <span className="hidden text-xs tabular-nums text-muted-foreground sm:inline">
                    {formatDay(row.documentDate)}
                  </span>
                  <StatusPill status={row.status} />
                </span>
              </div>

              {/* The reason sentence is the row's whole explanation — it is why this list
                  does not need a detail page behind it. */}
              {row.failureReason && row.status !== 'MATCHED' ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  {REASON_COPY[row.failureReason] ?? row.failureReason}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
