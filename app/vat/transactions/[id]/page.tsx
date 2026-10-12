import Link from 'next/link';
import { notFound } from 'next/navigation';
import prisma from '@/lib/prisma';
import { canSeeClient, resolveActor } from '@/lib/platform/identity';
import { modulePath } from '@/lib/platform/module-config';
import { documentHistory, ACTION_COPY } from '@/lib/platform/audit';
import { documentationStatusOf } from '@/lib/platform/transaction-status';
import { formatDay, formatMinorUnits, formatPercent, formatTime } from '@/lib/format';
import { SOURCE_LABEL } from '@/lib/ui/vocabulary';
import { Page, PageHeader, Section, FactGrid, EmptyState } from '@/components/shell/page';
import { ChargeStatusPill } from '@/components/charges/charge-status-pill';

/**
 * One charge, and everything known about it.
 *
 * The page an auditor opens when they sample a line, and the page a reviewer opens when a
 * driver disputes one. Its job is to answer, without anybody running a query: is this
 * charge supported, by which document, who decided that and when, and what else was
 * considered and rejected.
 *
 * It is the end of the journey rather than a stop on it — everything that links to a
 * charge links here, and the three places that previously linked to this route were
 * reaching a 404.
 */

export const dynamic = 'force-dynamic';

export default async function ChargeDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const chargeId = Number(id);
  if (!Number.isInteger(chargeId) || chargeId <= 0) notFound();

  const actor = await resolveActor();

  const charge = await prisma.transaction.findUnique({
    where: { id: chargeId },
    include: {
      client: { select: { name: true } },
      confirmedDocument: {
        select: {
          id: true,
          merchantName: true,
          totalAmount: true,
          currency: true,
          documentDate: true,
          vatNumber: true,
          source: true,
          senderIdentifier: true,
          rawText: true,
        },
      },
      documents: {
        orderBy: [{ confidence: 'desc' }, { id: 'asc' }],
        include: {
          document: {
            select: { id: true, merchantName: true, totalAmount: true, currency: true },
          },
        },
      },
    },
  });

  if (!charge) notFound();
  // Scoping is a 404, not a 403: telling an actor that a charge exists but belongs to
  // somebody else is itself a disclosure.
  if (!canSeeClient(actor, charge.clientId)) notFound();

  const status = documentationStatusOf({
    confirmedDocumentId: charge.confirmedDocumentId,
    matches: charge.documents,
  });

  const history = charge.confirmedDocumentId
    ? await documentHistory(charge.confirmedDocumentId)
    : [];

  const attached = charge.confirmedDocument;
  const rejected = charge.documents.filter((m) => m.status === 'REJECTED');
  const candidates = charge.documents.filter((m) => m.status === 'CANDIDATE');

  return (
    <Page>
      <PageHeader
        back={{ href: modulePath('transactions'), label: 'All charges' }}
        title={charge.merchantName}
        description={`${charge.client.name} · card ••••${charge.cardLast4}`}
        meta={<ChargeStatusPill status={status} />}
      />

      <Section>
        <FactGrid
          facts={[
            { label: 'Amount', value: formatMinorUnits(charge.amount, charge.currency) },
            {
              label: 'Charged',
              value: `${formatDay(charge.transactionAt)} · ${formatTime(charge.transactionAt)}`,
            },
            { label: 'Card', value: `•••• ${charge.cardLast4}` },
            { label: 'Driver', value: charge.driverPhone ?? 'Pool card — no driver' },
          ]}
        />
      </Section>

      <Section title="Receipt">
        {attached ? (
          <div className="rounded-lg border bg-card p-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="font-medium">{attached.merchantName ?? 'Unreadable document'}</p>
                <p className="mt-0.5 text-sm text-muted-foreground tabular-nums">
                  {formatMinorUnits(attached.totalAmount, attached.currency ?? 'SAR')} ·{' '}
                  {formatDay(attached.documentDate)}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {SOURCE_LABEL[attached.source] ?? attached.source} ·{' '}
                  {attached.senderIdentifier}
                </p>
                {/* The field that decides whether this document supports a VAT reclaim at
                    all. An auditor asks for it by name. */}
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {attached.vatNumber
                    ? `VAT number ${attached.vatNumber}`
                    : 'No VAT number on this document'}
                </p>
              </div>
            </div>

            {attached.rawText ? (
              <pre
                dir="auto"
                className="mt-4 max-h-56 overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words"
              >
                {attached.rawText}
              </pre>
            ) : null}
          </div>
        ) : (
          <EmptyState
            title="No receipt attached"
            description={
              candidates.length > 0
                ? 'A receipt has been proposed for this charge and is waiting on a decision.'
                : 'Nothing has been proposed for this charge. It needs a receipt before the filing.'
            }
            action={
              candidates.length > 0 ? (
                <Link
                  href={modulePath('review')}
                  className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
                >
                  Open the review queue
                </Link>
              ) : undefined
            }
          />
        )}
      </Section>

      {charge.documents.length > 0 ? (
        <Section
          title="Everything considered"
          description="Every document the matcher scored against this charge, and what became of it."
        >
          <ul className="divide-y divide-border/60 border-y border-border/60">
            {charge.documents.map((match) => (
              <li
                key={match.id}
                className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-3"
              >
                <span className="min-w-0 flex-1 truncate text-sm">
                  {match.document.merchantName ?? 'Unreadable document'}
                </span>
                <span className="flex shrink-0 items-center gap-4 text-xs text-muted-foreground tabular-nums">
                  <span>{formatMinorUnits(match.document.totalAmount, match.document.currency ?? 'SAR')}</span>
                  <span>{formatPercent(match.confidence)}</span>
                  <span className="w-28 text-right">{matchOutcome(match.status)}</span>
                  <span className="w-24 text-right">{match.decidedBy ?? '—'}</span>
                </span>
              </li>
            ))}
          </ul>
          {rejected.length > 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">
              A rejected pairing is permanent — the matcher will not propose it again, though
              the document stays open to other charges.
            </p>
          ) : null}
        </Section>
      ) : null}

      {history.length > 0 ? (
        <Section
          title="History"
          description="Every decision taken about the attached receipt, in order."
        >
          <ol className="space-y-3 border-l pl-4">
            {history.map((event) => (
              <li key={event.id} className="relative">
                <span
                  aria-hidden
                  className="absolute -left-[1.3125rem] top-1.5 size-2 rounded-full bg-border ring-4 ring-background"
                />
                <p className="text-sm">
                  {ACTION_COPY[event.action] ?? event.action}
                  {event.actorRole === 'SYSTEM' ? '' : ` ${event.actorId}`}
                  {event.confidence !== null ? (
                    <span className="text-muted-foreground"> · {formatPercent(event.confidence)}</span>
                  ) : null}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                  {formatDay(event.createdAt)} · {formatTime(event.createdAt)}
                </p>
                {event.note ? (
                  <p className="mt-1 text-xs text-muted-foreground">&ldquo;{event.note}&rdquo;</p>
                ) : null}
              </li>
            ))}
          </ol>
        </Section>
      ) : null}
    </Page>
  );
}

function matchOutcome(status: string): string {
  if (status === 'AUTO_CONFIRMED') return 'attached by engine';
  if (status === 'CONFIRMED') return 'attached';
  if (status === 'REJECTED') return 'rejected';
  return 'proposed';
}
