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

/**
 * Tone by band — but only when the band holds something.
 *
 * These were applied unconditionally, so "1 to 2 months" and "Over 2 months" rendered in
 * amber and red beside `0.00 SAR` and a count of zero. An alarm colour on an empty bucket
 * is the interface crying wolf: a reader scanning for red finds it where there is nothing
 * wrong, and learns to discount it where there is.
 */
const BUCKET_TONE: Record<AgeBucket, string> = {
  '0-7': 'text-foreground',
  '8-30': 'text-foreground',
  '31-60': 'text-attention-foreground',
  '60+': 'text-destructive',
};

const BUCKET_BAR: Record<AgeBucket, string> = {
  '0-7': 'bg-foreground/25',
  '8-30': 'bg-foreground/40',
  '31-60': 'bg-attention-border',
  '60+': 'bg-destructive',
};

export function AgeingTable({ rows }: { rows: AgeingRow[] }) {
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  if (total === 0) return null;

  const widest = Math.max(...rows.map((row) => row.value), 1);

  return (
    <section className="mt-10">
      <h2 className="text-base font-semibold tracking-[-0.006em]">{t('overview.ageing.title')}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t('overview.ageing.hint')}</p>

      <ul className="mt-4 divide-y overflow-hidden rounded-xl border bg-card shadow-xs">
        {rows.map((row) => {
          const empty = row.count === 0;

          return (
            <li key={row.bucket}>
              <Link
                href={`${modulePath('transactions')}?age=${encodeURIComponent(row.bucket)}`}
                className="group grid grid-cols-[8rem_minmax(0,1fr)_7.5rem_3rem] items-center gap-4 px-5 py-3 transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <span
                  className={`text-sm ${empty ? 'text-muted-foreground' : BUCKET_TONE[row.bucket]}`}
                >
                  {AGE_BUCKET_LABEL[row.bucket]}
                </span>

                {/* A bar rather than a second number: the comparison between bands is the
                    information, and relative length carries it without being read. */}
                <span className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <span
                    className={`block h-full rounded-full ${BUCKET_BAR[row.bucket]}`}
                    style={{
                      width: `${row.value === 0 ? 0 : Math.max(3, (row.value / widest) * 100)}%`,
                    }}
                  />
                </span>

                {/* Fixed-width columns so the money and the count form two straight
                    edges. Right-aligning a value against a flexible column left them
                    ragged, which is the thing that makes a figure column hard to scan. */}
                <span
                  className={`text-right text-sm tabular-nums ${empty ? 'text-muted-foreground' : ''}`}
                >
                  {formatMinorUnits(row.value)}
                </span>
                <span className="text-right text-xs tabular-nums text-muted-foreground">
                  {row.count}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
