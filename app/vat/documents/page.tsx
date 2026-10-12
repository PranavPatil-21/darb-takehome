import Link from 'next/link';
import { resolveActor } from '@/lib/platform/identity';
import { modulePath } from '@/lib/platform/module-config';
import { getDocumentRegister } from '@/lib/platform/document-register';
import { presentStatus, SOURCE_LABEL } from '@/lib/ui/vocabulary';
import { StatusPill } from '@/components/documents/status-pill';
import { formatDay, formatMinorUnits } from '@/lib/format';
import { reasonText, t } from '@/lib/content/messages';
import type { DocumentStatus } from '@/lib/domain/enums';
import { Page, PageHeader, EmptyState } from '@/components/shell/page';

/**
 * The document register — the inbox side of the ledger.
 *
 * The charge register answers "is this spend supported". This answers the question asked
 * just as often and which previously had nowhere to live: a driver insists they sent the
 * receipt, and somebody has to establish whether it arrived, what was read off it, and
 * where it went.
 */

export const dynamic = 'force-dynamic';

const STATUSES: DocumentStatus[] = ['MATCHED', 'NEEDS_REVIEW', 'UNMATCHED', 'FAILED'];

export default async function DocumentRegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string }>;
}) {
  const params = await searchParams;
  const actor = await resolveActor();

  const status = STATUSES.includes(params.status as DocumentStatus)
    ? (params.status as DocumentStatus)
    : undefined;

  const register = await getDocumentRegister(actor, { status, query: params.q });

  const href = (next?: DocumentStatus) => {
    const qs = new URLSearchParams();
    if (next) qs.set('status', next);
    if (params.q) qs.set('q', params.q);
    const s = qs.toString();
    return s ? `${modulePath('documents')}?${s}` : modulePath('documents');
  };

  return (
    <Page>
      <PageHeader
        title={t('documents.title')}
        description={t('documents.subtitle')}
      />

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap gap-1.5">
          <Chip href={href()} active={!status} label="All" />
          {STATUSES.map((s) => (
            <Chip
              key={s}
              href={href(s)}
              active={status === s}
              label={presentStatus(s).label}
              count={register.statusCounts[s] ?? 0}
            />
          ))}
        </div>

        <form action={modulePath('documents')} method="get" className="flex items-center gap-2">
          {status ? <input type="hidden" name="status" value={status} /> : null}
          <label className="sr-only" htmlFor="doc-search">Search documents</label>
          <input
            id="doc-search"
            name="q"
            defaultValue={params.q ?? ''}
            placeholder={t('documents.search.placeholder')}
            className="h-8 w-56 rounded-md border bg-background px-3 text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <button
            type="submit"
            className="h-8 rounded-md border px-3 text-xs transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Search
          </button>
        </form>
      </div>

      {register.rows.length === 0 ? (
        <EmptyState
          title={t('documents.empty.title')}
          description={t('documents.empty.body')}
          action={
            <Link href={modulePath('documents')} className="text-sm underline underline-offset-4">
              Show everything
            </Link>
          }
        />
      ) : (
        <ul className="mt-5 divide-y divide-border/60 border-y border-border/60">
          {register.rows.map((row) => (
            <li key={row.id} className="py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <span className="min-w-0 flex-1 truncate text-sm">
                  {row.merchantName ?? t('common.unreadableDocument')}
                </span>
                <span className="flex shrink-0 items-center gap-3">
                  <span className="text-sm tabular-nums text-muted-foreground">
                    {formatMinorUnits(row.totalAmount, row.currency ?? 'SAR')}
                  </span>
                  <span className="hidden text-xs tabular-nums text-muted-foreground sm:inline">
                    {formatDay(row.documentDate)}
                  </span>
                  <StatusPill status={row.status} />
                </span>
              </div>

              <p className="mt-1 text-xs text-muted-foreground">
                {SOURCE_LABEL[row.source] ?? row.source}
                {row.senderLabel ? ` · ${row.senderLabel}` : ` · ${row.senderIdentifier}`}
                {row.attachedTransactionId ? (
                  <>
                    {' · '}
                    <Link
                      href={modulePath('transactions', String(row.attachedTransactionId))}
                      className="underline underline-offset-4"
                    >
                      attached to a charge
                    </Link>
                  </>
                ) : null}
              </p>

              {row.failureReason && row.status !== 'MATCHED' ? (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {reasonText(row.failureReason)}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}

function Chip({ href, active, label, count }: { href: string; active: boolean; label: string; count?: number }) {
  return (
    <Link
      href={href}
      aria-current={active ? 'true' : undefined}
      className={`inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        active ? 'border-foreground bg-foreground text-background' : 'border-border text-muted-foreground hover:text-foreground'
      }`}
    >
      {label}
      {count !== undefined ? <span className="tabular-nums opacity-70">{count}</span> : null}
    </Link>
  );
}
