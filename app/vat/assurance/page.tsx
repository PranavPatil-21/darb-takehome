import Link from 'next/link';
import { can, resolveActor } from '@/lib/platform/identity';
import { moduleConfig, modulePath } from '@/lib/platform/module-config';
import { getAssuranceQueue } from '@/lib/platform/assurance-queue';
import { formatDay, formatMinorUnits, formatPercent, formatTime } from '@/lib/format';
import { AssuranceActions } from '@/components/assurance/assurance-actions';

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
      <main className="mx-auto w-full max-w-5xl px-6 py-10">
        <h1 className="text-xl font-semibold tracking-tight">Assurance</h1>
        <div className="mt-8 rounded-lg border bg-card p-10 text-center">
          <p className="font-medium">This queue is not yours</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            Signing off an attachment requires the <code className="text-xs">verify</code>{' '}
            permission, and it is deliberately separate from the permission to attach — the
            person who made a decision cannot be the one who approves it.
          </p>
        </div>
      </main>
    );
  }

  if (config.makerChecker.mode === 'OFF') {
    return (
      <main className="mx-auto w-full max-w-5xl px-6 py-10">
        <h1 className="text-xl font-semibold tracking-tight">Assurance</h1>
        <div className="mt-8 rounded-lg border bg-card p-10 text-center">
          <p className="font-medium">Independent sign-off is switched off</p>
          <p className="mx-auto mt-1 max-w-lg text-sm text-muted-foreground">
            Attachments stand on the decision of whoever made them. Turn the control on by
            setting <code className="text-xs">DARB_MAKER_CHECKER</code> to{' '}
            <code className="text-xs">POST_HOC</code>, and new attachments will be selected
            for review by value and by sampling.
          </p>
        </div>
      </main>
    );
  }

  const queue = await getAssuranceQueue(actor);

  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-10">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Assurance</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {queue.length === 0
            ? 'Nothing is waiting on a second pair of eyes.'
            : `${queue.length} ${queue.length === 1 ? 'attachment needs' : 'attachments need'} an independent sign-off. Largest first.`}
        </p>
      </header>

      {queue.length === 0 ? (
        <div className="mt-8 rounded-lg border bg-card p-10 text-center">
          <p className="font-medium">All clear</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            Every attachment selected for review has been signed off. New ones appear here
            when they are above {formatMinorUnits(config.makerChecker.materialityThreshold)},
            attached automatically, or drawn by sampling.
          </p>
        </div>
      ) : (
        <ul className="mt-6 space-y-4">
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
        Selected by value above{' '}
        {formatMinorUnits(config.makerChecker.materialityThreshold)}, by automatic
        attachment, and by {Math.round(config.makerChecker.sampleRate * 100)}% sampling of
        everything else — so &ldquo;small&rdquo; does not become a blind spot.
      </p>
    </main>
  );
}
