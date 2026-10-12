'use client';

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
  documentId: number;
  /** e.g. "45.00 SAR at TAMIMI MARKETS 0007 RUH, 17 Jun 2025 15:10" */
  chargeLabel: string;
}) {
  const confirm = useAction(confirmMatch);
  const reject = useAction(rejectMatch);

  const pending = confirm.isPending || reject.isPending;
  const result = confirm.result.data ?? reject.result.data;
  const error = confirm.result.serverError ?? reject.result.serverError;

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
          onClick={() => confirm.execute({ matchId })}
        >
          {confirm.isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Check className="size-4" />
          )}
          <span className="hidden sm:inline">Attach to {chargeLabel}</span>
          <span className="sm:hidden">Attach</span>
        </Button>

        <Button
          size="sm"
          variant="outline"
          className="h-10"
          disabled={pending}
          onClick={() => reject.execute({ matchId })}
          aria-label={`Not this one — reject ${chargeLabel}`}
        >
          {reject.isPending ? <Loader2 className="size-4 animate-spin" /> : <X className="size-4" />}
          Not this one
        </Button>
      </div>

      {blocked ? (
        <p
          role="alert"
          className="max-w-md rounded-md bg-amber-50 px-3 py-2 text-left text-sm text-amber-900 dark:bg-amber-950/50 dark:text-amber-200"
        >
          That charge already has a receipt attached. Reject that one first if this is the
          correct receipt for it.
        </p>
      ) : null}

      {result && !blocked ? (
        <p
          className={`max-w-md text-right text-xs ${result.ok ? 'text-muted-foreground' : 'text-rose-600'}`}
        >
          {result.message}
        </p>
      ) : null}

      {error ? <p className="max-w-md text-right text-xs text-rose-600">{error}</p> : null}
    </div>
  );
}
