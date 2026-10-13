import type { PrismaClient } from '@prisma/client';
import prismaDefault from '@/lib/prisma';
import { clientScopeFilter, type Actor } from '@/lib/platform/identity';
import { decodeDocumentationStatus } from '@/lib/domain/enums';
import { getWorkCounts } from '@/lib/platform/work-queue';
import { vatWithin, periodOf } from '@/lib/ui/coverage';
import {
  ageBucketRange,
  ageingReference,
  daysUndocumented,
  type AgeBucket,
  type TransactionDocumentationStatus,
} from '@/lib/platform/transaction-status';

/**
 * Everything the overview screen needs, in one pass.
 *
 * The constraint shaping this module is that a dashboard must not become a page that runs
 * fifteen queries to render numbers nobody acts on. So every figure here answers a
 * question somebody asks out loud — how exposed are we, what is on my desk, is the engine
 * still working, what is going stale — and anything that merely went up since yesterday is
 * not computed at all.
 *
 * Charges are loaded once with their matches and reduced in memory rather than counted
 * with a query per status. At this size that is plainly correct; at a size where it is
 * not, the fix is a materialised projection, and the shape of this function is what such
 * a projection would have to produce.
 */

export interface StatusBreakdown {
  status: TransactionDocumentationStatus;
  count: number;
  value: number;
}

export interface AgeingRow {
  bucket: AgeBucket;
  count: number;
  value: number;
}

export interface DashboardData {
  period: { label: string; from: Date; to: Date } | null;

  chargeCount: number;
  totalSpend: number;
  documentedSpend: number;
  undocumentedSpend: number;
  vatAtRisk: number;
  coverageByValue: number;

  byStatus: StatusBreakdown[];
  ageing: AgeingRow[];

  /** Work waiting on a person, split by whose desk it is. */
  awaitingDecision: number;
  awaitingVerification: number;
  /** Waiting, but not on a confirm/reject — these need a different kind of fix. */
  blocked: number;

  /** How the engine is performing — the number that detects a silent regression. */
  documentsProcessed: number;
  autoAttached: number;
  autoAttachRate: number;

  /** The oldest thing still waiting on a human, in days. */
  oldestWaitingDays: number | null;
}

export async function getDashboard(
  actor: Actor,
  now: Date,
  prisma: PrismaClient = prismaDefault,
): Promise<DashboardData> {
  const scope = clientScopeFilter(actor);

  // The newest charge fixes the reporting period, and the period fixes the ageing
  // reference. One indexed read instead of scanning every charge for a maximum.
  const newest = await prisma.transaction.findFirst({
    where: scope,
    orderBy: { transactionAt: 'desc' },
    select: { transactionAt: true },
  });
  const period = periodOf(newest?.transactionAt ?? null);
  const asOf = ageingReference(period?.to ?? null, now);

  const ORDERED_BUCKETS: AgeBucket[] = ['0-7', '8-30', '31-60', '60+'];

  const [statusTotals, documents, work, awaitingVerification, oldestWaiting, ageingTotals] =
    await Promise.all([
      // Count and value per status in one grouping, rather than loading every charge and
      // its matches into Node to add them up. This is what the stored status bought.
      prisma.transaction.groupBy({
        by: ['documentationStatus'],
        where: scope,
        _count: true,
        _sum: { amount: true },
      }),
      prisma.document.count({ where: scope }),
      // Both numbers from the one taxonomy the queue is built from, so the figure on the
      // overview and the rows behind it cannot drift apart.
      getWorkCounts(actor, prisma),
      prisma.documentMatch.count({
        where: {
          status: { in: ['CONFIRMED', 'AUTO_CONFIRMED'] },
          verificationRequired: true,
          verifiedAt: null,
          document: scope,
        },
      }),
      // Oldest across everything still waiting, not just what is decidable. The figure
      // answers "how long has something been sitting here", and a document nobody can
      // decide has been sitting there just the same.
      prisma.document.findFirst({
        where: { ...scope, status: { in: ['NEEDS_REVIEW', 'UNMATCHED', 'FAILED'] } },
        orderBy: { receivedAt: 'asc' },
        select: { receivedAt: true },
      }),
      // One aggregate per ageing band, each an indexed range on `transactionAt`. Four
      // small queries beat one unbounded scan, and they run concurrently.
      Promise.all(
        ORDERED_BUCKETS.map(async (bucket) => ({
          bucket,
          ...(await prisma.transaction.aggregate({
            where: {
              ...scope,
              // Ageing describes the gap, so only undocumented charges enter it.
              // Including settled ones would make the oldest bucket grow forever.
              documentationStatus: { not: 'DOCUMENTED' },
              transactionAt: ageBucketRange(bucket, asOf),
            },
            _count: true,
            _sum: { amount: true },
          })),
        })),
      ),
    ]);

  const autoAttached = await prisma.documentMatch.count({
    where: { status: 'AUTO_CONFIRMED', document: scope },
  });

  const byStatusTotals = new Map<TransactionDocumentationStatus, { count: number; value: number }>();
  for (const row of statusTotals) {
    byStatusTotals.set(decodeDocumentationStatus(row.documentationStatus), {
      count: row._count,
      value: row._sum.amount ?? 0,
    });
  }

  const chargeCount = statusTotals.reduce((sum, row) => sum + row._count, 0);
  const totalSpend = statusTotals.reduce((sum, row) => sum + (row._sum.amount ?? 0), 0);
  const documentedSpend = byStatusTotals.get('DOCUMENTED')?.value ?? 0;

  const undocumentedSpend = totalSpend - documentedSpend;

  const ORDERED_STATUSES: TransactionDocumentationStatus[] = [
    'MISSING',
    'IN_REVIEW',
    'REJECTED',
    'DOCUMENTED',
  ];

  return {
    period,
    chargeCount,
    totalSpend,
    documentedSpend,
    undocumentedSpend,
    vatAtRisk: vatWithin(undocumentedSpend),
    coverageByValue: totalSpend === 0 ? 1 : documentedSpend / totalSpend,

    // Every status is emitted, including the empty ones: a breakdown that hides a zero
    // makes "no charges are in review" look identical to "we stopped tracking that".
    byStatus: ORDERED_STATUSES.map((status) => ({
      status,
      count: byStatusTotals.get(status)?.count ?? 0,
      value: byStatusTotals.get(status)?.value ?? 0,
    })),
    ageing: ageingTotals.map((row) => ({
      bucket: row.bucket,
      count: row._count,
      value: row._sum.amount ?? 0,
    })),

    awaitingDecision: work.decidable,
    awaitingVerification,
    blocked: work.blocked,

    documentsProcessed: documents,
    autoAttached,
    autoAttachRate: documents === 0 ? 0 : autoAttached / documents,

    // Against `now`, not `asOf`. `asOf` is the end of the period the *charge* data covers
    // — freezing a closed month so it stops ageing — and a document's wait has nothing to
    // do with it. A receipt that arrived in September measured against a June reference
    // produced a negative gap, which the clamp turned into zero: the one figure whose job
    // is to surface a stalled pipeline read "< 1 day" after a month of silence.
    oldestWaitingDays: oldestWaiting
      ? daysUndocumented(oldestWaiting.receivedAt, now)
      : null,
  };
}
