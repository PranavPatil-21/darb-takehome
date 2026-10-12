import { t } from '@/lib/content/messages';
import Link from 'next/link';
import { resolveActor } from '@/lib/platform/identity';
import { modulePath } from '@/lib/platform/module-config';
import { EXCEPTION_KIND_LABEL, getExceptions, type ExceptionRow } from '@/lib/platform/document-register';
import { SOURCE_LABEL } from '@/lib/ui/vocabulary';
import { formatDay, formatMinorUnits } from '@/lib/format';
import { Page, PageHeader, Section, EmptyState } from '@/components/shell/page';

/**
 * The exception register — everything the happy path could not place.
 *
 * Grouped by kind rather than listed flat, because the three conditions route to three
 * different people. An unreadable scan needs whoever can re-photograph it; an unregistered
 * sender is an onboarding gap somebody closes in a minute; a duplicate claim is a
 * judgement for a reviewer. A single undifferentiated "problems" list is how a backlog
 * becomes a bin nobody opens.
 *
 * It exists at all because these documents are otherwise invisible: they are not in the
 * review queue, they hold no charge, and nothing about waiting resolves them.
 */

export const dynamic = 'force-dynamic';

const ORDER: ExceptionRow['kind'][] = ['UNKNOWN_SENDER', 'DUPLICATE_CLAIM', 'UNREADABLE'];

export default async function ExceptionsPage() {
  const actor = await resolveActor();
  const exceptions = await getExceptions(actor);

  const groups = ORDER.map((kind) => ({
    kind,
    rows: exceptions.filter((row) => row.kind === kind),
  })).filter((group) => group.rows.length > 0);

  return (
    <Page>
      <PageHeader
        title={t('exceptions.title')}
        description={
          exceptions.length === 0
            ? t('exceptions.none')
            : `${exceptions.length} ${exceptions.length === 1 ? 'document is' : 'documents are'} stuck in a way that waiting will not resolve.`
        }
      />

      {exceptions.length === 0 ? (
        <EmptyState
          title={t('exceptions.empty.title')}
          description={t('exceptions.empty.body')}
        />
      ) : (
        <div>
          {groups.map((group) => (
            <Section
              key={group.kind}
              title={`${EXCEPTION_KIND_LABEL[group.kind]} · ${group.rows.length}`}
              description={group.rows[0].whatToDo}
            >

              <ul className="divide-y divide-border/60 border-y border-border/60">
                {group.rows.map((row) => (
                  <li key={row.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-3">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">
                        {row.merchantName ?? t('common.unreadableDocument')}
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {SOURCE_LABEL[row.source] ?? row.source} · {row.senderIdentifier} ·
                        received {formatDay(row.receivedAt)}
                      </span>
                    </span>

                    <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                      {formatMinorUnits(row.totalAmount, row.currency ?? 'SAR')}
                    </span>
                  </li>
                ))}
              </ul>

              {group.kind === 'DUPLICATE_CLAIM' ? (
                <p className="mt-2 text-xs">
                  <Link href={modulePath('review')} className="underline underline-offset-4">
                    Decide these in the review queue
                  </Link>
                </p>
              ) : null}
            </Section>
          ))}
        </div>
      )}
    </Page>
  );
}
