import { formatDay, formatMinorUnits, formatTime } from '@/lib/format';
import { merchantSimilarity } from '@/lib/matching/merchant';
import { chargeDifferences, type ComparableCharge } from '@/lib/ui/comparison';

/**
 * The hardest case in the product, stated honestly.
 *
 * When two charges tie on every signal, every bar reads 100% for both and the interface
 * has nothing left to say with scores — it is showing agreement to someone whose problem
 * is that everything agrees. The useful move is the opposite one: stop repeating what
 * matches and name only what differs, so the reviewer knows the specific thing to go and
 * check against the paper receipt.
 *
 * When even that list is empty, nothing in the data separates the two charges, and the
 * interface must say so. Presenting a choice that is really a coin flip, on money, with
 * two confident-looking percentages beside it, is how a wrong attachment gets made and
 * then looks reviewed.
 */

function list(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

export function AmbiguityCallout({ charges }: { charges: ComparableCharge[] }) {
  if (charges.length < 2) return null;

  const [a, b] = charges;
  // Each difference describes itself from the actual values. The phrase is not looked up
  // by field name: two outlets of one chain differ by "the branch", two unrelated shops by
  // "the merchant", and telling a reviewer the wrong one on this screen is the failure the
  // screen exists to prevent. `merchantSimilarity` is the same function the matcher scores
  // with, so the sentence and the engine agree about what counts as the same chain.
  const differences = chargeDifferences(a, b, merchantSimilarity);

  return (
    <section className="mt-4 rounded-md border border-amber-300/60 bg-amber-50 p-4 dark:border-amber-500/30 dark:bg-amber-950/40">
      <h3 className="text-sm font-medium text-amber-900 dark:text-amber-200">
        These charges are equally good matches
      </h3>

      {differences.length === 0 ? (
        <p className="mt-1.5 text-sm text-amber-900/90 dark:text-amber-200/90">
          Nothing in either charge separates them. The receipt cannot decide this — rejecting
          both and asking the driver which purchase it was is safer than guessing.
        </p>
      ) : (
        <>
          <p className="mt-1.5 text-sm text-amber-900/90 dark:text-amber-200/90">
            Everything the receipt can be compared on is identical. They differ only in{' '}
            {list(differences.map((d) => d.phrase))} — check the paper receipt for that, not
            the figures below.
          </p>

          <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
            {[a, b].map((charge, index) => (
              <div key={index} className="rounded border border-amber-300/50 bg-background/60 p-2">
                <dt className="font-medium">{charge.merchantName}</dt>
                <dd className="mt-0.5 text-muted-foreground tabular-nums">
                  {formatMinorUnits(charge.amount, charge.currency)} · {formatDay(charge.transactionAt)}{' '}
                  · {formatTime(charge.transactionAt)} · card ••••{charge.cardLast4}
                </dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </section>
  );
}
