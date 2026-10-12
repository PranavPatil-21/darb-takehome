import Link from 'next/link';
import { can, resolveActor } from '@/lib/platform/identity';
import { moduleConfig, modulePath } from '@/lib/platform/module-config';
import { getAssuranceQueue } from '@/lib/platform/assurance-queue';
import { formatDay, formatMinorUnits, formatPercent, formatTime } from '@/lib/format';
import { AssuranceActions } from '@/components/assurance/assurance-actions';
import { Page, PageHeader, EmptyState } from '@/components/shell/page';

/**
 * The checker's queue.
 *
 * Maker-checker's second half. Everything here is already attached — coverage counts it,
 * the slot is claimed — and what is outstanding is an independent read confirming the
 * attachment was right. That ordering is the point of a post-hoc control: the queue never
 * blocks the money, and the evidence still gets produced.
 *
 * Each row states *why* it is here, because a checker reads a material attachment
 * differently from a routine sample, and an automatic one differently again — nobody has
 * looked at that receipt at all.
 */

export const dynamic = 'force-dynamic';

export default async function AssurancePage() {
  const actor = await resolveActor();
  const config = moduleConfig();

  if (!can(actor, 'verify')) {
    return (
      <Page>
        <PageHeader title="Assurance" />
        <EmptyState
          title="You cannot sign off attachments"
          description="This queue needs the verify permission, which the host application grants."
        />
      </Page>
    );
  }

  if (config.makerChecker.mode === 'OFF') {
    return (
      <Page>
        <PageHeader title="Assurance" />
        <EmptyState
          title="Independent sign-off is switched off"
          description="Attachments stand on the decision of whoever made them. Set DARB_MAKER_CHECKER to POST_HOC and new attachments will be selected for review by value and by sampling."
        />
      </Page>
    );
  }

  const queue = await getAssuranceQueue(actor);
  // Own attachments are shown, marked, rather than filtered away. Hiding them would make
  // the queue look finished while work waits on a colleague, and would make the control
  // itself invisible — the reader would never learn why some rows cannot be actioned.
  const mine = queue.filter((row) => !row.canSignOff).length;

  return (
    <Page>
      <PageHeader
        title="Assurance"
        description={
          queue.length === 0
            ? 'Nothing is waiting on a second pair of eyes.'
            : `${queue.length} ${queue.length === 1 ? 'attachment needs' : 'attachments need'} an independent sign-off, largest first. ${
                mine === 0
                  ? 'None of them are yours, so you may sign off any.'
                  : `${mine} ${mine === 1 ? 'is' : 'are'} your own and must go to a colleague.`
              }`
        }
      />

      {queue.length === 0 ? (
        <EmptyState
          title="All clear"
          description={`Every attachment selected for review has been signed off. New ones appear here when they are above ${formatMinorUnits(config.makerChecker.materialityThreshold)}, attached automatically, or drawn by sampling.`}
        />
      ) : (
        <ul className="space-y-4">
          {queue.map((row) => (
            <li key={row.matchId} className="rounded-lg border bg-card p-4">
              <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-muted-foreground">
                    {row.automatic ? (
                      <span className="text-amber-700 dark:text-amber-400">
                        Attached automatically — no person has seen this
                      </span>
                    ) : (
                      <>Attached by {row.attachedBy}</>
                    )}
                    {row.attachedAt ? ` · ${formatDay(row.attachedAt)}` : ''} ·{' '}
                    {formatPercent(row.confidence)} match
                  </p>

                  <h2 className="mt-1 text-base font-medium">
                    <Link
                      href={modulePath('transactions', String(row.transactionId))}
                      className="underline-offset-4 hover:underline"
                    >
                      {row.chargeMerchant}
                    </Link>
                  </h2>

                  {/* Both sides, side by side. A checker is answering one question — does
                      this receipt belong to this charge — and that is a comparison, not a
                      pair of records to be looked up separately. */}
                  <dl className="mt-3 grid max-w-md grid-cols-[4.5rem_1fr_1fr] gap-x-3 gap-y-1 text-sm">
                    <dt className="text-xs text-muted-foreground">&nbsp;</dt>
                    <dd className="text-xs text-muted-foreground">Receipt</dd>
                    <dd className="text-xs text-muted-foreground">Charge</dd>

                    <dt className="text-xs text-muted-foreground">Merchant</dt>
                    <dd className="truncate">{row.documentMerchant ?? '—'}</dd>
                    <dd className="truncate">{row.chargeMerchant}</dd>

                    <dt className="text-xs text-muted-foreground">Amount</dt>
                    <dd className="tabular-nums">
                      {formatMinorUnits(row.documentAmount, row.documentCurrency ?? 'SAR')}
                    </dd>
                    <dd className="tabular-nums">
                      {formatMinorUnits(row.chargeAmount, row.chargeCurrency)}
                    </dd>

                    <dt className="text-xs text-muted-foreground">Date</dt>
                    <dd className="tabular-nums text-muted-foreground">—</dd>
                    <dd className="tabular-nums text-muted-foreground">
                      {formatDay(row.chargeAt)} · {formatTime(row.chargeAt)}
                    </dd>
                  </dl>
                </div>

                <div className="shrink-0">
                  <AssuranceActions
                    matchId={row.matchId}
                    canSignOff={row.canSignOff}
                    blockedReason={row.blockedReason}
                  />
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-8 border-t pt-4 text-xs text-muted-foreground">
        A reviewer attaches receipts; a controller does that <em>and</em> signs off other
        people&rsquo;s attachments. Nobody signs off their own, whichever role they hold —
        that rule is per attachment, not per person, which is why your own work appears
        here greyed rather than hidden.{' '}
      </p>

      <p className="mt-2 text-xs text-muted-foreground">
        Selected by value above{' '}
        {formatMinorUnits(config.makerChecker.materialityThreshold)}, by automatic
        attachment, and by {Math.round(config.makerChecker.sampleRate * 100)}% sampling of
        everything else — so &ldquo;small&rdquo; does not become a blind spot.
      </p>
    </Page>
  );
}
