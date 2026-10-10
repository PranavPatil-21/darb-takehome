'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';
import { log } from '@/lib/logger';
import { actionClient } from '@/lib/actions/safe-action-client';
import { CONFIRMED_MATCH_STATUSES, TERMINAL_MATCH_STATUSES, type MatchStatus } from '@/lib/domain/enums';
import {
  TransactionAlreadyDocumentedError,
  claimConfirmedDocumentSlot,
  releaseConfirmedDocumentSlot,
} from '@/lib/services/slot-claim';

/**
 * Review-queue server actions.
 *
 * Two rules drive the whole design here, both stated in the brief:
 *
 *  1. **Safe against double-submits.** A reviewer double-clicking Confirm, or two
 *     reviewers acting on the same row, must not produce two confirmations. Both actions
 *     are therefore idempotent: acting on an already-decided match is a no-op that
 *     reports what happened, not an error and not a second write.
 *
 *  2. **One confirmed document per transaction, enforced at the data layer.** The guard
 *     is the unique constraint on `Transaction.confirmedDocumentId`, not an `if` in this
 *     file. The `if` can lose a race; the constraint cannot.
 */

const matchIdSchema = z.object({ matchId: z.number().int().positive() });

/** Who decided. In a real deployment this comes from the session, not a constant. */
const REVIEWER = 'reviewer';

export interface ReviewActionResult {
  ok: boolean;
  /** What actually happened, so the UI can distinguish a no-op from a change. */
  effect: 'CONFIRMED' | 'REJECTED' | 'ALREADY_DECIDED' | 'BLOCKED';
  documentId: number;
  documentStatus: string;
  message: string;
}

export const confirmMatch = actionClient
  .schema(matchIdSchema)
  .action(async ({ parsedInput }): Promise<ReviewActionResult> => {
    const { matchId } = parsedInput;

    const result = await prisma
      .$transaction(async (tx) => {
        const match = await tx.documentMatch.findUnique({
          where: { id: matchId },
          select: { id: true, documentId: true, transactionId: true, status: true },
        });

        if (!match) throw new Error(`Match ${matchId} no longer exists`);

        // Idempotency: a redelivered click finds the work already done.
        if (TERMINAL_MATCH_STATUSES.includes(match.status as MatchStatus)) {
          const document = await tx.document.findUniqueOrThrow({
            where: { id: match.documentId },
            select: { status: true },
          });
          return {
            ok: true,
            effect: 'ALREADY_DECIDED' as const,
            documentId: match.documentId,
            documentStatus: document.status,
            message: `This candidate was already ${match.status.toLowerCase().replace('_', ' ')}.`,
          };
        }

        // Atomic compare-and-set on the transaction's single confirmed-document slot.
        // A plain update would silently overwrite an existing confirmation; this refuses.
        const claimed = await claimConfirmedDocumentSlot(
          tx.transaction,
          match.transactionId,
          match.documentId,
        );
        if (!claimed) throw new TransactionAlreadyDocumentedError(match.transactionId);

        await tx.documentMatch.update({
          where: { id: matchId },
          data: { status: 'CONFIRMED', decidedBy: REVIEWER, decidedAt: new Date() },
        });

        // Confirming one candidate rules out its siblings on the same document: a
        // receipt documents one transaction.
        await tx.documentMatch.updateMany({
          where: { documentId: match.documentId, id: { not: matchId }, status: 'CANDIDATE' },
          data: { status: 'REJECTED', decidedBy: REVIEWER, decidedAt: new Date() },
        });

        await tx.document.update({
          where: { id: match.documentId },
          data: { status: 'MATCHED', failureReason: null },
        });

        return {
          ok: true,
          effect: 'CONFIRMED' as const,
          documentId: match.documentId,
          documentStatus: 'MATCHED',
          message: `Attached to transaction #${match.transactionId}.`,
        };
      })
      .catch(async (error): Promise<ReviewActionResult> => {
        const blocked =
          error instanceof TransactionAlreadyDocumentedError ||
          // The @unique index also fires if this document is already confirmed elsewhere.
          (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002');

        if (blocked) {
          // The database refused a second confirmed document for this transaction.
          const match = await prisma.documentMatch.findUnique({
            where: { id: matchId },
            select: { documentId: true, transactionId: true, document: { select: { status: true } } },
          });
          log.warn('confirmMatch blocked: transaction already documented', { matchId });
          return {
            ok: false,
            effect: 'BLOCKED',
            documentId: match?.documentId ?? 0,
            documentStatus: match?.document.status ?? 'NEEDS_REVIEW',
            message: `Transaction #${match?.transactionId} already has a confirmed document. Reject that one first if this is the correct receipt.`,
          };
        }
        throw error;
      });

    revalidatePath('/review');
    return result;
  });

export const rejectMatch = actionClient
  .schema(matchIdSchema)
  .action(async ({ parsedInput }): Promise<ReviewActionResult> => {
    const { matchId } = parsedInput;

    const result = await prisma.$transaction(async (tx) => {
      const match = await tx.documentMatch.findUnique({
        where: { id: matchId },
        select: { id: true, documentId: true, transactionId: true, status: true },
      });

      if (!match) throw new Error(`Match ${matchId} no longer exists`);

      // Only an existing rejection short-circuits. Rejecting a *confirmed* match is a
      // real operation — it is how a reviewer detaches a wrong auto-match, and how the
      // duplicate-receipt flow frees a transaction so the correct document can take it.
      if (match.status === 'REJECTED') {
        const document = await tx.document.findUniqueOrThrow({
          where: { id: match.documentId },
          select: { status: true },
        });
        return {
          ok: true,
          effect: 'ALREADY_DECIDED' as const,
          documentId: match.documentId,
          documentStatus: document.status,
          message: 'This candidate was already rejected.',
        };
      }

      // Detaching a confirmed match must release the transaction's slot, or the correct
      // document could never be attached afterwards.
      if (CONFIRMED_MATCH_STATUSES.includes(match.status as MatchStatus)) {
        await releaseConfirmedDocumentSlot(tx.transaction, match.transactionId, match.documentId);
      }

      await tx.documentMatch.update({
        where: { id: matchId },
        data: { status: 'REJECTED', decidedBy: REVIEWER, decidedAt: new Date() },
      });

      const remaining = await tx.documentMatch.count({
        where: { documentId: match.documentId, status: 'CANDIDATE' },
      });

      // UNMATCHED rather than FAILED: a later transaction can still rescue this document
      // through the re-match sweep.
      const documentStatus = remaining > 0 ? 'NEEDS_REVIEW' : 'UNMATCHED';
      await tx.document.update({
        where: { id: match.documentId },
        data: {
          status: documentStatus,
          failureReason: remaining > 0 ? null : 'ALL_CANDIDATES_REJECTED',
        },
      });

      return {
        ok: true,
        effect: 'REJECTED' as const,
        documentId: match.documentId,
        documentStatus,
        message:
          remaining > 0
            ? `Rejected. ${remaining} candidate${remaining === 1 ? '' : 's'} still to review.`
            : 'Rejected. No candidates left — the document is back in the unmatched pool.',
      };
    });

    revalidatePath('/review');
    return result;
  });
