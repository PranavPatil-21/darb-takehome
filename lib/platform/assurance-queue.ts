import type { PrismaClient } from '@prisma/client';
import prismaDefault from '@/lib/prisma';
import { clientScopeFilter, type Actor } from '@/lib/platform/identity';
import { canVerify } from '@/lib/platform/verification';

/**
 * Attachments waiting on an independent sign-off.
 *
 * The checker's worklist. Ordered by value descending rather than by age, because the
 * purpose of a risk-based control is that the largest exposure gets looked at first — a
 * checker who works chronologically through a backlog has reintroduced the blanket
 * control the sampling exists to avoid.
 *
 * Rows the actor cannot sign off are returned too, marked, rather than filtered out. A
 * queue that silently hides a reviewer's own attachments leaves them believing the work is
 * done when it is waiting for a colleague — and the whole point of segregation of duties
 * is visible to everybody only if the blocked rows are visible.
 */

export interface AssuranceRow {
  matchId: number;
  documentId: number;
  transactionId: number;

  documentMerchant: string | null;
  documentAmount: number | null;
  documentCurrency: string | null;

  chargeMerchant: string;
  chargeAmount: number;
  chargeCurrency: string;
  chargeAt: Date;
  cardLast4: string;

  confidence: number;
  /** 'system' for an automatic attachment. */
  attachedBy: string | null;
  attachedAt: Date | null;
  automatic: boolean;

  /** Whether *this* actor may sign it off, and why not when they may not. */
  canSignOff: boolean;
  blockedReason: string;
}

export async function getAssuranceQueue(
  actor: Actor,
  prisma: PrismaClient = prismaDefault,
): Promise<AssuranceRow[]> {
  const scope = clientScopeFilter(actor);

  const matches = await prisma.documentMatch.findMany({
    where: {
      status: { in: ['CONFIRMED', 'AUTO_CONFIRMED'] },
      verificationRequired: true,
      verifiedAt: null,
      document: scope,
    },
    orderBy: [{ transaction: { amount: 'desc' } }, { id: 'asc' }],
    select: {
      id: true,
      documentId: true,
      transactionId: true,
      confidence: true,
      decidedBy: true,
      decidedAt: true,
      status: true,
      document: {
        select: { merchantName: true, totalAmount: true, currency: true },
      },
      transaction: {
        select: {
          merchantName: true,
          amount: true,
          currency: true,
          transactionAt: true,
          cardLast4: true,
        },
      },
    },
  });

  return matches.map((match) => {
    const permitted = canVerify({ verifierId: actor.id, makerId: match.decidedBy });

    return {
      matchId: match.id,
      documentId: match.documentId,
      transactionId: match.transactionId,

      documentMerchant: match.document.merchantName,
      documentAmount: match.document.totalAmount,
      documentCurrency: match.document.currency,

      chargeMerchant: match.transaction.merchantName,
      chargeAmount: match.transaction.amount,
      chargeCurrency: match.transaction.currency,
      chargeAt: match.transaction.transactionAt,
      cardLast4: match.transaction.cardLast4,

      confidence: match.confidence,
      attachedBy: match.decidedBy,
      attachedAt: match.decidedAt,
      automatic: match.status === 'AUTO_CONFIRMED',

      canSignOff: permitted.allowed,
      blockedReason: permitted.reason,
    };
  });
}
