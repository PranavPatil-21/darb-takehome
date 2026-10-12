import Link from 'next/link';
import { formatMinorUnits } from '@/lib/format';
import { modulePath } from '@/lib/platform/module-config';
import { TRANSACTION_STATUS, type TransactionDocumentationStatus } from '@/lib/platform/transaction-status';
import type { StatusBreakdown } from '@/lib/platform/dashboard';
import { t } from '@/lib/content/messages';

/**
 * Where the period's money sits, by documentation status.
 *
 * A single proportional bar rather than four cards, because the question is what share of
 * the spend each state holds — and a reader answers that from relative width instantly and
 * from four numbers only after doing arithmetic.
 *
 * It is drawn in **value**, not count. Ten documented coffees beside one undocumented fuel
 * card run is a reassuring picture and a false one; the bar has to show that most of the
 * money is in the one segment, which a count-based bar would hide.
 *
 * Hand-drawn with flex widths: no chart library, and nothing here needs one.
 */

const SEGMENT_TONE: Record<TransactionDocumentationStatus, string> = {
  DOCUMENTED: 'bg-emerald-500',
  IN_REVIEW: 'bg-amber-500',
  REJECTED: 'bg-rose-500',
  MISSING: 'bg-slate-300 dark:bg-slate-600',
};

export function StatusBar({ breakdown }: { breakdown: StatusBreakdown[] }) {
  const total = breakdown.reduce((sum, row) => sum + row.value, 0);
  if (total === 0) return null;

  const present = breakdown.filter((row) => row.value > 0);

  return (
    <section className="mt-10">
      <h2 className="text-sm font-medium">{t('overview.spend.title')}</h2>
      <p className="mt-0.5 text-xs text-muted-foreground">{t('overview.spend.hint')}</p>

      <div
        className="mt-3 flex h-2.5 w-full overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={present
          .map((row) => `${TRANSACTION_STATUS[row.status].label}: ${formatMinorUnits(row.value)}`)
          .join(', ')}
      >
        {present.map((row) => (
          <div
            key={row.status}
            className={SEGMENT_TONE[row.status]}
            style={{ width: `${(row.value / total) * 100}%` }}
          />
        ))}
      </div>

      <ul className="mt-4 grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-4">
        {breakdown.map((row) => (
          <li key={row.status}>
            <Link
              href={`${modulePath('transactions')}?status=${row.status}`}
              className="group block rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="flex items-center gap-2">
                <span
                  aria-hidden
                  className={`size-2 shrink-0 rounded-full ${SEGMENT_TONE[row.status]}`}
                />
                <span className="text-xs text-muted-foreground group-hover:text-foreground">
                  {TRANSACTION_STATUS[row.status].label}
                </span>
              </span>
              <span className="mt-0.5 block text-sm tabular-nums">
                {formatMinorUnits(row.value)}
              </span>
              <span className="block text-xs text-muted-foreground tabular-nums">
                {row.count} {row.count === 1 ? 'charge' : 'charges'}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
