import Link from 'next/link';
import { modulePath } from '@/lib/platform/module-config';
import { cn } from '@/lib/utils';
import { WORK_KINDS, isDecidable, type WorkKind } from '@/lib/platform/work-queue';
import { workKindLabel } from '@/lib/content/messages';

/**
 * Narrow the queue to one kind of work.
 *
 * The groups already separate the kinds visually, which answers "what is waiting". This
 * answers a different question — "let me do only this" — and it is the one a reviewer
 * working a backlog actually has: picking between tied charges and chasing drivers for
 * unreadable photos are different tasks, often different sittings, sometimes different
 * people.
 *
 * Counts are of the whole queue rather than the filtered view, so a chip says how much
 * work selecting it would reveal. They come from `getWorkKindCounts`, which deliberately
 * ignores the active filter.
 *
 * Driven entirely by the URL, like the charge register's filters: no client state, the
 * view is shareable, and the back button behaves.
 */
export function KindFilter({
  counts,
  active,
}: {
  counts: Record<WorkKind, number>;
  active: WorkKind | undefined;
}) {
  // Resolved against the host's mount point rather than hardcoded. Every row and chip
  // in the queue linked to a literal `/review`, so on a mounted `/vat/review` each click
  // navigated out of the module and left the nav with no current item — and under a
  // host-configured base path it would have left the host entirely.
  const reviewPath = modulePath('review');

  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  // A chip for something with nothing in it is a dead control.
  const present = WORK_KINDS.filter((kind) => counts[kind] > 0);

  if (present.length < 2) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Chip href={reviewPath} label="All" count={total} active={active === undefined} />
      {present.map((kind) => (
        <Chip
          key={kind}
          href={`${reviewPath}?kind=${kind}`}
          label={workKindLabel(kind)}
          count={counts[kind]}
          active={active === kind}
          // Blocked work is marked so a reviewer choosing a chip knows before they click
          // whether it leads to decisions or to a different kind of errand.
          muted={!isDecidable(kind)}
        />
      ))}
    </div>
  );
}

function Chip({
  href,
  label,
  count,
  active,
  muted = false,
}: {
  href: string;
  label: string;
  count: number;
  active: boolean;
  muted?: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-lg border px-3 text-xs shadow-xs transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active
          ? 'border-foreground bg-foreground font-medium text-background'
          : 'border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
    >
      {!active && muted ? (
        <span aria-hidden className="size-1.5 rounded-full bg-muted-foreground/40" />
      ) : null}
      {label}
      <span className={cn('tabular-nums', active ? 'opacity-70' : 'opacity-60')}>{count}</span>
    </Link>
  );
}
