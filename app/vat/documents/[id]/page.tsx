import Link from 'next/link';
import { notFound } from 'next/navigation';
import { t } from '@/lib/content/messages';
import { resolveActor } from '@/lib/platform/identity';
import { modulePath } from '@/lib/platform/module-config';
import { getDocumentDetail } from '@/lib/platform/document-detail';
import { actionCopy } from '@/lib/platform/audit';
import { EngineDisclosure } from '@/components/review/engine-disclosure';
import { StatusPill } from '@/components/documents/status-pill';
import { SOURCE_LABEL } from '@/lib/ui/vocabulary';
import { formatDay, formatMinorUnits, formatPercent, formatTime } from '@/lib/format';
import { Page, PageHeader, Section, FactGrid } from '@/components/shell/page';

/**
 * One document, and what became of it.
 *
 * The register had no detail page, which made it a list you could read and not use, and
 * left the product asymmetric: a charge had a journey and the document it was paired with
 * did not. Ordered the way somebody actually asks about a document — what arrived, what we
 * read out of it, what we scored it against, where it ended up, and who touched it.
 */

export const dynamic = 'force-dynamic';

export default async function DocumentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // Digits only. `Number('1e3')` is 1000 and `Number('0x10')` is 16, both of which pass
  // `Number.isInteger` — so `/vat/transactions/1e3` resolved the same record as `/1000`,
  // giving every resource several URLs for no gain.
  const documentId = /^\d+$/.test(id) ? Number(id) : Number.NaN;
  if (!Number.isInteger(documentId) || documentId <= 0) notFound();

  const actor = await resolveActor();
  const detail = await getDocumentDetail(actor, documentId);
  // Absence rather than refusal — the existence of somebody else's document is itself a
  // disclosure.
  if (!detail) notFound();

  const { extraction } = detail;

  return (
    <Page>
      <PageHeader
        back={{ href: modulePath('documents'), label: 'All documents' }}
        title={extraction.merchantName ?? t('common.unreadableDocument')}
        description={`${SOURCE_LABEL[detail.source] ?? detail.source} · ${
          detail.senderLabel ?? detail.senderIdentifier
        }`}
        meta={<StatusPill status={detail.status} />}
      />

      {/* What has to happen next, when anything does. The same taxonomy the queue groups
          by, so a document's page and its row in the queue cannot say different things. */}
      {detail.workKind ? (
        <div className="mb-6 rounded-xl border border-attention-border/60 bg-attention p-5 text-attention-foreground shadow-xs">
          <h2 className="text-sm font-semibold">{detail.workLabel}</h2>
          <p className="mt-1.5 text-sm leading-relaxed opacity-90">{detail.workWhy}</p>
          <p className="mt-1 text-sm leading-relaxed opacity-90">{detail.workNextStep}</p>
          {detail.decidable ? (
            <Link
              href={`${modulePath('review')}?doc=${detail.id}`}
              className="mt-3 inline-flex h-9 items-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground shadow-xs"
            >
              Decide this in the queue
            </Link>
          ) : null}
        </div>
      ) : null}

      <Section title="What arrived">
        <FactGrid
          facts={[
            { label: 'Received', value: `${formatDay(detail.receivedAt)} · ${formatTime(detail.receivedAt)}` },
            { label: 'From', value: detail.senderLabel ?? detail.senderIdentifier },
            { label: 'Channel', value: SOURCE_LABEL[detail.source] ?? detail.source },
            { label: 'Provider id', value: detail.externalId },
          ]}
        />
      </Section>

      <Section title="What was read from it" description="The extractor's output, as stored.">
        <FactGrid
          facts={[
            { label: 'Type', value: extraction.documentType ?? '—' },
            {
              label: 'Total',
              value: formatMinorUnits(extraction.totalAmount, extraction.currency ?? 'SAR'),
            },
            { label: 'Dated', value: formatDay(extraction.documentDate) },
            { label: 'Card', value: extraction.cardLast4 ? `•••• ${extraction.cardLast4}` : '—' },
            { label: 'VAT number', value: extraction.vatNumber ?? 'Not printed' },
            { label: 'Invoice no.', value: extraction.invoiceNumber ?? '—' },
            {
              label: 'OCR confidence',
              value:
                extraction.extractionConfidence === null
                  ? '—'
                  : formatPercent(extraction.extractionConfidence),
            },
            { label: 'File', value: detail.filename ?? '—' },
          ]}
        />

        {detail.rawText ? (
          <div className="mt-4 overflow-hidden rounded-xl border bg-card shadow-xs">
            <h3 className="border-b bg-surface-sunken px-5 py-2.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Raw text
            </h3>
            <pre
              dir="auto"
              className="max-h-64 overflow-auto px-5 py-4 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words"
            >
              {detail.rawText}
            </pre>
          </div>
        ) : null}
      </Section>

      <Section
        title="Charges considered"
        description="Every charge the matcher scored this document against, best first."
      >
        {detail.considered.length === 0 ? (
          <p className="rounded-xl border border-dashed bg-card px-5 py-6 text-sm leading-relaxed text-muted-foreground">
            Nothing was scored against this document — either its extraction was unusable, or
            no charge in the window was in scope for the sender.
          </p>
        ) : (
          <ul className="divide-y overflow-hidden rounded-xl border bg-card shadow-xs">
            {detail.considered.map((row) => (
              <li key={row.matchId} className="px-5 py-3.5">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <Link
                    href={`${modulePath('transactions')}/${row.transactionId}`}
                    className="min-w-0 flex-1 truncate text-sm font-medium underline-offset-4 hover:underline"
                  >
                    {row.merchantName}
                  </Link>
                  <span className="flex shrink-0 items-center gap-4 text-xs tabular-nums text-muted-foreground">
                    <span>{formatMinorUnits(row.amount, row.currency)}</span>
                    <span>{formatDay(row.transactionAt)}</span>
                    <span>{formatPercent(row.confidence)}</span>
                    <span className="w-24 text-right">{outcomeCopy(row.status)}</span>
                  </span>
                </div>
                <EngineDisclosure signals={row.signals} />
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="History" description="Every decision taken about this document, in order.">
        {detail.history.length === 0 ? (
          <p className="rounded-xl border border-dashed bg-card px-5 py-6 text-sm leading-relaxed text-muted-foreground">
            Nothing has been decided about this document yet.
          </p>
        ) : (
          <ol className="space-y-3 rounded-xl border bg-card p-5 shadow-xs">
            {detail.history.map((event) => (
              <li key={event.id} className="relative border-l pl-4">
                <span
                  aria-hidden
                  className="absolute -left-[0.3125rem] top-1.5 size-2 rounded-full bg-border ring-4 ring-card"
                />
                <p className="text-sm">
                  {actionCopy(event.action)}
                  {event.actorRole === 'SYSTEM' ? '' : ` ${event.actorId}`}
                </p>
                <p className="mt-0.5 text-xs tabular-nums text-muted-foreground">
                  {formatDay(event.createdAt)} · {formatTime(event.createdAt)}
                </p>
              </li>
            ))}
          </ol>
        )}
      </Section>
    </Page>
  );
}

function outcomeCopy(status: string): string {
  if (status === 'AUTO_CONFIRMED') return 'attached by engine';
  if (status === 'CONFIRMED') return 'attached';
  if (status === 'REJECTED') return 'rejected';
  return 'proposed';
}
