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
  // The absence of a receipt is the default state, not an alarm — it gets the neutral
  // tone and lets the three decided states carry the colour.
  MISSING: 'bg-foreground/20',
};

export function StatusBar({ breakdown }: { breakdown: StatusBreakdown[] }) {
  const total = breakdown.reduce((sum, row) => sum + row.value, 0);
  if (total === 0) return null;

  const present = breakdown.filter((row) => row.value > 0);

  return (
    <section className="mt-10">
      <h2 className="text-base font-semibold tracking-[-0.006em]">{t('overview.spend.title')}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t('overview.spend.hint')}</p>

      <div
        className="mt-4 flex h-2.5 w-full overflow-hidden rounded-full bg-muted"
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

      {/* Four real tiles sharing one border, rather than four columns of text floating on
          the page. `gap-px` over a border-coloured background draws the dividers, so the
          group reads as one object divided rather than four things that happen to line
          up. */}
      <ul className="mt-5 grid gap-px overflow-hidden rounded-xl border bg-border shadow-xs sm:grid-cols-2 lg:grid-cols-4">
        {breakdown.map((row) => (
          <li key={row.status} className="bg-card">
            <Link
              href={`${modulePath('transactions')}?status=${row.status}`}
              className="group block px-4 py-3.5 transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <span className="flex items-center gap-2">
                <span
                  aria-hidden
                  className={`size-2 shrink-0 rounded-full ${SEGMENT_TONE[row.status]}`}
                />
                <span className="text-xs font-medium text-muted-foreground group-hover:text-foreground">
                  {TRANSACTION_STATUS[row.status].label}
                </span>
              </span>
              <span className="mt-2 block text-lg font-semibold tabular-nums tracking-[-0.011em]">
                {formatMinorUnits(row.value)}
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground tabular-nums">
                {row.count} {row.count === 1 ? 'charge' : 'charges'}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
