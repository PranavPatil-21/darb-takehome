import Link from 'next/link';
import { cn } from '@/lib/utils';
import { formatDay, formatMinorUnits } from '@/lib/format';

/**
 * Every document waiting on a person.
 *
 * The whole queue stays on screen while one of them is being decided. That is partly the
 * brief — `/review` is specified as listing the documents needing review — and partly
 * because a reviewer working through a queue needs to know how much is left and to be
 * able to skip a hard one without losing their place.
 *
 * Each row is a plain link carrying the document in the URL, so moving between documents
 * is a server navigation with no client state to desynchronise, and a half-finished
 * review can be sent to a colleague as a URL.
 */

export interface QueueEntry {
  id: number;
  merchantName: string | null;
  totalAmount: number | null;
  currency: string | null;
  documentDate: Date | null;
}

export function QueueList({ entries, focusedId }: { entries: QueueEntry[]; focusedId: number }) {
  return (
    <nav aria-label="Documents waiting for review">
      <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Waiting · {entries.length}
      </h2>

      <ul className="mt-2 -mx-2">
        {entries.map((entry) => {
          const focused = entry.id === focusedId;

          return (
            <li key={entry.id}>
              <Link
                href={`/review?doc=${entry.id}`}
                aria-current={focused ? 'true' : undefined}
                className={cn(
                  'block rounded-md px-2 py-2 transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  focused ? 'bg-muted' : 'hover:bg-muted/50',
                )}
              >
                <span
                  className={cn(
                    'block truncate text-sm',
                    focused ? 'font-medium' : 'text-foreground/90',
                  )}
                >
                  {entry.merchantName ?? 'Unreadable receipt'}
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground tabular-nums">
                  {formatMinorUnits(entry.totalAmount, entry.currency ?? 'SAR')} ·{' '}
                  {formatDay(entry.documentDate)}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
