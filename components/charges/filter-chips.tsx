import Link from 'next/link';
import { cn } from '@/lib/utils';
import { modulePath } from '@/lib/platform/module-config';
import {
  TRANSACTION_STATUS,
  type AgeBucket,
  type TransactionDocumentationStatus,
} from '@/lib/platform/transaction-status';

/**
 * Status filters, as links rather than controls.
 *
 * Every chip is a plain anchor carrying the whole filter state, so the register is
 * shareable, back works, and no client JavaScript is involved in the primary way people
 * navigate this screen. The counts sit on the chips because the useful question is
 * usually "how many are missing" rather than "show me the missing ones" — and answering it
 * without a click is cheaper for everybody.
 */

const ORDER: TransactionDocumentationStatus[] = ['MISSING', 'IN_REVIEW', 'REJECTED', 'DOCUMENTED'];

export function FilterChips({
  counts,
  activeStatus,
  activeAge,
  query,
}: {
  counts: Record<TransactionDocumentationStatus, number>;
  activeStatus?: TransactionDocumentationStatus | undefined;
  activeAge?: AgeBucket | undefined;
  query?: string | undefined;
}) {
  const href = (status?: TransactionDocumentationStatus) => {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (activeAge) params.set('age', activeAge);
    if (query) params.set('q', query);
    const qs = params.toString();
    return qs ? `${modulePath('transactions')}?${qs}` : modulePath('transactions');
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Chip href={href()} active={!activeStatus} label="All" />
      {ORDER.map((status) => (
        <Chip
          key={status}
          href={href(status)}
          active={activeStatus === status}
          label={TRANSACTION_STATUS[status].label}
          count={counts[status]}
        />
      ))}
    </div>
  );
}

function Chip({
  href,
  active,
  label,
  count,
}: {
  href: string;
  active: boolean;
  label: string;
  count?: number;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-lg border px-3 text-xs transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active
          ? 'border-foreground bg-foreground font-medium text-background shadow-xs'
          : 'border-border bg-card text-muted-foreground shadow-xs hover:bg-accent hover:text-foreground',
      )}
    >
      {label}
      {count !== undefined ? <span className="tabular-nums opacity-70">{count}</span> : null}
    </Link>
  );
}
