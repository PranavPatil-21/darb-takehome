import Link from 'next/link';
import { resolveActor } from '@/lib/platform/identity';
import { modulePath } from '@/lib/platform/module-config';
import { EXCEPTION_KIND_LABEL, getExceptions, type ExceptionRow } from '@/lib/platform/document-register';
import { SOURCE_LABEL } from '@/lib/ui/vocabulary';
import { formatDay, formatMinorUnits } from '@/lib/format';

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
    <main className="mx-auto w-full max-w-5xl px-6 py-10">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Exceptions</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {exceptions.length === 0
            ? 'Nothing is stuck.'
            : `${exceptions.length} ${exceptions.length === 1 ? 'document is' : 'documents are'} stuck in a way that waiting will not resolve.`}
        </p>
      </header>

      {exceptions.length === 0 ? (
        <div className="mt-8 rounded-lg border bg-card p-10 text-center">
          <p className="font-medium">Nothing stuck</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            Every document either attached itself, is waiting on a charge to post, or is in
            the review queue.
          </p>
        </div>
      ) : (
        <div className="mt-8 space-y-10">
          {groups.map((group) => (
            <section key={group.kind}>
              <h2 className="text-sm font-medium">
                {EXCEPTION_KIND_LABEL[group.kind]}
                <span className="ml-2 text-xs font-normal text-muted-foreground tabular-nums">
                  {group.rows.length}
                </span>
              </h2>
              <p className="mt-0.5 max-w-2xl text-xs text-muted-foreground">
                {group.rows[0].whatToDo}
              </p>

              <ul className="mt-3 divide-y divide-border/60 border-y border-border/60">
                {group.rows.map((row) => (
                  <li key={row.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-3">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">
                        {row.merchantName ?? 'Unreadable document'}
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
            </section>
          ))}
        </div>
      )}
    </main>
  );
}
