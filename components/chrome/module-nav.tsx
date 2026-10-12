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
}: {
  items: NavItem[];
  counts: NavCounts;
  moduleName: string;
}) {
  const pathname = usePathname();

  return (
    <div className="border-b">
      <div className="mx-auto w-full max-w-6xl px-6">
        <div className="flex items-center gap-6 py-3">
          <span className="text-sm font-semibold tracking-tight">{moduleName}</span>
        </div>

        <nav aria-label={moduleName}>
          {/* Horizontally scrollable rather than wrapped: a nav that reflows to two rows
              moves the page content down and makes the active item jump between
              sections. */}
          <ul className="-mb-px flex gap-1 overflow-x-auto">
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
                      'inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm transition-colors',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                      active
                        ? 'border-foreground font-medium text-foreground'
                        : 'border-transparent text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {item.label}
                    {count > 0 ? (
                      <span
                        className={cn(
                          'inline-flex min-w-5 items-center justify-center rounded-full px-1.5 text-xs tabular-nums',
                          item.badge === 'exceptions'
                            ? 'bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200'
                            : 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
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
