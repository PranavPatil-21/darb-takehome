import Link from 'next/link';
import prisma from '@/lib/prisma';
import { moduleConfig, modulePath } from '@/lib/platform/module-config';
import { MODULE_BASE_PATH } from '@/lib/platform/module-config';

/**
 * The host application, stood in for.
 *
 * This route used to be a second dashboard, duplicating the one inside the module with a
 * different design — which is exactly the incoherence of two products in one codebase.
 * What belongs here instead is the thing the capability is actually built to live inside:
 * somebody else's application, which owns its own navigation and hands this feature a
 * mount point.
 *
 * So this page is deliberately plain. It is not part of the product being evaluated; it is
 * the frame around it, and its only job is to make the seam visible — one link, into
 * `modulePath()`, which is wherever the host chose to mount the capability.
 */

export const dynamic = 'force-dynamic';

export default async function HostShellPage() {
  const config = moduleConfig();

  const [needsReview, charges] = await Promise.all([
    prisma.document.count({ where: { status: 'NEEDS_REVIEW' } }).catch(() => 0),
    prisma.transaction.count().catch(() => 0),
  ]);

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-16">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">
        Host application
      </p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Darb Fleet</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        This page stands in for whatever product the receipt-matching capability is mounted
        inside. The host owns its own navigation, its own users and every route outside the
        mount point below.
      </p>

      <div className="mt-8 rounded-lg border bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="font-medium">{config.moduleName}</h2>
            <p className="mt-1 max-w-md text-sm text-muted-foreground">
              Mounted at <code className="text-xs">{MODULE_BASE_PATH}</code>. Receipts arrive
              by WhatsApp and email, are read by OCR and matched to card charges; anything
              the engine will not decide goes to a person.
            </p>
            <p className="mt-2 text-xs text-muted-foreground tabular-nums">
              {charges} charges tracked · {needsReview} waiting on a decision
            </p>
          </div>

          <Link
            href={modulePath()}
            className="inline-flex h-10 shrink-0 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            Open {config.moduleName}
          </Link>
        </div>
      </div>

      <p className="mt-6 text-xs text-muted-foreground">
        The capability reaches the host through two seams and nothing else:{' '}
        <code className="text-xs">setActorResolver</code> for identity and permissions, and{' '}
        <code className="text-xs">configureModule</code> for the mount path and control
        posture. It never reads a session, and it owns only its own tables.
      </p>
    </div>
  );
}
