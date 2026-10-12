import { formatDay, formatMinorUnits } from '@/lib/format';
import type { UndocumentedCharge } from '@/lib/ui/coverage';

/**
 * The charges still missing a receipt, largest first.
 *
 * This is the worklist behind the headline figure: the headline says how much is exposed,
 * this says which specific spending it is, so someone can go and chase it. Ordered by
 * value rather than recency because chasing the largest missing receipt removes the most
 * exposure per phone call.
 *
 * The driver is shown because the next action is almost always to ask a person for a
 * photo, and "card ••••4412" does not tell you whose pocket to look in.
 */
export function UndocumentedCharges({
  charges,
  totalCount,
}: {
  charges: UndocumentedCharge[];
  totalCount: number;
}) {
  if (charges.length === 0) return null;

  const remaining = totalCount - charges.length;

  return (
    <section className="mt-10">
      <h2 className="text-sm font-medium">Charges with no receipt</h2>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Largest first — chasing these removes the most exposure.
      </p>

      <ul className="mt-3 divide-y divide-border/60 border-y border-border/60">
        {charges.map((charge) => (
          <li
            key={charge.id}
            className="flex items-baseline justify-between gap-4 py-2.5"
          >
            <span className="min-w-0 truncate text-sm">{charge.merchantName}</span>

            <span className="flex shrink-0 items-baseline gap-4 tabular-nums">
              <span className="text-sm">{formatMinorUnits(charge.amount, charge.currency)}</span>
              <span className="hidden w-32 text-right text-xs text-muted-foreground sm:inline">
                {formatDay(charge.transactionAt)}
              </span>
              <span className="hidden w-16 text-right text-xs text-muted-foreground sm:inline">
                ••••{charge.cardLast4}
              </span>
            </span>
          </li>
        ))}
      </ul>

      {/* Never truncate silently: a worklist that quietly stops at eight reads as a
          complete list, and the reader would close the page believing they had seen
          everything that is missing. */}
      {remaining > 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          and {remaining} smaller {remaining === 1 ? 'charge' : 'charges'}.
        </p>
      ) : null}
    </section>
  );
}
