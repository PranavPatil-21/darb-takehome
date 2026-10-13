import type { PrismaClient } from '@prisma/client';
import prismaDefault from '@/lib/prisma';
import { canSeeClient, type Actor } from '@/lib/platform/identity';
import { documentHistory, type AuditEntry } from '@/lib/platform/audit';
import { decodeDocumentationStatus, decodeMatchStatus, decodeSignals } from '@/lib/domain/enums';
import type { SignalBreakdown } from '@/lib/domain/enums';
import type { TransactionDocumentationStatus } from '@/lib/platform/transaction-status';
import { t } from '@/lib/content/messages';

/**
 * Everything known about one charge, assembled for the people who have to answer for it.
 *
 * The detail page could show that a charge was documented and at what percentage. It could
 * not say whether the attachment had been countersigned, on what evidence the engine chose
 * it, or what had happened to it since — and all three were already in the database. The
 * sign-off columns sat on `DocumentMatch`, the signal breakdown sat beside the confidence
 * the page did render, and the audit trail was fetched and then dropped whenever it
 * happened to be empty.
 *
 * Assembled here rather than in the page so the shape can be tested without rendering, and
 * so a second surface asking the same questions does not re-derive the answers.
 */

export interface SignOffState {
  /** Whether this attachment was selected for independent sign-off when it was made. */
  required: boolean;
  /** Settled either way — upheld or overturned. */
  settled: boolean;
  by: string | null;
  at: Date | null;
  outcome: string | null;
  /** MATERIAL | AUTOMATIC | SAMPLED — why it was selected, snapshotted at selection. */
  trigger: string | null;
  reason: string | null;
}

export interface AttachedDocument {
  id: number;
  merchantName: string | null;
  totalAmount: number | null;
  currency: string | null;
  documentDate: Date | null;
  vatNumber: string | null;
  source: string;
  senderIdentifier: string;
  rawText: string | null;
  /** The engine's score for this pairing, and the per-signal breakdown behind it. */
  confidence: number;
  signals: SignalBreakdown;
  /** 'system' for an automatic attachment, otherwise the reviewer. */
  decidedBy: string | null;
  decidedAt: Date | null;
  automatic: boolean;
  signOff: SignOffState;
}

export interface ConsideredDocument {
  matchId: number;
  documentId: number;
  merchantName: string | null;
  totalAmount: number | null;
  currency: string | null;
  confidence: number;
  signals: SignalBreakdown;
  status: string;
  decidedBy: string | null;
}

export interface ChargeDetail {
  id: number;
  clientName: string;
  merchantName: string;
  amount: number;
  currency: string;
  transactionAt: Date;
  cardLast4: string;
  driverPhone: string | null;
  status: TransactionDocumentationStatus;
  attached: AttachedDocument | null;
  /** Every document the matcher scored against this charge, best first. */
  considered: ConsideredDocument[];
  history: AuditEntry[];
  /**
   * Shown when `history` is empty. The trail genuinely has nothing for charges attached
   * before it existed, or by a bulk import — and a section that disappears in that case
   * tells the reader nothing happened, which is a different and false claim.
   */
  historyNote: string;
}

export async function getChargeDetail(
  actor: Actor,
  chargeId: number,
  prisma: PrismaClient = prismaDefault,
): Promise<ChargeDetail | null> {
  const charge = await prisma.transaction.findUnique({
    where: { id: chargeId },
    include: {
      client: { select: { name: true } },
      confirmedDocument: {
        select: {
          id: true,
          merchantName: true,
          totalAmount: true,
          currency: true,
          documentDate: true,
          vatNumber: true,
          source: true,
          senderIdentifier: true,
          rawText: true,
        },
      },
      documents: {
        orderBy: [{ confidence: 'desc' }, { id: 'asc' }],
        include: {
          document: {
            select: { id: true, merchantName: true, totalAmount: true, currency: true },
          },
        },
      },
    },
  });

  if (!charge) return null;
  // Scoping is an absence, not a refusal: telling an actor that a charge exists but
  // belongs to somebody else is itself a disclosure.
  if (!canSeeClient(actor, charge.clientId)) return null;

  // The match that actually holds the slot. A rejected sibling can carry a stale
  // verification flag, and reading sign-off off the wrong row would report a charge as
  // awaiting countersignature when the attachment it refers to was detached long ago.
  const holding =
    charge.confirmedDocumentId === null
      ? null
      : (charge.documents.find((m) => m.documentId === charge.confirmedDocumentId) ?? null);

  const attached: AttachedDocument | null =
    charge.confirmedDocument && holding
      ? {
          ...charge.confirmedDocument,
          confidence: holding.confidence,
          signals: decodeSignals(holding.signals),
          decidedBy: holding.decidedBy,
          decidedAt: holding.decidedAt,
          automatic: decodeMatchStatus(holding.status) === 'AUTO_CONFIRMED',
          signOff: {
            required: holding.verificationRequired,
            settled: holding.verifiedAt !== null,
            by: holding.verifiedBy,
            at: holding.verifiedAt,
            outcome: holding.verificationOutcome,
            trigger: holding.verificationTrigger,
            reason: holding.verificationReason,
          },
        }
      : null;

  const history = charge.confirmedDocumentId
    ? await documentHistory(charge.confirmedDocumentId, prisma)
    : [];

  return {
    id: charge.id,
    clientName: charge.client.name,
    merchantName: charge.merchantName,
    amount: charge.amount,
    currency: charge.currency,
    transactionAt: charge.transactionAt,
    cardLast4: charge.cardLast4,
    driverPhone: charge.driverPhone,
    status: decodeDocumentationStatus(charge.documentationStatus),
    attached,
    considered: charge.documents.map((match) => ({
      matchId: match.id,
      documentId: match.documentId,
      merchantName: match.document.merchantName,
      totalAmount: match.document.totalAmount,
      currency: match.document.currency,
      confidence: match.confidence,
      signals: decodeSignals(match.signals),
      status: match.status,
      decidedBy: match.decidedBy,
    })),
    history,
    historyNote: historyNoteFor(attached),
  };
}

/** Why there is nothing in the trail, stated rather than left to inference. */
function historyNoteFor(attached: AttachedDocument | null): string {
  if (attached === null) return t('charge.history.none.unattached');
  return attached.automatic
    ? t('charge.history.none.automatic')
    : t('charge.history.none.imported');
}
