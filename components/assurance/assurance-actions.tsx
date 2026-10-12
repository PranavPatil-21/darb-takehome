'use client';

import { useState } from 'react';
import { useAction } from 'next-safe-action/hooks';
import { Check, Loader2, X } from 'lucide-react';
import { overturnAttachment, upholdAttachment } from '@/lib/actions/assurance';
import { Button } from '@/components/ui/button';

/**
 * Sign off, or send back.
 *
 * The two outcomes are deliberately not symmetrical in the interface either. Upholding is
 * one click, because agreeing with a correct attachment is the common case and a control
 * that is laborious when nothing is wrong is a control people stop running. Overturning
 * opens a reason field and will not submit without one — detaching a receipt somebody
 * deliberately attached is the destructive half, and a detachment nobody has to explain is
 * one nobody can review later.
 */
export function AssuranceActions({
  matchId,
  canSignOff,
  blockedReason,
}: {
  matchId: number;
  canSignOff: boolean;
  blockedReason: string;
}) {
  const uphold = useAction(upholdAttachment);
  const overturn = useAction(overturnAttachment);
  const [showReason, setShowReason] = useState(false);
  const [reason, setReason] = useState('');

  const pending = uphold.isPending || overturn.isPending;
  const result = uphold.result.data ?? overturn.result.data;
  const error = uphold.result.serverError ?? overturn.result.serverError;

  if (!canSignOff) {
    return (
      <p className="max-w-xs text-right text-xs text-muted-foreground">{blockedReason}</p>
    );
  }

  return (
    <div className="flex w-full flex-col items-end gap-2">
      {showReason ? (
        <div className="flex w-full max-w-sm flex-col gap-2">
          <label htmlFor={`reason-${matchId}`} className="text-left text-xs text-muted-foreground">
            Why is this attachment wrong?
          </label>
          <textarea
            id={`reason-${matchId}`}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={2}
            className="w-full rounded-md border bg-background p-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            placeholder="The receipt is for the other Tamimi branch."
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setShowReason(false)} disabled={pending}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={pending || reason.trim().length < 3}
              onClick={() => overturn.execute({ matchId, reason })}
            >
              {overturn.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
              Detach it
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          <Button
            size="sm"
            className="h-9"
            disabled={pending}
            onClick={() => uphold.execute({ matchId })}
          >
            {uphold.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Check className="size-4" />
            )}
            Sign off
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-9"
            disabled={pending}
            onClick={() => setShowReason(true)}
          >
            <X className="size-4" />
            Not right
          </Button>
        </div>
      )}

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
