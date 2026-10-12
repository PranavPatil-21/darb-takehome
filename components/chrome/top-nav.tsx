import Link from 'next/link';
import prisma from '@/lib/prisma';

/**
 * Persistent navigation, with the one number worth carrying everywhere.
 *
 * Two destinations is the whole product, so this is a row of links rather than a
 * collapsible sidebar pretending there is more. The queue count travels with it because
 * it is the only figure that represents work assigned to the reader — spend coverage can
 * wait until they look at it; a document waiting on a decision cannot.
 *
 * A Server Component, so the count is read on the server and no client JavaScript ships
 * for a number that changes only when the page re-renders anyway.
 */
export async function TopNav() {
  // A chrome element must never take a page down with it: if the queue count cannot be
  // read, the navigation still renders and the rest of the page is still usable.
  const waiting = await prisma.document
    .count({ where: { status: 'NEEDS_REVIEW' } })
    .catch(() => 0);

  return (
    <header className="border-b">
      <div className="mx-auto flex w-full max-w-5xl items-center gap-6 px-6 py-3">
        <Link href="/" className="text-sm font-semibold tracking-tight">
          Darb
        </Link>

        <nav className="flex items-center gap-4 text-sm">
          <Link
            href="/"
            className="text-muted-foreground transition-colors hover:text-foreground"
          >
            Overview
          </Link>
          <Link
            href="/review"
            className="inline-flex items-center gap-2 text-muted-foreground transition-colors hover:text-foreground"
          >
            Review
            {waiting > 0 ? (
              <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-amber-100 px-1.5 text-xs tabular-nums text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                {waiting}
              </span>
            ) : null}
          </Link>
        </nav>
      </div>
    </header>
  );
}
