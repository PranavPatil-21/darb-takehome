import { cn } from '@/lib/utils';
import { formatDay } from '@/lib/format';
import { t } from '@/lib/content/messages';
import { TRIGGER_COPY, type VerificationTrigger } from '@/lib/platform/verification';
import type { SignOffState as State } from '@/lib/platform/charge-detail';

/**
 * Whether somebody independent has countersigned this attachment.
 *
 * It is a separate fact from whether the charge is documented, and the detail page used to
 * show only the first — while nearly a hundred attachments sat waiting for the second. A
 * charge can be perfectly documented and still be one of the ones a controller has to look
 * at before the filing, and the person on the charge page is exactly who needs to know.
 */
/** The stored trigger is an untrusted string like any other column read back. */
function triggerCopy(trigger: string | null): string | null {
  if (trigger === null) return null;
  return TRIGGER_COPY[trigger as VerificationTrigger] ?? null;
}

export function SignOffState({ state }: { state: State }) {
  const tone = !state.required
    ? 'neutral'
    : !state.settled
      ? 'pending'
      : state.outcome === 'OVERTURNED'
        ? 'bad'
        : 'good';

  const label = !state.required
    ? t('charge.signOff.notRequired')
    : !state.settled
      ? t('charge.signOff.pending')
      : state.outcome === 'OVERTURNED'
        ? t('charge.signOff.overturned')
        : t('charge.signOff.upheld');

  return (
    <div
      className={cn(
        'rounded-xl border p-4 shadow-xs',
        tone === 'pending' && 'border-attention-border/60 bg-attention text-attention-foreground',
        tone === 'bad' && 'border-destructive/40 bg-destructive/5',
        (tone === 'good' || tone === 'neutral') && 'bg-card',
      )}
    >
      <p className="text-sm font-medium">{label}</p>

      {state.required ? (
        <p className="mt-1 text-xs leading-relaxed opacity-90">
          {/* Why it was selected, snapshotted when the attachment was made — the policy
              that chose it can change later, and a checker reading "sampled" on something
              picked for its value would misjudge how carefully to look. */}
          {state.reason ?? triggerCopy(state.trigger)}
          {state.settled && state.by ? (
            <>
              {' '}
              {state.outcome === 'OVERTURNED' ? 'Overturned' : 'Signed off'} by {state.by}
              {state.at ? ` on ${formatDay(state.at)}` : ''}.
            </>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
