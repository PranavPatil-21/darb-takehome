import { formatDay, formatMinorUnits, formatTime } from '@/lib/format';
import { merchantSimilarity } from '@/lib/matching/merchant';
import { chargeDifferencesAcross, type ComparableCharge } from '@/lib/ui/comparison';
import { t } from '@/lib/content/messages';

/**
 * What separates the charges competing for one document.
 *
 * Shown whenever more than one charge is in play — not only when the engine called the
 * result ambiguous. A reviewer looking at two candidates has the same question regardless
 * of which reason code brought them here: *what is actually different between these?*
 *
 * The useful move is the opposite of the scores above it: stop repeating what matches and
 * name only what differs, so the reviewer knows the specific thing to go and check against
 * the paper receipt. When that list is empty, nothing in the data separates them, and the
 * interface says so — presenting a coin flip on money with two confident-looking
 * percentages beside it is how a wrong attachment gets made and then looks reviewed.
 *
 * Every competing charge is listed. An earlier version compared only the first two, so a
 * third tied outlet of the same chain vanished from the one screen meant to show them all.
 */

function list(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

export function CandidateComparison({
  charges,
  tied,
}: {
  charges: ComparableCharge[];
  /** True when the engine could not separate them on score either. */
  tied: boolean;
}) {
  if (charges.length < 2) return null;

  const differences = chargeDifferencesAcross(charges, merchantSimilarity);

  return (
    <section className="overflow-hidden rounded-xl border bg-card shadow-xs">
      <h3 className="border-b bg-surface-sunken px-5 py-2.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {/* Derived from the actual situation rather than fixed: how many charges there
            are, and whether their scores genuinely tie. */}
        {tied
          ? t('ambiguity.title.tied', { count: charges.length })
          : t('ambiguity.title.competing', { count: charges.length })}
      </h3>

      <p className="px-5 pt-4 text-sm leading-relaxed text-muted-foreground">
        {differences.length === 0
          ? t('ambiguity.identical')
          : t(tied ? 'ambiguity.differs.tied' : 'ambiguity.differs', {
              fields: list(differences.map((d) => d.phrase)),
            })}
      </p>

      {/* One row per competing charge, not a grid. They are being compared, and a reader
          compares a column of values far more easily than a wrapped grid of cards. */}
      <dl className="mt-4 divide-y border-t text-xs">
        {charges.map((charge, index) => (
          <div
            key={index}
            className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-5 py-2.5"
          >
            <dt className="min-w-0 truncate font-medium">{charge.merchantName}</dt>
            <dd className="shrink-0 tabular-nums text-muted-foreground">
              {formatMinorUnits(charge.amount, charge.currency)} · {formatDay(charge.transactionAt)}{' '}
              · {formatTime(charge.transactionAt)} · card ••••{charge.cardLast4}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
