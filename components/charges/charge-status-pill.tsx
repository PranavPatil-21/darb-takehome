import { t } from '@/lib/content/messages';
import { cn } from '@/lib/utils';
import {
  TRANSACTION_STATUS,
  type TransactionDocumentationStatus,
} from '@/lib/platform/transaction-status';

/**
 * A charge's documentation status.
 *
 * The "awaiting sign-off" variant is deliberately a modifier on DOCUMENTED rather than a
 * fifth status. The receipt genuinely is attached — coverage counts it, the slot is
 * claimed, and an auditor sampling that line finds evidence. What is outstanding is the
 * second read, which is a property of the control rather than of the charge, and
 * promoting it to a status of its own would make the coverage figure and the status column
 * disagree about the same row.
 */

const TONE: Record<string, string> = {
  settled:
    'bg-emerald-50 text-emerald-800 ring-emerald-600/20 dark:bg-emerald-950/50 dark:text-emerald-300 dark:ring-emerald-400/20',
  attention:
    'bg-amber-50 text-amber-900 ring-amber-600/25 dark:bg-amber-950/50 dark:text-amber-200 dark:ring-amber-400/20',
  waiting:
    'bg-slate-50 text-slate-700 ring-slate-500/20 dark:bg-slate-900 dark:text-slate-300 dark:ring-slate-400/20',
  neutral: 'bg-muted text-muted-foreground ring-border',
};

export function ChargeStatusPill({
  status,
  awaitingVerification = false,
}: {
  status: TransactionDocumentationStatus;
  awaitingVerification?: boolean;
}) {
  const presentation = TRANSACTION_STATUS[status];

  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        title={presentation.hint}
        className={cn(
          'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs ring-1 ring-inset',
          TONE[presentation.tone],
        )}
      >
        {presentation.label}
      </span>

      {awaitingVerification ? (
        <span
          title={t('chargeStatus.awaitingSignOff.hint')}
          className="text-xs text-muted-foreground"
        >
          · sign-off due
        </span>
      ) : null}
    </span>
  );
}
