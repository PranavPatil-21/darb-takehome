import { t } from '@/lib/content/messages';
import Link from 'next/link';
import prisma from '@/lib/prisma';
import { can, resolveActor } from '@/lib/platform/identity';
import { modulePath } from '@/lib/platform/module-config';
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
  searchParams: Promise<{ doc?: string }>;
}) {
  const { doc } = await searchParams;
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

  const waiting = await prisma.document.findMany({
    where: { status: 'NEEDS_REVIEW' },
    // Oldest first: a queue that reorders itself while being worked is a queue nobody can
    // finish, and the longest-waiting document is the one closest to a filing deadline.
    orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      merchantName: true,
      totalAmount: true,
      currency: true,
      documentDate: true,
    },
  });

  if (waiting.length === 0) {
    return (
      <Page>
        <PageHeader title={t('review.title')} />
        <EmptyState
          title={t('review.empty.title')}
          description={t('review.empty.body')}
          action={
            <Link href={modulePath()} className="text-sm underline underline-offset-4">
              Back to the overview
            </Link>
          }
        />
      </Page>
    );
  }

  const requested = doc ? Number(doc) : Number.NaN;
  const focusedId = waiting.some((d) => d.id === requested) ? requested : waiting[0].id;

  const focused = await prisma.document.findUniqueOrThrow({
    where: { id: focusedId },
    include: {
      matches: {
        where: { status: 'CANDIDATE' },
        orderBy: [{ confidence: 'desc' }, { transactionId: 'asc' }],
        include: { transaction: true },
      },
    },
  });

  // The sender's human label — "Faisal Al-Harbi (driver, card 4412)" — turns an E.164
  // number into the person a reviewer would actually go and ask.
  const identity = await prisma.senderIdentity.findUnique({
    where: { identifier: focused.senderIdentifier },
    select: { label: true },
  });

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
    <Page>
      <PageHeader
        title={t('review.title')}
        description={t('review.subtitle', { count: waiting.length })}
      />

      <div className="grid gap-8 lg:grid-cols-[18rem_1fr]">
        <aside className="min-w-0 lg:sticky lg:top-8 lg:self-start">
          <QueueList entries={waiting} focusedId={focusedId} />
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
            vatNumber: focused.vatNumber,
            rawText: focused.rawText,
            failureReason: focused.failureReason,
            receivedAt: focused.receivedAt,
            senderLabel: identity?.label ?? null,
          }}
          candidates={candidates}
        />
      </div>
    </Page>
  );
}
