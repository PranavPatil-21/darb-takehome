import { t } from '@/lib/content/messages';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import prisma from '@/lib/prisma';
import { can, canSeeClient, resolveActor } from '@/lib/platform/identity';
import { modulePath } from '@/lib/platform/module-config';
import {
  WORK_KINDS,
  classifyWorkItem,
  getWorkKindCounts,
  getWorkQueue,
  isDecidable,
  type WorkKind,
} from '@/lib/platform/work-queue';
import { KindFilter } from '@/components/review/kind-filter';
import { Page, PageHeader, EmptyState } from '@/components/shell/page';
import { QueueList } from '@/components/review/queue-list';
import { FocusedDocument } from '@/components/review/focused-document';
import type { CandidateCharge } from '@/components/review/candidate-card';

/**
 * The review queue — the one screen in this product where a person makes a decision.
 *
 * Two panes: every document still waiting on the left, the one being decided on the
 * right. The focused document lives in the URL rather than in client state, which buys
 * three things for no JavaScript — the queue survives a confirm (the server simply
 * re-renders and picks the next one, so nobody loses their place), a half-finished review
 * can be handed to a colleague as a link, and the back button behaves.
 *
 * A `?doc=` pointing at something already decided, or at nothing, falls back to the
 * oldest waiting document rather than 404ing. That case is not exotic: it is what the URL
 * becomes the instant the reviewer confirms the document it names.
 */

export const dynamic = 'force-dynamic';

export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ doc?: string; kind?: string }>;
}) {
  const { doc, kind } = await searchParams;
  const actor = await resolveActor();

  // The queue is guarded, not merely hidden from the navigation. A checker reaching this
  // URL directly would otherwise see a list of Attach buttons that every server action
  // then refuses — which reads as a broken product rather than as a control, and teaches
  // people that the permissions are decorative.
  if (!can(actor, 'decide')) {
    return (
      <Page>
        <PageHeader title={t('review.title')} />
        <EmptyState
          title={t('review.denied.title')}
          description={t('review.denied.body')}
          action={
            can(actor, 'verify') ? (
              <Link
                href={modulePath('assurance')}
                className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
              >
                Go to your queue
              </Link>
            ) : undefined
          }
        />
      </Page>
    );
  }

  // An unrecognised ?kind= is ignored rather than erroring: the filter is a convenience,
  // and a stale bookmark should show the whole queue, not a dead end.
  const activeKind = WORK_KINDS.includes(kind as WorkKind) ? (kind as WorkKind) : undefined;

  // Everything waiting on a person, grouped by what that person has to do — scoped to
  // what this actor may see, and bounded. Counts are of the whole queue so the chips can
  // say what selecting them would reveal.
  const [groups, kindCounts] = await Promise.all([
    getWorkQueue(actor, { kind: activeKind }),
    getWorkKindCounts(actor),
  ]);
  const waiting = groups.flatMap((group) => group.items);

  if (waiting.length === 0) {
    // An empty *filter* is not an empty *queue*, and conflating them strands the reviewer.
    // Working the last item of a kind is the normal end of a session, and this screen then
    // said "nothing needs a decision" next to a nav badge reading Review 11 — with the
    // chips gone, so the only offered exit was back to the overview.
    const filtered = activeKind !== undefined;
    const totalWaiting = Object.values(kindCounts).reduce((sum, count) => sum + count, 0);

    return (
      <Page>
        <PageHeader title={t('review.title')} />
        {filtered ? <KindFilter counts={kindCounts} active={activeKind} /> : null}
        <EmptyState
          title={filtered ? t('review.emptyFiltered.title') : t('review.empty.title')}
          description={
            filtered
              ? t('review.emptyFiltered.body', { count: String(totalWaiting) })
              : t('review.empty.body')
          }
          action={
            filtered ? (
              <Link href={modulePath('review')} className="text-sm underline underline-offset-4">
                Show everything waiting
              </Link>
            ) : (
              <Link href={modulePath()} className="text-sm underline underline-offset-4">
                Back to the overview
              </Link>
            )
          }
        />
      </Page>
    );
  }

  const decidableCount = groups
    .filter((group) => group.decidable)
    .reduce((sum, group) => sum + group.items.length, 0);

  const blockedCount = waiting.length - decidableCount;

  const requested = doc ? Number(doc) : Number.NaN;
  // `waiting` is non-empty here — the empty case returned above — but the fallback is
  // written so that stays true if the guard above is ever moved.
  const firstWaiting = waiting[0];
  const focusedId =
    waiting.some((d) => d.id === requested) ? requested : (firstWaiting?.id ?? requested);

  // `findUnique`, not `findUniqueOrThrow`, and the result is checked below. The id is
  // drawn from the already-scoped queue today, but the fallback above can carry a
  // caller-supplied `?doc=` straight here — and an unscoped `findUniqueOrThrow` would
  // then render another tenant's document in full, raw OCR text included, or 500 on a
  // miss where every other detail view 404s.
  const focused = await prisma.document.findUnique({
    where: { id: focusedId },
    include: {
      matches: {
        where: { status: 'CANDIDATE' },
        orderBy: [{ confidence: 'desc' }, { transactionId: 'asc' }],
        include: { transaction: true },
      },
    },
  });

  // Not found, or outside this actor's scope — the same answer either way, so the URL
  // cannot be used to probe which document ids exist.
  if (!focused || !canSeeClient(actor, focused.clientId)) notFound();

  // The sender's human label — "Faisal Al-Harbi (driver, card 4412)" — turns an E.164
  // number into the person a reviewer would actually go and ask.
  const identity = await prisma.senderIdentity.findUnique({
    where: { identifier: focused.senderIdentifier },
    select: { label: true },
  });

  const focusedKind = classifyWorkItem(focused);
  const focusedGroup = groups.find((group) => group.kind === focusedKind);

  const candidates: CandidateCharge[] = focused.matches.map((match) => ({
    matchId: match.id,
    confidence: match.confidence,
    signals: match.signals,
    merchantName: match.transaction.merchantName,
    amount: match.transaction.amount,
    currency: match.transaction.currency,
    transactionAt: match.transaction.transactionAt,
    cardLast4: match.transaction.cardLast4,
  }));

  return (
    <Page width="wide">
      <PageHeader
        title={t('review.title')}
        description={[
          t('review.subtitle', { count: waiting.length }),
          [
            decidableCount > 0 ? t('review.subtitle.decidable', { count: decidableCount }) : null,
            blockedCount > 0 ? t('review.subtitle.blocked', { count: blockedCount }) : null,
          ]
            .filter(Boolean)
            .join(' · '),
        ]
          .filter(Boolean)
          .join(' ')}
      />

      <div className="mb-5">
        <KindFilter counts={kindCounts} active={activeKind} />
      </div>

      <div className="grid gap-5 lg:grid-cols-[19rem_minmax(0,1fr)] lg:items-start">
        <aside className="min-w-0 lg:sticky lg:top-[7.25rem]">
          <QueueList groups={groups} focusedId={focusedId} activeKind={activeKind} />
        </aside>

        <FocusedDocument
          document={{
            id: focused.id,
            source: focused.source,
            merchantName: focused.merchantName,
            totalAmount: focused.totalAmount,
            currency: focused.currency,
            documentDate: focused.documentDate,
            cardLast4: focused.cardLast4,
            documentType: focused.documentType,
            vatNumber: focused.vatNumber,
            rawText: focused.rawText,
            failureReason: focused.failureReason,
            receivedAt: focused.receivedAt,
            senderLabel: identity?.label ?? null,
          }}
          candidates={candidates}
          // A document with no candidate cannot be confirmed or rejected; the focused
          // pane shows what to do instead of buttons that cannot work.
          decidable={focusedKind !== null && isDecidable(focusedKind)}
          nextStep={focusedGroup?.nextStep ?? ''}
        />
      </div>
    </Page>
  );
}
