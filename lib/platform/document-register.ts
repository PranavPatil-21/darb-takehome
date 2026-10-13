import type { PrismaClient } from '@prisma/client';
import prismaDefault from '@/lib/prisma';
import { clientScopeFilter, type Actor } from '@/lib/platform/identity';
import type { DocumentStatus } from '@/lib/domain/enums';

/**
 * The inbox side of the ledger: everything that arrived, whatever became of it.
 *
 * The charge register answers "is this spend supported". This answers the other question,
 * which gets asked just as often and had nowhere to live: a driver says they definitely
 * sent the receipt, and somebody has to find out whether it arrived, what was read off it,
 * and where it went.
 */

export interface DocumentRow {
  id: number;
  source: string;
  senderIdentifier: string;
  senderLabel: string | null;
  merchantName: string | null;
  totalAmount: number | null;
  currency: string | null;
  documentDate: Date | null;
  receivedAt: Date;
  status: string;
  failureReason: string | null;
  /** The charge it ended up on, when it got one. */
  attachedTransactionId: number | null;
}

export interface DocumentFilter {
  // `| undefined` is explicit because callers build these straight from `searchParams`,
  // where an absent filter is literally the value `undefined` rather than a missing key.
  status?: DocumentStatus | undefined;
  query?: string | undefined;
}

export interface DocumentRegisterResult {
  rows: DocumentRow[];
  matchedCount: number;
  statusCounts: Record<string, number>;
  truncated: boolean;
}

const PAGE_LIMIT = 200;

export async function getDocumentRegister(
  actor: Actor,
  filter: DocumentFilter,
  prisma: PrismaClient = prismaDefault,
): Promise<DocumentRegisterResult> {
  const scope = clientScopeFilter(actor);
  const query = filter.query?.trim();

  const where = {
    ...scope,
    ...(filter.status ? { status: filter.status } : {}),
    ...(query
      ? {
          OR: [
            { merchantName: { contains: query } },
            { senderIdentifier: { contains: query } },
            { vatNumber: { contains: query } },
          ],
        }
      : {}),
  };

  const [documents, grouped, matchedCount] = await Promise.all([
    prisma.document.findMany({
      where,
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      take: PAGE_LIMIT + 1,
      select: {
        id: true,
        source: true,
        senderIdentifier: true,
        merchantName: true,
        totalAmount: true,
        currency: true,
        documentDate: true,
        receivedAt: true,
        status: true,
        failureReason: true,
        confirmedForTransaction: { select: { id: true } },
      },
    }),
    prisma.document.groupBy({ by: ['status'], where: scope, _count: { _all: true } }),
    // A real count over the whole filtered set, not the length of the page.
    // `Math.min(documents.length, PAGE_LIMIT)` reported 200 whatever the true total was,
    // so the register could silently stop at 200 of 500 with the number agreeing that
    // there were 200. The charge register has always counted properly; this matches it.
    prisma.document.count({ where }),
  ]);

  // One lookup for every sender on the page rather than a join per row: the label is a
  // nicety and must not cost a query each.
  const identifiers = [...new Set(documents.map((d) => d.senderIdentifier))];
  const identities = await prisma.senderIdentity.findMany({
    where: { identifier: { in: identifiers } },
    select: { identifier: true, label: true },
  });
  const labels = new Map(identities.map((i) => [i.identifier, i.label]));

  const statusCounts: Record<string, number> = {};
  for (const row of grouped) statusCounts[row.status] = row._count._all;

  return {
    rows: documents.slice(0, PAGE_LIMIT).map((d) => ({
      id: d.id,
      source: d.source,
      senderIdentifier: d.senderIdentifier,
      senderLabel: labels.get(d.senderIdentifier) ?? null,
      merchantName: d.merchantName,
      totalAmount: d.totalAmount,
      currency: d.currency,
      documentDate: d.documentDate,
      receivedAt: d.receivedAt,
      status: d.status,
      failureReason: d.failureReason,
      attachedTransactionId: d.confirmedForTransaction?.id ?? null,
    })),
    matchedCount,
    statusCounts,
    truncated: documents.length > PAGE_LIMIT,
  };
}
