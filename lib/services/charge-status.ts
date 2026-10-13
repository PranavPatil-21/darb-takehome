import type { Prisma, PrismaClient } from '@prisma/client';
import { decodeMatchStatus } from '@/lib/domain/enums';
import {
  documentationStatusOf,
  type TransactionDocumentationStatus,
} from '@/lib/platform/transaction-status';

/**
 * The one writer of `Transaction.documentationStatus`.
 *
 * The status is derived from two things — whether the charge holds a confirmed document,
 * and what its candidate matches say. Both change on seven different write paths, so the
 * cache has seven chances to go stale. Funnelling every one of them through a single
 * function is what makes the set of places that can break it enumerable, and what makes
 * "did you remember to recompute" a question with one answer rather than seven.
 *
 * It deliberately re-reads rather than accepting a status from the caller. A caller that
 * already believes it knows the new state is a caller that can be wrong — the whole point
 * is that the column agrees with the relations, and the only way to be sure is to look.
 */

type Client = PrismaClient | Prisma.TransactionClient;

export async function recomputeDocumentationStatus(
  prisma: Client,
  transactionId: number,
): Promise<TransactionDocumentationStatus | null> {
  const charge = await prisma.transaction.findUnique({
    where: { id: transactionId },
    select: {
      confirmedDocumentId: true,
      documents: { select: { status: true } },
    },
  });

  // The charge was deleted underneath us. Nothing to maintain, and throwing here would
  // fail a decision that otherwise succeeded.
  if (!charge) return null;

  const status = documentationStatusOf({
    confirmedDocumentId: charge.confirmedDocumentId,
    matches: charge.documents.map((m) => ({ status: decodeMatchStatus(m.status) })),
  });

  await prisma.transaction.update({
    where: { id: transactionId },
    data: { documentationStatus: status },
  });

  return status;
}

/**
 * Recompute several charges, de-duplicated.
 *
 * Confirming one candidate rejects its siblings, which touches every charge those
 * siblings pointed at. Callers assemble the affected ids and hand them over together
 * rather than looping — one place decides what "affected" means.
 */
export async function recomputeDocumentationStatuses(
  prisma: Client,
  transactionIds: readonly number[],
): Promise<void> {
  for (const id of new Set(transactionIds)) {
    await recomputeDocumentationStatus(prisma, id);
  }
}
