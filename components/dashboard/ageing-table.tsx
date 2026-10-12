import Link from 'next/link';
import { formatMinorUnits } from '@/lib/format';
import { modulePath } from '@/lib/platform/module-config';
import { AGE_BUCKET_LABEL, type AgeBucket } from '@/lib/platform/transaction-status';
import type { AgeingRow } from '@/lib/platform/dashboard';
import { t } from '@/lib/content/messages';

/**
 * How long the gap has been open.
 *
 * Coverage alone says how much is unsupported; it does not say whether that is this
 * week's normal lag or a problem that has been quietly compounding since April. The same
 * figure means opposite things in those two cases, and only ageing separates them.
 *
 * The oldest band is given the warning tone because it is the one that will still be open
 * at the filing deadline — a charge nobody has chased in two months is not going to
 * resolve itself.
 */

const BUCKET_TONE: Record<AgeBucket, string> = {
  '0-7': 'text-muted-foreground',
  '8-30': 'text-muted-foreground',
  '31-60': 'text-amber-700 dark:text-amber-400',
  '60+': 'text-rose-700 dark:text-rose-400',
};

export function AgeingTable({ rows }: { rows: AgeingRow[] }) {
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  if (total === 0) return null;

  const widest = Math.max(...rows.map((row) => row.value), 1);

  return (
    <section className="mt-10">
      <h2 className="text-sm font-medium">{t('overview.ageing.title')}</h2>
      <p className="mt-0.5 text-xs text-muted-foreground">{t('overview.ageing.hint')}</p>

      <ul className="mt-3 divide-y divide-border/60 border-y border-border/60">
        {rows.map((row) => (
          <li key={row.bucket} className="py-2.5">
            <Link
              href={`${modulePath('transactions')}?age=${encodeURIComponent(row.bucket)}`}
              className="group grid grid-cols-[9rem_1fr_auto] items-center gap-3 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className={`text-sm ${BUCKET_TONE[row.bucket]}`}>
                {AGE_BUCKET_LABEL[row.bucket]}
              </span>

              {/* A bar rather than a second number: the comparison between bands is the
                  information, and relative length carries it without being read. */}
              <span className="h-1.5 overflow-hidden rounded-full bg-muted">
                <span
                  className={`block h-full rounded-full ${
                    row.bucket === '60+'
                      ? 'bg-rose-500'
                      : row.bucket === '31-60'
                        ? 'bg-amber-500'
                        : 'bg-slate-400'
                  }`}
                  style={{ width: `${Math.max(row.value === 0 ? 0 : 3, (row.value / widest) * 100)}%` }}
                />
              </span>

              <span className="text-right text-sm tabular-nums group-hover:text-foreground">
                {formatMinorUnits(row.value)}
                <span className="ml-2 text-xs text-muted-foreground">
                  {row.count}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
