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
  status?: DocumentStatus;
  query?: string;
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

  const [documents, grouped] = await Promise.all([
    prisma.document.findMany({
      where: {
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
      },
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
    matchedCount: documents.length,
    statusCounts,
    truncated: documents.length > PAGE_LIMIT,
  };
}

export interface ExceptionRow extends DocumentRow {
  /** Which kind of stuck this is, because each needs a different person. */
  kind: 'UNREADABLE' | 'UNKNOWN_SENDER' | 'DUPLICATE_CLAIM';
  whatToDo: string;
}

/**
 * Everything the happy path could not place.
 *
 * Three genuinely distinct conditions, kept apart because they route to different people.
 * An unreadable scan is a problem for whoever can re-photograph it; an unregistered sender
 * is an onboarding gap somebody with admin access closes in a minute; a duplicate claim is
 * a judgement call for a reviewer. Collapsing them into one "problems" list is how a
 * backlog becomes a bin nobody opens.
 */
export async function getExceptions(
  actor: Actor,
  prisma: PrismaClient = prismaDefault,
): Promise<ExceptionRow[]> {
  const scope = clientScopeFilter(actor);

  const documents = await prisma.document.findMany({
    where: {
      OR: [
        { status: 'FAILED' },
        { status: 'UNMATCHED', clientId: null },
        { status: 'NEEDS_REVIEW', failureReason: 'TRANSACTION_ALREADY_DOCUMENTED' },
      ],
      ...scope,
    },
    orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
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
      clientId: true,
      confirmedForTransaction: { select: { id: true } },
    },
  });

  return documents.map((d) => {
    const kind: ExceptionRow['kind'] =
      d.status === 'FAILED'
        ? 'UNREADABLE'
        : d.clientId === null
          ? 'UNKNOWN_SENDER'
          : 'DUPLICATE_CLAIM';

    return {
      id: d.id,
      source: d.source,
      senderIdentifier: d.senderIdentifier,
      senderLabel: null,
      merchantName: d.merchantName,
      totalAmount: d.totalAmount,
      currency: d.currency,
      documentDate: d.documentDate,
      receivedAt: d.receivedAt,
      status: d.status,
      failureReason: d.failureReason,
      attachedTransactionId: d.confirmedForTransaction?.id ?? null,
      kind,
      whatToDo:
        kind === 'UNREADABLE'
          ? 'Nothing usable was read. Ask the driver to send a clearer photo.'
          : kind === 'UNKNOWN_SENDER'
            ? 'Nobody has registered this sender, so the document cannot be scoped to a client. Register them and it will be matched automatically.'
            : 'The best-matching charge already has a receipt. One of the two is wrong — decide which in the review queue.',
    };
  });
}

export const EXCEPTION_KIND_LABEL: Readonly<Record<ExceptionRow['kind'], string>> = {
  UNREADABLE: 'Could not be read',
  UNKNOWN_SENDER: 'Sender not registered',
  DUPLICATE_CLAIM: 'Charge already documented',
};
