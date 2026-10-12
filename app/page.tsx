import prisma from '@/lib/prisma';
import { getCoveragePosition, getUndocumentedCharges } from '@/lib/ui/coverage';
import { CoverageHeadline } from '@/components/home/coverage-headline';
import { UndocumentedCharges } from '@/components/home/undocumented-charges';
import { DocumentLedger, type LedgerRow } from '@/components/home/document-ledger';

/**
 * The overview.
 *
 * This page used to open with a wide table of every document, sorted by database id, with
 * a coded signal breakdown under each confidence figure — a view built for whoever was
 * debugging the matcher. It now answers the question the person paying for this product
 * actually has: how much of this period's card spend has no receipt behind it, and what
 * would close the gap.
 *
 * The document list survives at the bottom, filtered by default to what still needs
 * attention. Nothing is hidden that cannot be shown with one click; it simply stops being
 * the first thing anybody reads.
 */

export const dynamic = 'force-dynamic';

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ docs?: string }>;
}) {
  const { docs } = await searchParams;
  const showingAll = docs === 'all';

  const [position, undocumented, ledger, attachedCount] = await Promise.all([
    getCoveragePosition(prisma),
    getUndocumentedCharges(prisma, 8),
    prisma.document.findMany({
      where: showingAll ? {} : { status: { not: 'MATCHED' } },
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      take: 40,
      select: {
        id: true,
        merchantName: true,
        totalAmount: true,
        currency: true,
        documentDate: true,
        status: true,
        failureReason: true,
      },
    }),
    prisma.document.count({ where: { status: 'MATCHED' } }),
  ]);

  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-10">
      <CoverageHeadline position={position} />
      <UndocumentedCharges charges={undocumented} totalCount={position.undocumentedCount} />
      <DocumentLedger
        rows={ledger as LedgerRow[]}
        showingAll={showingAll}
        hiddenCount={attachedCount}
      />
    </main>
  );
}
