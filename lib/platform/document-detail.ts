import type { PrismaClient } from '@prisma/client';
import prismaDefault from '@/lib/prisma';
import { canSeeClient, type Actor } from '@/lib/platform/identity';
import { documentHistory, type AuditEntry } from '@/lib/platform/audit';
import { classifyWorkItem, isDecidable, type WorkKind } from '@/lib/platform/work-queue';
import { decodeSignals, type SignalBreakdown } from '@/lib/domain/enums';
import { workKindLabel, workKindNextStep, workKindWhy } from '@/lib/content/messages';

/**
 * The journey of one document, from arrival to whatever became of it.
 *
 * The counterpart to the charge's evidence file, and the thing that turns the Documents
 * register from a wall of rows into something you can open. The two views answer
 * different questions on purpose: a charge asks *is this covered, and on what evidence*;
 * a document asks *what arrived, and where did it end up* — including documents that
 * ended up nowhere, which the charge view structurally cannot show.
 */

export interface DocumentExtraction {
  documentType: string | null;
  merchantName: string | null;
  vatNumber: string | null;
  totalAmount: number | null;
  currency: string | null;
  documentDate: Date | null;
  cardLast4: string | null;
  invoiceNumber: string | null;
  /** The OCR's own confidence, which gates auto-matching without diluting the score. */
  extractionConfidence: number | null;
}

export interface ConsideredCharge {
  matchId: number;
  transactionId: number;
  merchantName: string;
  amount: number;
  currency: string;
  transactionAt: Date;
  cardLast4: string;
  confidence: number;
  signals: SignalBreakdown;
  status: string;
  decidedBy: string | null;
}

export interface DocumentDetail {
  id: number;
  source: string;
  externalId: string;
  senderIdentifier: string;
  /** The human behind the address or phone, when the sender is registered. */
  senderLabel: string | null;
  status: string;
  failureReason: string | null;
  receivedAt: Date;
  filename: string | null;
  rawText: string | null;
  extraction: DocumentExtraction;

  /** The charge it is attached to, if any. */
  attachedTo: { transactionId: number; merchantName: string; amount: number; currency: string } | null;
  /** Every charge the matcher scored it against, best first. */
  considered: ConsideredCharge[];
  history: AuditEntry[];

  /**
   * What kind of work this represents, or null once it is settled. Reused from the queue's
   * taxonomy rather than re-derived, so a document's page and its row in the queue can
   * never describe it differently.
   */
  workKind: WorkKind | null;
  workLabel: string | null;
  workWhy: string | null;
  workNextStep: string | null;
  decidable: boolean;
}

export async function getDocumentDetail(
  actor: Actor,
  documentId: number,
  prisma: PrismaClient = prismaDefault,
): Promise<DocumentDetail | null> {
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    include: {
      confirmedForTransaction: {
        select: { id: true, merchantName: true, amount: true, currency: true },
      },
      matches: {
        orderBy: [{ confidence: 'desc' }, { id: 'asc' }],
        include: {
          transaction: {
            select: {
              id: true,
              merchantName: true,
              amount: true,
              currency: true,
              transactionAt: true,
              cardLast4: true,
            },
          },
        },
      },
    },
  });

  if (!document) return null;
  if (!canSeeClient(actor, document.clientId)) return null;

  const identity = await prisma.senderIdentity.findUnique({
    where: { identifier: document.senderIdentifier },
    select: { label: true },
  });

  const workKind = classifyWorkItem(document);

  return {
    id: document.id,
    source: document.source,
    externalId: document.externalId,
    senderIdentifier: document.senderIdentifier,
    senderLabel: identity?.label ?? null,
    status: document.status,
    failureReason: document.failureReason,
    receivedAt: document.receivedAt,
    filename: document.filename,
    rawText: document.rawText,
    extraction: {
      documentType: document.documentType,
      merchantName: document.merchantName,
      vatNumber: document.vatNumber,
      totalAmount: document.totalAmount,
      currency: document.currency,
      documentDate: document.documentDate,
      cardLast4: document.cardLast4,
      invoiceNumber: document.invoiceNumber,
      extractionConfidence: document.extractionConfidence,
    },
    attachedTo: document.confirmedForTransaction
      ? {
          transactionId: document.confirmedForTransaction.id,
          merchantName: document.confirmedForTransaction.merchantName,
          amount: document.confirmedForTransaction.amount,
          currency: document.confirmedForTransaction.currency,
        }
      : null,
    considered: document.matches.map((match) => ({
      matchId: match.id,
      transactionId: match.transactionId,
      merchantName: match.transaction.merchantName,
      amount: match.transaction.amount,
      currency: match.transaction.currency,
      transactionAt: match.transaction.transactionAt,
      cardLast4: match.transaction.cardLast4,
      confidence: match.confidence,
      signals: decodeSignals(match.signals),
      status: match.status,
      decidedBy: match.decidedBy,
    })),
    history: await documentHistory(document.id, prisma),
    workKind,
    workLabel: workKind ? workKindLabel(workKind) : null,
    workWhy: workKind ? workKindWhy(workKind) : null,
    workNextStep: workKind ? workKindNextStep(workKind) : null,
    decidable: workKind !== null && isDecidable(workKind),
  };
}
