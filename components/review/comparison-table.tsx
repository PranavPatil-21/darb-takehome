import { cn } from '@/lib/utils';
import type { ComparisonRow, ComparisonVerdict } from '@/lib/ui/comparison';

/**
 * The document beside the charge, field by field.
 *
 * This replaces four coloured bars as the primary evidence. A bar says the amount scored
 * 0.74; it does not say that the receipt reads 57.50 and the card was charged 63.25,
 * which is the only form in which a human can actually judge the thing. The two value
 * columns share a baseline and use tabular figures so the eye catches a difference
 * before it reads a word — which is the entire reason this is a grid and not prose.
 */

const VERDICT_MARK: Record<ComparisonVerdict, string> = {
  AGREES: '=',
  CLOSE: '≈',
  DIFFERS: '≠',
  NOT_ON_DOCUMENT: '–',
};

const VERDICT_TONE: Record<ComparisonVerdict, string> = {
  AGREES: 'text-emerald-700 dark:text-emerald-400',
  CLOSE: 'text-muted-foreground',
  DIFFERS: 'text-amber-700 dark:text-amber-400',
  NOT_ON_DOCUMENT: 'text-muted-foreground',
};

export function ComparisonTable({
  rows,
  formatValue,
}: {
  rows: ComparisonRow[];
  /** Dates arrive as ISO strings so this component stays free of date formatting. */
  formatValue: (row: ComparisonRow, value: string) => string;
}) {
  return (
    <dl className="divide-y divide-border/60">
      {/* Column headings, stated once. Without them the two value columns are just two
          numbers and the reader has to infer which side is which — every single row. */}
      <div className="grid grid-cols-2 gap-x-3 pb-1.5 text-xs text-muted-foreground sm:grid-cols-[5.5rem_1fr_1fr]">
        <span className="hidden sm:block" />
        <span>Receipt</span>
        <span>Charge</span>
      </div>

      {rows.map((row) => {
        const missing = row.verdict === 'NOT_ON_DOCUMENT';

        return (
          <div
            key={row.field}
            className="grid grid-cols-2 gap-x-3 py-2 sm:grid-cols-[5.5rem_1fr_1fr]"
          >
            {/* Below `sm` the label takes its own row: three columns inside a phone
                viewport forces the two values into two or three lines each, which
                destroys the baseline alignment that makes the diff readable at a
                glance. */}
            <dt className="col-span-2 text-xs leading-6 text-muted-foreground sm:col-span-1">
              {row.label}
            </dt>

            <dd
              className={cn(
                'min-w-0 break-words text-sm leading-6 tabular-nums',
                missing && 'text-muted-foreground italic',
              )}
            >
              {row.documentValue === null
                ? 'not on receipt'
                : formatValue(row, row.documentValue)}
            </dd>

            <dd className="flex min-w-0 items-baseline gap-2 text-sm leading-6 tabular-nums">
              <span className="break-words">{formatValue(row, row.chargeValue)}</span>
              <span
                aria-hidden
                className={cn('text-xs leading-6', VERDICT_TONE[row.verdict])}
                title={row.verdict.toLowerCase()}
              >
                {VERDICT_MARK[row.verdict]}
              </span>
            </dd>

            {/* The sentence appears only where it adds something the two values do not
                already say. A note under every row would be noise and would train the
                reader to skip the one row that matters. */}
            {row.note ? (
              <p className="col-span-2 mt-0.5 text-xs text-muted-foreground sm:col-start-2">
                {row.note}
              </p>
            ) : null}
          </div>
        );
      })}
    </dl>
  );
}
