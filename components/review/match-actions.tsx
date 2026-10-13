'use client';

import { useState } from 'react';

import { useAction } from 'next-safe-action/hooks';
import { Check, Loader2, X } from 'lucide-react';
import { confirmMatch, rejectMatch } from '@/lib/actions/review';
import { Button } from '@/components/ui/button';

/**
 * Confirm / reject for one candidate charge.
 *
 * The confirm button names the charge it would attach to. "Confirm" is a verb with no
 * object: on a document with two candidates it is possible to read the wrong card, move
 * the mouse, and commit — and the only feedback that anything happened is a row quietly
 * leaving the queue. Spelling the charge into the button turns the click into a sentence
 * the reader can disagree with before it is too late, which is cheaper than any undo.
 *
 * Both buttons disable while either action is in flight. That is a courtesy, not the
 * safeguard — the real double-submit protection is the server action and the database
 * constraint behind it, because a disabled button protects nobody against a second tab.
 */
export function MatchActions({
  matchId,
  chargeLabel,
}: {
  matchId: number;
  /** e.g. "45.00 SAR at TAMIMI MARKETS 0007 RUH, 17 Jun 2025 15:10" */
  chargeLabel: string;
}) {
  const confirm = useAction(confirmMatch);
  const reject = useAction(rejectMatch);

  const pending = confirm.isPending || reject.isPending;

  // Whichever action ran last wins, rather than `confirm ?? reject`.
  //
  // `useAction` results are sticky and neither hook clears the other, so the confirm
  // result always took precedence once it existed. A reviewer who hit Attach, got
  // "that charge already has a receipt", then hit Not this one, kept reading the confirm
  // message through the rejection — including while it was in flight. The card only stops
  // lying when it unmounts.
  const [lastRun, setLastRun] = useState<'confirm' | 'reject' | null>(null);
  const active = lastRun === 'reject' ? reject : lastRun === 'confirm' ? confirm : null;
  const result = active?.result.data;
  const error = active?.result.serverError;

  // A blocked confirm is the single most wrong-attach-preventing message in the product,
  // so it is stated in full rather than shown as a muted line at the card's edge.
  const blocked = result && 'effect' in result && result.effect === 'BLOCKED';

  return (
    <div className="flex w-full flex-col items-end gap-2">
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          size="sm"
          className="h-10"
          disabled={pending}
          onClick={() => { setLastRun('confirm'); confirm.execute({ matchId }); }}
          aria-label={`Attach this receipt to ${chargeLabel}`}
        >
          {confirm.isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Check className="size-4" />
          )}
          {/* The charge is named in the card's own heading directly above this button.
              Repeating it inside the label produced a 60-character slab that read as a
              banner rather than a control, and said nothing the reader had not just
              seen. The full description stays on `aria-label` for screen readers, where
              the surrounding context is not available. */}
          Attach this receipt
        </Button>

        <Button
          size="sm"
          variant="outline"
          className="h-10"
          disabled={pending}
          onClick={() => { setLastRun('reject'); reject.execute({ matchId }); }}
          aria-label={`Not this one — reject ${chargeLabel}`}
        >
          {reject.isPending ? <Loader2 className="size-4 animate-spin" /> : <X className="size-4" />}
          Not this one
        </Button>
      </div>

      {blocked ? (
        <p
          role="alert"
          className="max-w-md rounded-lg border border-attention-border/60 bg-attention px-3 py-2 text-left text-sm text-attention-foreground"
        >
          That charge already has a receipt attached. Reject that one first if this is the
          correct receipt for it.
        </p>
      ) : null}

      {/* Announced, not just shown. The outcome of attaching a receipt to money is the
          thing the operator is waiting on, and a bare paragraph tells a screen-reader or
          keyboard user nothing happened. `polite` rather than `assertive` because the
          button they pressed is the context. */}
      {result && !blocked ? (
        <p
          role="status"
          aria-live="polite"
          className={`max-w-md text-right text-xs ${result.ok ? 'text-muted-foreground' : 'text-rose-600 dark:text-rose-400'}`}
        >
          {result.message}
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="max-w-md text-right text-xs text-rose-600 dark:text-rose-400">
          {error}
        </p>
      ) : null}
    </div>
  );
}
