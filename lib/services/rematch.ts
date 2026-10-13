import type { Document, PrismaClient } from '@prisma/client';
import prismaDefault from '@/lib/prisma';
import { log } from '@/lib/logger';
import type { DocumentStatus } from '@/lib/domain/enums';
import {
  decodeDocumentSource,
  decodeDocumentStatus,
  documentTypeSchema,
} from '@/lib/domain/enums';
import { persistMatchResult } from '@/lib/services/document-ingestion';
import { selectCandidateTransactions } from '@/lib/services/candidate-selection';
import { matchDocument, type MatchableDocument } from '@/lib/services/transaction-matcher';

/**
 * Re-matching for documents that arrived before their transaction.
 *
 * A driver photographs a receipt at the pump; the acquirer posts the transaction hours
 * or days later. The document is UNMATCHED through no fault of its own, and nothing
 * about it will ever change — so the trigger has to come from the other side.
 *
 * Re-matching never re-runs OCR. The extraction is already persisted on the Document
 * row, and OCR is the expensive, non-deterministic, paid part of the pipeline; replaying
 * it on every new transaction would be the single most costly mistake available here.
 */

/** Rebuilds the matcher's input from a stored row. */
export function toMatchableDocument(document: Document): MatchableDocument {
  const parsedType = documentTypeSchema.safeParse(document.documentType);

  return {
    source: decodeDocumentSource(document.source),
    clientId: document.clientId,
    driverPhone: document.driverPhone,
    documentType: parsedType.success ? parsedType.data : 'UNKNOWN',
    merchantName: document.merchantName,
    vatNumber: document.vatNumber,
    totalAmount: document.totalAmount,
    currency: document.currency,
    documentDate: document.documentDate ? document.documentDate.toISOString() : null,
    cardLast4: document.cardLast4,
    invoiceNumber: document.invoiceNumber,
    extractionConfidence: document.extractionConfidence ?? 0,
  };
}

export interface RematchOutcome {
  documentId: number;
  previousStatus: DocumentStatus;
  status: DocumentStatus;
  changed: boolean;
}

/** Re-runs matching for one document. Safe to call on any status. */
export async function rematchDocument(
  documentId: number,
  prisma: PrismaClient = prismaDefault,
): Promise<RematchOutcome | null> {
  let document = await prisma.document.findUnique({ where: { id: documentId } });
  if (!document) return null;

  // A document ingested from an unrecognised sender carries no client, so nothing can be
  // matched to it. That is not permanent: once the sender is registered, re-resolving the
  // identity here is what turns a stranded document into a matchable one — which is the
  // whole reason it was parked in UNMATCHED rather than FAILED.
  if (document.clientId === null) {
    const identity = await prisma.senderIdentity.findUnique({
      where: { identifier: document.senderIdentifier },
      select: { clientId: true, driverPhone: true },
    });
    if (!identity) {
      return {
        documentId,
        previousStatus: decodeDocumentStatus(document.status),
        status: decodeDocumentStatus(document.status),
        changed: false,
      };
    }
    document = await prisma.document.update({
      where: { id: documentId },
      data: { clientId: identity.clientId, driverPhone: identity.driverPhone },
    });
    log.info('Re-match: sender registered since ingestion; document now scoped', {
      documentId,
      clientId: identity.clientId,
    });
  }

  // A rejection is a decision about a *pairing*, and it is permanent. Without this the
  // sweep re-scores the transaction a reviewer already turned down and, finding it still
  // the best fit, re-attaches it — overwriting `decidedBy` from the reviewer back to
  // `system` and destroying the record that a human ever said no. The document stays
  // open to genuinely new transactions; only the pairings a person ruled out are closed.
  const rejected = await prisma.documentMatch.findMany({
    where: { documentId, status: 'REJECTED' },
    select: { transactionId: true },
  });
  const rejectedTransactionIds = rejected.map((row) => row.transactionId);

  const previousStatus = decodeDocumentStatus(document.status);
  const matchable = toMatchableDocument(document);
  const candidates = await selectCandidateTransactions(
    prisma,
    matchable,
    document.receivedAt,
    rejectedTransactionIds,
  );
  const result = matchDocument(matchable, candidates);

  // Nothing new to say: leave the document exactly as the reviewer left it, rather than
  // overwriting `ALL_CANDIDATES_REJECTED` with the blander reason a fresh run produces.
  if (result.candidates.length === 0 && rejectedTransactionIds.length > 0) {
    return { documentId, previousStatus, status: previousStatus, changed: false };
  }

  const status = await persistMatchResult(prisma, documentId, result);

  return { documentId, previousStatus, status, changed: status !== previousStatus };
}

/**
 * Sweeps every document still waiting for a transaction.
 *
 * Call this after ingesting new transactions. Scoped to UNMATCHED on purpose: documents
 * in NEEDS_REVIEW belong to a human and must not be reshuffled under them, and MATCHED
 * documents are settled.
 */
/**
 * Upper bound on one sweep.
 *
 * The sweep had no limit, which made the cost of ingesting transactions a function of
 * how much unmatched history had accumulated — a fleet with ten thousand stale documents
 * paid for all of them on every batch. A cap makes the work predictable; reporting the
 * truncation keeps it honest, because a silently capped sweep reads exactly like a sweep
 * that found nothing.
 */
export const REMATCH_SWEEP_LIMIT = 200;

export interface SweepResult {
  outcomes: RematchOutcome[];
  /** True when more documents were waiting than the limit allowed in this pass. */
  truncated: boolean;
}

/**
 * Re-run matching for documents that had no home when they arrived.
 *
 * Takes every affected client in one call rather than being invoked once per client.
 * The previous shape fanned out with `Promise.all`, and because unscoped documents are
 * deliberately included in every pass, an N-client batch ran N concurrent sweeps over
 * the same unscoped rows — wasted work, and a `scanned` count that counted them N times.
 */
export async function rematchUnmatchedDocuments(
  options: { clientIds?: number[] } = {},
  prisma: PrismaClient = prismaDefault,
): Promise<SweepResult> {
  const clientIds = options.clientIds;

  const pending = await prisma.document.findMany({
    where: {
      status: 'UNMATCHED',
      OR: [
        clientIds && clientIds.length > 0 ? { clientId: { in: clientIds } } : { clientId: { not: null } },
        // Unscoped documents are included deliberately: a sender registered since
        // ingestion makes one matchable, and `rematchDocument` re-resolves the identity
        // and backfills the row. Excluding them here is what previously stranded them.
        { clientId: null },
      ],
    },
    select: { id: true },
    orderBy: { id: 'asc' },
    // One more than the limit, so truncation is detectable without a second count query.
    take: REMATCH_SWEEP_LIMIT + 1,
  });

  const truncated = pending.length > REMATCH_SWEEP_LIMIT;
  const batch = truncated ? pending.slice(0, REMATCH_SWEEP_LIMIT) : pending;

  const outcomes: RematchOutcome[] = [];
  for (const { id } of batch) {
    try {
      const outcome = await rematchDocument(id, prisma);
      if (outcome) outcomes.push(outcome);
    } catch (error) {
      // One poisoned document must not stop the sweep.
      log.error('Re-match sweep: document failed, continuing', { documentId: id, error });
    }
  }

  const changed = outcomes.filter((outcome) => outcome.changed);
  log.info('Re-match sweep complete', {
    scanned: outcomes.length,
    changed: changed.length,
    truncated,
  });

  if (truncated) {
    log.warn('Re-match sweep hit its limit; more documents are still waiting', {
      limit: REMATCH_SWEEP_LIMIT,
    });
  }

  return { outcomes, truncated };
}
