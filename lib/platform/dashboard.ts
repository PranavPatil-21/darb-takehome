import type { PrismaClient } from '@prisma/client';
import prismaDefault from '@/lib/prisma';
import { clientScopeFilter, type Actor } from '@/lib/platform/identity';
import { vatWithin, periodOf } from '@/lib/ui/coverage';
import {
  ageBucket,
  ageingReference,
  daysUndocumented,
  documentationStatusOf,
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
  exceptions: number;

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

  const [charges, documents, awaitingDecision, awaitingVerification, exceptions, oldestWaiting] =
    await Promise.all([
      prisma.transaction.findMany({
        where: scope,
        select: {
          amount: true,
          transactionAt: true,
          confirmedDocumentId: true,
          documents: { select: { status: true } },
        },
      }),
      prisma.document.count({ where: scope }),
      prisma.document.count({ where: { ...scope, status: 'NEEDS_REVIEW' } }),
      prisma.documentMatch.count({
        where: {
          status: { in: ['CONFIRMED', 'AUTO_CONFIRMED'] },
          verificationRequired: true,
          verifiedAt: null,
          document: scope,
        },
      }),
      prisma.document.count({
        where: {
          OR: [{ status: 'FAILED' }, { status: 'UNMATCHED', clientId: null }],
          ...scope,
        },
      }),
      prisma.document.findFirst({
        where: { ...scope, status: 'NEEDS_REVIEW' },
        orderBy: { receivedAt: 'asc' },
        select: { receivedAt: true },
      }),
    ]);

  const autoAttached = await prisma.documentMatch.count({
    where: { status: 'AUTO_CONFIRMED', document: scope },
  });

  const statusTotals = new Map<TransactionDocumentationStatus, { count: number; value: number }>();
  const ageingTotals = new Map<AgeBucket, { count: number; value: number }>();

  let totalSpend = 0;
  let documentedSpend = 0;
  let latest: Date | null = null;

  for (const charge of charges) {
    if (latest === null || charge.transactionAt > latest) latest = charge.transactionAt;
  }

  const period = periodOf(latest);
  const asOf = ageingReference(period?.to ?? null, now);

  for (const charge of charges) {
    totalSpend += charge.amount;

    const status = documentationStatusOf({
      confirmedDocumentId: charge.confirmedDocumentId,
      matches: charge.documents,
    });

    const bucketForStatus = statusTotals.get(status) ?? { count: 0, value: 0 };
    statusTotals.set(status, {
      count: bucketForStatus.count + 1,
      value: bucketForStatus.value + charge.amount,
    });

    if (status === 'DOCUMENTED') {
      documentedSpend += charge.amount;
      continue;
    }

    // Ageing describes the gap, so only undocumented charges enter it. Including settled
    // ones would make the oldest bucket grow forever and stop meaning anything.
    const bucket = ageBucket(daysUndocumented(charge.transactionAt, asOf));
    const ageRow = ageingTotals.get(bucket) ?? { count: 0, value: 0 };
    ageingTotals.set(bucket, { count: ageRow.count + 1, value: ageRow.value + charge.amount });
  }

  const undocumentedSpend = totalSpend - documentedSpend;

  const ORDERED_STATUSES: TransactionDocumentationStatus[] = [
    'MISSING',
    'IN_REVIEW',
    'REJECTED',
    'DOCUMENTED',
  ];
  const ORDERED_BUCKETS: AgeBucket[] = ['0-7', '8-30', '31-60', '60+'];

  return {
    period,
    chargeCount: charges.length,
    totalSpend,
    documentedSpend,
    undocumentedSpend,
    vatAtRisk: vatWithin(undocumentedSpend),
    coverageByValue: totalSpend === 0 ? 1 : documentedSpend / totalSpend,

    // Every status is emitted, including the empty ones: a breakdown that hides a zero
    // makes "no charges are in review" look identical to "we stopped tracking that".
    byStatus: ORDERED_STATUSES.map((status) => ({
      status,
      count: statusTotals.get(status)?.count ?? 0,
      value: statusTotals.get(status)?.value ?? 0,
    })),
    ageing: ORDERED_BUCKETS.map((bucket) => ({
      bucket,
      count: ageingTotals.get(bucket)?.count ?? 0,
      value: ageingTotals.get(bucket)?.value ?? 0,
    })),

    awaitingDecision,
    awaitingVerification,
    exceptions,

    documentsProcessed: documents,
    autoAttached,
    autoAttachRate: documents === 0 ? 0 : autoAttached / documents,

    oldestWaitingDays: oldestWaiting
      ? daysUndocumented(oldestWaiting.receivedAt, asOf)
      : null,
  };
}
