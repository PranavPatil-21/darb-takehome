import Link from 'next/link';
import { formatMinorUnits, formatPercent } from '@/lib/format';
import { modulePath } from '@/lib/platform/module-config';
import type { DashboardData } from '@/lib/platform/dashboard';
import { can, type Actor } from '@/lib/platform/identity';
import { t, type MessageKey } from '@/lib/content/messages';

/**
 * The headline: how exposed is this period, and whose desk is the work on.
 *
 * Deliberately one figure with its supporting line, rather than four equal tiles. Four
 * tiles say everything is equally important, and the reader has to decide what to care
 * about before they can start; one headline says what matters and lets the rest support
 * it. The two desks beneath are routes into work, not statistics — they are counts
 * precisely because a person has to go and do them.
 */
export function ExposureSummary({ data, actor }: { data: DashboardData; actor: Actor }) {
  const { period, undocumentedSpend, undocumentedCount, chargeCount } = {
    ...data,
    undocumentedCount: data.byStatus
      .filter((s) => s.status !== 'DOCUMENTED')
      .reduce((n, s) => n + s.count, 0),
  };

  if (chargeCount === 0) {
    return (
      <section>
        <h1 className="text-sm font-medium text-muted-foreground">
          {t('overview.period.all')}
        </h1>
        <p className="mt-2 text-2xl font-semibold tracking-tight">
          {t('overview.noCharges.title')}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">{t('overview.noCharges.body')}</p>
      </section>
    );
  }

  const clear = undocumentedCount === 0;
  const staleBy = describeGap(period?.to ?? null, new Date());

  return (
    <section>
      {/* The eyebrow names the period only. It previously read "Receipt coverage", which
          contradicted the figure directly beneath it — that figure is the amount *not*
          covered, so scanning the two together said the opposite of the truth. The
          headline now carries its own meaning and does not depend on the label above it. */}
      <h1 className="text-sm font-medium text-muted-foreground">
        {period ? period.label : t('overview.period.all')}
      </h1>

      {clear ? (
        <p className="mt-2 text-3xl font-semibold tracking-tight">{t('overview.allCovered')}</p>
      ) : (
        <>
          <p className="mt-2 text-3xl font-semibold tracking-tight tabular-nums">
            {t('overview.unsupported', { amount: formatMinorUnits(undocumentedSpend) })}
          </p>
          <p className="mt-1.5 text-sm text-muted-foreground tabular-nums">
            {t('overview.supporting', {
              undocumented: undocumentedCount,
              total: chargeCount,
              coverage: formatPercent(data.coverageByValue),
              vat: formatMinorUnits(data.vatAtRisk),
            })}
          </p>
        </>
      )}

      {/* A period that is not the current month looks like stale data unless the screen
          says otherwise. It is derived from the newest charge on purpose — anchoring on
          the clock would report 0% covered to anyone opening this after the data's month
          has passed — but the reader cannot know that, and silently showing a figure for
          a month long gone is how a dashboard loses trust. */}
      {staleBy ? (
        <p className="mt-1.5 text-xs text-muted-foreground">
          {t('overview.stale', { gap: staleBy })}
        </p>
      ) : null}

      {/* A doorway only appears for work this reader can actually do. Offering a
          reviewer "96 attachments need sign-off" sends them to a screen that refuses
          them, and a dashboard that hands out work the reader is not permitted to pick up
          teaches them to distrust the rest of it. */}
      <div className="mt-5 flex flex-wrap items-center gap-3">
        {can(actor, 'decide') ? (
          <Desk
            href={modulePath('review')}
            count={data.awaitingDecision}
            messageKey="overview.desk.review"
            primary
          />
        ) : null}
        {can(actor, 'verify') ? (
          <Desk
            href={modulePath('assurance')}
            count={data.awaitingVerification}
            messageKey="overview.desk.assurance"
            primary={!can(actor, 'decide')}
          />
        ) : null}
        <Desk
          href={modulePath('exceptions')}
          count={data.exceptions}
          messageKey="overview.desk.exceptions"
        />
      </div>
    </section>
  );
}

/**
 * A pile of work, or silence.
 *
 * An empty desk renders nothing at all rather than a zero. A dashboard full of zeroes
 * trains the reader to skip the row, and then the one that is not zero gets skipped too.
 */
function Desk({
  href,
  count,
  messageKey,
  primary = false,
}: {
  href: string;
  count: number;
  messageKey: MessageKey;
  primary?: boolean;
}) {
  if (count === 0) return null;

  return (
    <Link
      href={href}
      className={
        primary
          ? 'inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
          : 'inline-flex h-10 items-center rounded-md border px-4 text-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
      }
    >
      {t(messageKey, { count })}
    </Link>
  );
}

/**
 * How far behind the reported period is, in words, or null when it is current.
 *
 * Returns a duration rather than a date because the reader's question is "is this
 * current?", not "when exactly did it end" — and a duration answers it without arithmetic.
 */
function describeGap(periodEnd: Date | null, now: Date): string | null {
  if (periodEnd === null) return null;

  const months =
    (now.getUTCFullYear() - periodEnd.getUTCFullYear()) * 12 +
    (now.getUTCMonth() - periodEnd.getUTCMonth());

  // One month behind is normal: a period closes before the next one has much in it.
  if (months < 2) return null;
  if (months < 12) return `${months} months`;

  const years = Math.floor(months / 12);
  const rest = months % 12;
  const yearPart = `${years} ${years === 1 ? 'year' : 'years'}`;
  return rest === 0 ? yearPart : `${yearPart} and ${rest} ${rest === 1 ? 'month' : 'months'}`;
}
