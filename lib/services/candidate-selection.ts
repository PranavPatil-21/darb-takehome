import type { PrismaClient } from '@prisma/client';
import { MAX_DATE_DRIFT_DAYS } from '@/lib/matching/scoring-config';
import type { CandidateTransaction, MatchableDocument } from '@/lib/services/transaction-matcher';

/**
 * Builds the candidate set the matcher scores against.
 *
 * Two jobs, in this order of importance:
 *  1. **Enforce scope.** A WhatsApp document reaches only its driver's transactions; an
 *     email document only its client's. This is a WHERE clause, not a ranking input —
 *     see `scopeVeto` in the matcher for why scoping is never allowed to be outvoted.
 *  2. **Keep the set small.** Scoring is cheap but not free, and a fleet accumulates
 *     thousands of transactions. The date window bounds the query.
 */

/**
 * When the document has no readable date we cannot anchor a tight window, so we fall
 * back to a month around the delivery time. Wider, but still bounded — and the matcher's
 * own date signal is absent in that case, so nothing is gained by widening further.
 */
const UNDATED_DOCUMENT_WINDOW_DAYS = 30;
const MS_PER_DAY = 86_400_000;

export function candidateWindow(doc: MatchableDocument, receivedAt: Date): { from: Date; to: Date } {
  const parsed = doc.documentDate ? new Date(doc.documentDate) : null;
  const anchor = parsed && !Number.isNaN(parsed.getTime()) ? parsed : receivedAt;
  const radiusDays = parsed && !Number.isNaN(parsed.getTime())
    ? MAX_DATE_DRIFT_DAYS
    : UNDATED_DOCUMENT_WINDOW_DAYS;

  return {
    from: new Date(anchor.getTime() - radiusDays * MS_PER_DAY),
    // Transactions can post after the receipt is printed, so the window is two-sided.
    to: new Date(anchor.getTime() + radiusDays * MS_PER_DAY),
  };
}

export async function selectCandidateTransactions(
  prisma: PrismaClient,
  doc: MatchableDocument,
  receivedAt: Date,
  /**
   * Transaction ids a human has already rejected for this document.
   *
   * Excluded from the set rather than filtered afterwards, so the matcher never ranks a
   * pairing a person has ruled out — which also keeps the ambiguity margin honest, since
   * a dead candidate must not be what pushes a live one into review.
   */
  excludeTransactionIds: readonly number[] = [],
): Promise<CandidateTransaction[]> {
  if (doc.clientId === null) return [];

  const { from, to } = candidateWindow(doc, receivedAt);

  const rows = await prisma.transaction.findMany({
    where: {
      clientId: doc.clientId,
      transactionAt: { gte: from, lte: to },
      ...(excludeTransactionIds.length > 0 ? { id: { notIn: [...excludeTransactionIds] } } : {}),
      // A WhatsApp document from a known driver may only see that driver's cards.
      ...(doc.source === 'WHATSAPP' && doc.driverPhone !== null
        ? { driverPhone: doc.driverPhone }
        : {}),
    },
    select: {
      id: true,
      clientId: true,
      cardLast4: true,
      driverPhone: true,
      merchantName: true,
      amount: true,
      currency: true,
      transactionAt: true,
      confirmedDocumentId: true,
    },
    orderBy: { id: 'asc' },
  });

  return rows.map((row) => ({
    id: row.id,
    clientId: row.clientId,
    cardLast4: row.cardLast4,
    driverPhone: row.driverPhone,
    merchantName: row.merchantName,
    amount: row.amount,
    currency: row.currency,
    transactionAt: row.transactionAt,
    // Loaded here so `matchDocument` can stay a pure function.
    hasConfirmedDocument: row.confirmedDocumentId !== null,
  }));
}
