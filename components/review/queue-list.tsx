import { t } from '@/lib/content/messages';
import { modulePath } from '@/lib/platform/module-config';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import { formatDay, formatMinorUnits } from '@/lib/format';
import type { WorkGroup } from '@/lib/platform/work-queue';

/**
 * Everything waiting on a person, grouped by what that person has to do.
 *
 * The queue used to be a flat list of documents sharing only the property that the matcher
 * had stopped. That threw away the one thing the engine already knew — *why* it stopped —
 * and left a reviewer opening documents to find out what kind of problem each one was.
 * The groups are derived from that reason, so the categorisation costs nothing to maintain
 * and cannot disagree with the engine.
 *
 * Groups a reviewer cannot act on are still shown, and still say so. Hiding them is what
 * the old "exceptions" page did, and documents fell into the gap between the two screens.
 *
 * Each row is a plain link carrying the document in the URL, so moving between documents
 * is a server navigation with no client state to desynchronise, and a half-finished
 * review can be sent to a colleague as a URL.
 */

export function QueueList({
  groups,
  focusedId,
  activeKind,
}: {
  groups: WorkGroup[];
  focusedId: number;
  /** Carried into every row link so selecting a document keeps the filter. */
  activeKind?: string | undefined;
}) {
  // Resolved against the host's mount point rather than hardcoded. Every row and chip
  // in the queue linked to a literal `/review`, so on a mounted `/vat/review` each click
  // navigated out of the module and left the nav with no current item — and under a
  // host-configured base path it would have left the host entirely.
  const reviewPath = modulePath('review');

  const total = groups.reduce((sum, group) => sum + group.items.length, 0);

  return (
    <nav
      aria-label={t('review.queue.aria')}
      className="overflow-hidden rounded-xl border bg-card shadow-xs"
    >
      <div className="flex items-baseline justify-between gap-2 border-b bg-surface-sunken px-4 py-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t('review.queue.waiting')}
        </h2>
        <span className="text-xs font-medium tabular-nums text-muted-foreground">{total}</span>
      </div>

      {/* The queue scrolls inside its own panel rather than with the page, so the document
          being decided stays put while the reviewer looks for the next one. */}
      <div className="max-h-[calc(100vh-13rem)] overflow-y-auto overscroll-contain">
        {groups.map((group) => (
          <section key={group.kind} aria-label={group.label}>
            {/* Sticky, so a reviewer scrolling a long group never loses track of which
                kind of problem they are looking at. */}
            {/* Sunken, uppercase and tracked — the group header has to read as a
                different *kind* of thing from the rows beneath it. Sharing their
                background and type size made seven groups look like one list with odd
                bold rows in it. */}
            <h3
              className={cn(
                'sticky top-0 z-10 flex items-center justify-between gap-2 border-y bg-surface-sunken px-4 py-1.5',
                'first:border-t-0',
              )}
            >
              <span className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {/* A dot, not a sentence. The group's reasoning belongs in the focused
                    pane where it is read; in a 17rem column it was three lines of grey
                    text per group and it buried the documents themselves. */}
                <span
                  aria-hidden
                  className={cn(
                    'size-1.5 shrink-0 rounded-full',
                    group.decidable ? 'bg-attention-border' : 'bg-muted-foreground/40',
                  )}
                />
                {group.label}
              </span>
              <span className="shrink-0 text-[11px] font-medium tabular-nums text-muted-foreground">
                {group.items.length}
              </span>
            </h3>

            <ul>
              {group.items.map((item) => {
                const focused = item.id === focusedId;

                return (
                  <li key={item.id}>
                    <Link
                      href={
                        activeKind
                          ? `${reviewPath}?kind=${activeKind}&doc=${item.id}`
                          : `${reviewPath}?doc=${item.id}`
                      }
                      aria-current={focused ? 'true' : undefined}
                      className={cn(
                        'relative flex flex-col gap-0.5 border-b border-border/60 px-4 py-2.5 transition-colors last:border-b-0',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                        // A left rule rather than a filled row: the selection has to be
                        // unmistakable at a glance without turning the item into a block
                        // of colour that competes with the document beside it.
                        focused
                          ? 'bg-accent before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-foreground'
                          : 'hover:bg-accent/50',
                      )}
                    >
                      <span
                        className={cn(
                          'truncate text-sm leading-snug',
                          focused ? 'font-medium' : 'text-foreground/90',
                        )}
                      >
                        {/* An unreadable document has no merchant name, and an unregistered
                            sender is identified by who sent it rather than what it says. */}
                        {item.merchantName ??
                          (group.kind === 'SENDER_UNKNOWN'
                            ? item.senderIdentifier
                            : t('common.unreadableReceipt'))}
                      </span>
                      <span className="flex items-baseline gap-1.5 text-xs text-muted-foreground">
                        <span className="tabular-nums">
                          {formatMinorUnits(item.totalAmount, item.currency ?? 'SAR')}
                        </span>
                        <span aria-hidden>·</span>
                        <span className="tabular-nums">
                          {formatDay(item.documentDate ?? item.receivedAt)}
                        </span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </nav>
  );
}
