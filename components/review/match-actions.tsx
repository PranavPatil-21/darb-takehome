'use client';

import { useAction } from 'next-safe-action/hooks';
import { Check, Loader2, X } from 'lucide-react';
import { confirmMatch, rejectMatch } from '@/lib/actions/review';
import { Button } from '@/components/ui/button';

/**
 * Confirm / reject buttons for one candidate.
 *
 * Both buttons disable while either action is in flight. That is a courtesy, not the
 * safeguard — the real double-submit protection is in the server action and the database
 * constraint behind it, because a disabled button protects nobody against a second tab.
 */
export function MatchActions({ matchId }: { matchId: number }) {
  const confirm = useAction(confirmMatch);
  const reject = useAction(rejectMatch);

  const pending = confirm.isPending || reject.isPending;
  const result = confirm.result.data ?? reject.result.data;
  const error = confirm.result.serverError ?? reject.result.serverError;

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={pending}
          onClick={() => confirm.execute({ matchId })}
          aria-label="Confirm this match"
        >
          {confirm.isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Check className="size-4" />
          )}
          Confirm
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => reject.execute({ matchId })}
          aria-label="Reject this match"
        >
          {reject.isPending ? <Loader2 className="size-4 animate-spin" /> : <X className="size-4" />}
          Reject
        </Button>
      </div>

      {result ? (
        <p
          className={`max-w-xs text-right text-xs ${result.ok ? 'text-muted-foreground' : 'text-rose-600'}`}
        >
          {result.message}
        </p>
      ) : null}
      {error ? <p className="max-w-xs text-right text-xs text-rose-600">{error}</p> : null}
    </div>
  );
}
