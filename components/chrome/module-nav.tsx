'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { isCurrent, type NavItem } from '@/lib/platform/navigation';
import type { NavCounts } from '@/lib/platform/counts';

/**
 * The module's navigation bar.
 *
 * A client component for one reason only — it needs the current path to mark the active
 * section, and `usePathname` is the cheapest way to get it without threading the route
 * through every page. The items and the counts are both computed on the server and passed
 * in, so no data fetching happens here.
 *
 * It renders as a strip inside the host's page rather than as a global header, because a
 * capability that assumes it owns the top of the window cannot be mounted inside anything.
 */
export function ModuleNav({
  items,
  counts,
  moduleName,
  switcher,
}: {
  items: NavItem[];
  counts: NavCounts;
  moduleName: string;
  /** Rendered by the server layout; the nav itself stays ignorant of identity. */
  switcher?: React.ReactNode;
}) {
  const pathname = usePathname();

  return (
    // Sticky, on an opaque surface. The nav carries the queue counts, which are the one
    // thing a reviewer wants visible while scrolling a 200-row register.
    <div className="sticky top-0 z-30 border-b bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80">
      <div className="mx-auto w-full max-w-[90rem] px-4 sm:px-6 lg:px-8">
        <div className="flex flex-wrap items-center justify-between gap-3 pt-3.5 pb-2">
          <span className="text-sm font-semibold tracking-[-0.006em]">{moduleName}</span>
          {switcher}
        </div>

        <nav aria-label={moduleName}>
          {/* Horizontally scrollable rather than wrapped: a nav that reflows to two rows
              moves the page content down and makes the active item jump between
              sections. */}
          <ul className="-mb-px flex gap-0.5 overflow-x-auto">
            {items.map((item) => {
              const active = isCurrent(item.href, pathname);
              const count = item.badge ? counts[item.badge] : 0;

              return (
                <li key={item.href} className="shrink-0">
                  <Link
                    href={item.href}
                    title={item.hint}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'inline-flex items-center gap-2 border-b-2 px-3 py-2.5 text-sm transition-colors',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                      active
                        ? 'border-foreground font-medium text-foreground'
                        : 'border-transparent text-muted-foreground hover:border-border hover:text-foreground',
                    )}
                  >
                    {item.label}
                    {count > 0 ? (
                      <span
                        className={cn(
                          'inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-medium tabular-nums',
                          'bg-attention text-attention-foreground ring-1 ring-inset ring-attention-border/50',
                        )}
                      >
                        {count}
                      </span>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </div>
    </div>
  );
}
