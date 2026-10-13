import { t } from '@/lib/content/messages';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { modulePath } from '@/lib/platform/module-config';
import { resolveActor } from '@/lib/platform/identity';
import { actionCopy } from '@/lib/platform/audit';
import { getChargeDetail } from '@/lib/platform/charge-detail';
import { SignOffState } from '@/components/charges/sign-off-state';
import { EngineDisclosure } from '@/components/review/engine-disclosure';
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
  // Digits only. `Number('1e3')` is 1000 and `Number('0x10')` is 16, both of which pass
  // `Number.isInteger` — so `/vat/transactions/1e3` resolved the same record as `/1000`,
  // giving every resource several URLs for no gain.
  const chargeId = /^\d+$/.test(id) ? Number(id) : Number.NaN;
  if (!Number.isInteger(chargeId) || chargeId <= 0) notFound();

  const actor = await resolveActor();

  const detail = await getChargeDetail(actor, chargeId);
  // Absence rather than refusal: telling an actor a charge exists but belongs to
  // somebody else is itself a disclosure.
  if (!detail) notFound();

  const { attached, considered, history } = detail;
  const rejected = considered.filter((row) => row.status === 'REJECTED');
  const candidates = considered.filter((row) => row.status === 'CANDIDATE');

  return (
    <Page>
      <PageHeader
        back={{ href: modulePath('transactions'), label: t('charge.back') }}
        title={detail.merchantName}
        description={`${detail.clientName} · card ••••${detail.cardLast4}`}
        meta={<ChargeStatusPill status={detail.status} />}
      />

      <Section>
        <FactGrid
          facts={[
            { label: 'Amount', value: formatMinorUnits(detail.amount, detail.currency) },
            {
              label: 'Charged',
              value: `${formatDay(detail.transactionAt)} · ${formatTime(detail.transactionAt)}`,
            },
            { label: 'Card', value: `•••• ${detail.cardLast4}` },
            { label: t('charge.fact.driver'), value: detail.driverPhone ?? t('charge.fact.noDriver') },
          ]}
        />
      </Section>

      <Section title="Receipt">
        {attached ? (
          <div className="space-y-4">
            {/* Whether somebody independent has countersigned this is a separate fact
                from whether the charge is documented, and the page showed only the
                second while 96 attachments sat waiting for the first. */}
            <SignOffState state={attached.signOff} />

            <div className="rounded-xl border bg-card p-5 shadow-xs">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="font-medium">{attached.merchantName ?? 'Unreadable document'}</p>
                  <p className="mt-1 text-sm tabular-nums text-muted-foreground">
                    {formatMinorUnits(attached.totalAmount, attached.currency ?? 'SAR')} ·{' '}
                    {formatDay(attached.documentDate)}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {SOURCE_LABEL[attached.source] ?? attached.source} ·{' '}
                    {attached.senderIdentifier}
                  </p>
                  {/* The field that decides whether this document supports a VAT reclaim
                      at all. An auditor asks for it by name. */}
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {attached.vatNumber
                      ? `VAT number ${attached.vatNumber}`
                      : t('review.vat.absent')}
                  </p>
                </div>

                <Link
                  href={`${modulePath('documents')}/${attached.id}`}
                  className="shrink-0 text-sm underline underline-offset-4"
                >
                  Open document
                </Link>
              </div>

              {attached.rawText ? (
                <pre
                  dir="auto"
                  className="mt-4 max-h-56 overflow-auto rounded-lg border bg-surface-sunken p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words"
                >
                  {attached.rawText}
                </pre>
              ) : null}
            </div>

            {/* The evidence the attachment rests on. The page reduced this to a bare
                percentage while the review screen showed the full breakdown — the same
                decision, explained in one place and not the other. */}
            <div className="rounded-xl border bg-card p-5 shadow-xs">
              <h3 className="text-sm font-semibold">{t('charge.evidence.title')}</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {attached.automatic ? t('charge.evidence.automatic') : t('charge.evidence.human')}
                {attached.decidedBy && !attached.automatic ? ` (${attached.decidedBy})` : ''}
                {' · '}
                {formatPercent(attached.confidence)} match
              </p>
              <EngineDisclosure signals={attached.signals} />
            </div>
          </div>
        ) : (
          <EmptyState
            title={t('charge.noReceipt.title')}
            description={
              candidates.length > 0
                ? t('charge.noReceipt.proposed')
                : t('charge.noReceipt.none')
            }
            action={
              candidates.length > 0 ? (
                <Link
                  href={modulePath('review')}
                  className="inline-flex h-9 items-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground shadow-xs"
                >
                  Open the review queue
                </Link>
              ) : undefined
            }
          />
        )}
      </Section>

      {considered.length > 0 ? (
        <Section
          title={t('charge.considered.title')}
          description={t('charge.considered.hint')}
        >
          <ul className="divide-y overflow-hidden rounded-xl border bg-card shadow-xs">
            {considered.map((row) => (
              <li
                key={row.matchId}
                className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-5 py-3"
              >
                <Link
                  href={`${modulePath('documents')}/${row.documentId}`}
                  className="min-w-0 flex-1 truncate text-sm underline-offset-4 hover:underline"
                >
                  {row.merchantName ?? t('common.unreadableDocument')}
                </Link>
                <span className="flex shrink-0 items-center gap-4 text-xs tabular-nums text-muted-foreground">
                  <span>{formatMinorUnits(row.totalAmount, row.currency ?? 'SAR')}</span>
                  <span>{formatPercent(row.confidence)}</span>
                  <span className="w-28 text-right">{matchOutcome(row.status)}</span>
                  <span className="w-24 text-right">{row.decidedBy ?? '—'}</span>
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

      {/* Always rendered. A History section that disappears when it is empty tells the
          reader nothing happened, which is a different claim from "this predates the
          trail" — and usually a false one. */}
      <Section title="History" description={t('charge.history.hint')}>
        {history.length === 0 ? (
          <p className="rounded-xl border border-dashed bg-card px-5 py-6 text-sm leading-relaxed text-muted-foreground">
            {detail.historyNote}
          </p>
        ) : (
          <ol className="space-y-3 rounded-xl border bg-card p-5 shadow-xs">
            {history.map((event) => (
              <li key={event.id} className="relative border-l pl-4">
                <span
                  aria-hidden
                  className="absolute -left-[0.3125rem] top-1.5 size-2 rounded-full bg-border ring-4 ring-card"
                />
                <p className="text-sm">
                  {actionCopy(event.action)}
                  {event.actorRole === 'SYSTEM' ? '' : ` ${event.actorId}`}
                  {event.confidence !== null ? (
                    <span className="text-muted-foreground">
                      {' · '}
                      {formatPercent(event.confidence)}
                    </span>
                  ) : null}
                </p>
                <p className="mt-0.5 text-xs tabular-nums text-muted-foreground">
                  {formatDay(event.createdAt)} · {formatTime(event.createdAt)}
                </p>
                {event.note ? (
                  <p className="mt-1 text-xs text-muted-foreground">&ldquo;{event.note}&rdquo;</p>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </Section>

    </Page>
  );
}

function matchOutcome(status: string): string {
  if (status === 'AUTO_CONFIRMED') return 'attached by engine';
  if (status === 'CONFIRMED') return 'attached';
  if (status === 'REJECTED') return 'rejected';
  return 'proposed';
}
