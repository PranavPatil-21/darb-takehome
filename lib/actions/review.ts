'use server';

import { t } from '@/lib/content/messages';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';
import { log } from '@/lib/logger';
import { actionClient } from '@/lib/actions/safe-action-client';
import { CONFIRMED_MATCH_STATUSES, decodeMatchStatus } from '@/lib/domain/enums';
import { can, resolveActor } from '@/lib/platform/identity';
import { recordEvent } from '@/lib/platform/audit';
import { decideVerification } from '@/lib/platform/verification';
import {
  recomputeDocumentationStatus,
  recomputeDocumentationStatuses,
} from '@/lib/services/charge-status';
import { recomputeDocumentStatus } from '@/lib/services/document-status';
import {
  TransactionAlreadyDocumentedError,
  claimConfirmedDocumentSlot,
  releaseConfirmedDocumentSlot,
} from '@/lib/services/slot-claim';

/** Another request decided this match between our read and our write. */
class ConcurrentDecisionError extends Error {
  constructor(readonly matchId: number) {
    super(`Match ${matchId} was decided concurrently`);
    this.name = 'ConcurrentDecisionError';
  }
}

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

/**
 * Who decided.
 *
 * Resolved through the platform identity seam rather than read from a constant or a
 * session here, so that mounting this capability inside a host application is a change to
 * `lib/platform/identity.ts` and nowhere else. With no host mounted it resolves to the
 * development identity, which is the same string this previously hardcoded — so the audit
 * trail is unchanged until a real host supplies a real user.
 */

export interface ReviewActionResult {
  ok: boolean;
  /** What actually happened, so the UI can distinguish a no-op from a change. */
  effect: 'CONFIRMED' | 'REJECTED' | 'ALREADY_DECIDED' | 'BLOCKED' | 'REFUSED';
  documentId: number;
  documentStatus: string;
  message: string;
}

/** The shape returned when the actor may not decide at all. */
async function refusal(matchId: number): Promise<ReviewActionResult> {
  const match = await prisma.documentMatch.findUnique({
    where: { id: matchId },
    select: { documentId: true, document: { select: { status: true } } },
  });
  return {
    ok: false,
    effect: 'REFUSED',
    documentId: match?.documentId ?? 0,
    documentStatus: match?.document.status ?? 'UNKNOWN',
    message: t('result.denied.decide'),
  };
}

export const confirmMatch = actionClient
  .schema(matchIdSchema)
  .action(async ({ parsedInput }): Promise<ReviewActionResult> => {
    const { matchId } = parsedInput;
    const actor = await resolveActor();

    // Drawn once, here, outside the transaction. Inside it, a retry — which Prisma may
    // perform, and which the P2002 path performs explicitly — re-rolled the number, so
    // whether an attachment was selected for independent sign-off depended on which
    // attempt happened to win. A decision that changes on replay is not reproducible,
    // and this one has to be defensible to an auditor months later.
    const draw = Math.random();

    // Authorisation is checked on the write path, not only in the interface: a button
    // that is not rendered is not a control. It answers with a refusal rather than a
    // thrown error, because `handleServerError` would otherwise flatten it into "please
    // retry" — which misdescribes a working control and asks for something that cannot
    // succeed.
    if (!can(actor, 'decide')) {
      return refusal(matchId);
    }

    const result = await prisma
      .$transaction(async (tx) => {
        const match = await tx.documentMatch.findUnique({
          where: { id: matchId },
          select: { id: true, documentId: true, transactionId: true, status: true },
        });

        if (!match) throw new Error(`Match ${matchId} no longer exists`);

        // Idempotency: a redelivered click finds the work already done.
        //
        // Only an existing *confirmation* short-circuits. Confirming a previously
        // rejected pairing is a real operation — it is how a reviewer recovers from a
        // misclick, which was otherwise unrecoverable without SQL: `confirmMatch`
        // refused, and the re-match sweep deliberately never re-proposes a pairing a
        // human has rejected.
        if (CONFIRMED_MATCH_STATUSES.includes(decodeMatchStatus(match.status))) {
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
          tx,
        );
        if (!claimed) throw new TransactionAlreadyDocumentedError(match.transactionId);

        const charge = await tx.transaction.findUnique({
          where: { id: match.transactionId },
          select: { amount: true },
        });

        // Decided once, here, rather than evaluated when the assurance queue is read: a
        // sampling rule re-rolled on every page load would let a reviewer refresh until
        // the work disappeared, and a materiality threshold changed later would silently
        // rewrite which past attachments were ever supposed to be checked.
        const verification = decideVerification({
          amount: charge?.amount ?? 0,
          automatic: false,
          draw,
        });

        // Compare-and-set on the match's own status, not a plain update.
        //
        // The slot claim above deliberately succeeds when the slot is already held by
        // this same document, so it does not stop two concurrent confirms of the *same*
        // match from both reaching the writes below — one correct row, but two audit
        // events for one decision. SQLite's single-writer lock hid that; Postgres, which
        // the schema names as the migration path, would not. Predicating the update on
        // the status we read makes the loser a no-op.
        const { count: claimedMatch } = await tx.documentMatch.updateMany({
          where: { id: matchId, status: match.status },
          data: {
            status: 'CONFIRMED',
            decidedBy: actor.id,
            decidedAt: new Date(),
            verificationRequired: verification.required,
            verificationTrigger: verification.required ? verification.trigger : null,
            verificationReason: verification.required ? verification.reason : null,
          },
        });

        if (claimedMatch === 0) throw new ConcurrentDecisionError(matchId);

        // Confirming one candidate rules out its siblings on the same document: a
        // receipt documents one transaction.
        //
        // Read before the update so each ruled-out pairing can be named in the trail.
        // Flipping them with a bare `updateMany` left `DocumentMatch.decidedBy` holding
        // the only record of who ruled out which charge — a column that is overwritten by
        // the next decision, so the answer to "who eliminated this transaction, and when"
        // survived exactly until somebody changed their mind.
        const siblings = await tx.documentMatch.findMany({
          where: { documentId: match.documentId, id: { not: matchId }, status: 'CANDIDATE' },
          select: { id: true, transactionId: true, confidence: true },
        });

        if (siblings.length > 0) {
          await tx.documentMatch.updateMany({
            where: { id: { in: siblings.map((sibling) => sibling.id) } },
            data: { status: 'REJECTED', decidedBy: actor.id, decidedAt: new Date() },
          });

          // Every charge a rejected sibling pointed at just lost a live candidate.
          await recomputeDocumentationStatuses(
            tx,
            siblings.map((sibling) => sibling.transactionId),
          );

          for (const sibling of siblings) {
            await recordEvent(tx.reviewEvent, {
              documentId: match.documentId,
              transactionId: sibling.transactionId,
              matchId: sibling.id,
              action: 'REJECTED',
              actorId: actor.id,
              actorRole: 'MAKER',
              confidence: sibling.confidence,
              note: 'Ruled out by confirming another candidate on the same document',
            });
          }
        }

        await recomputeDocumentStatus(tx, match.documentId);

        // Written inside the same transaction as the decision, so the trail cannot
        // disagree with the data. Recording it after the commit produces a system that
        // occasionally attaches a receipt with no record of who did it — and the gap only
        // ever surfaces under the one circumstance where it matters.
        await recordEvent(tx.reviewEvent, {
          documentId: match.documentId,
          transactionId: match.transactionId,
          matchId: match.id,
          action: 'CONFIRMED',
          actorId: actor.id,
          actorRole: 'MAKER',
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
        if (error instanceof ConcurrentDecisionError) {
          // The other request did the work. Report what it did rather than inventing a
          // failure: from the reviewer's point of view the click succeeded.
          const settled = await prisma.documentMatch.findUnique({
            where: { id: matchId },
            select: { documentId: true, status: true, document: { select: { status: true } } },
          });
          return {
            ok: true,
            effect: 'ALREADY_DECIDED',
            documentId: settled?.documentId ?? 0,
            documentStatus: settled?.document.status ?? 'UNKNOWN',
            message: t('result.alreadyDecided'),
          };
        }

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
    const actor = await resolveActor();

    if (!can(actor, 'decide')) {
      return refusal(matchId);
    }

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
          message: t('result.alreadyRejected'),
        };
      }

      // Detaching a confirmed match must release the transaction's slot, or the correct
      // document could never be attached afterwards.
      if (CONFIRMED_MATCH_STATUSES.includes(decodeMatchStatus(match.status))) {
        await releaseConfirmedDocumentSlot(tx.transaction, match.transactionId, match.documentId, tx);
      }

      // Compare-and-set on the status that was read, exactly as `confirmMatch` does above.
      // A plain update here leaves the window that one closes: a confirm committing
      // between this read and this write would be overwritten, and the release guard above
      // — which only fires when it *reads* a confirmed match — would already have been
      // skipped, stranding the charge's slot pointing at a document with no confirmed
      // match. SQLite's single-writer lock hides it; Postgres, which the schema names as
      // the migration path, does not.
      const { count: flipped } = await tx.documentMatch.updateMany({
        where: { id: matchId, status: match.status },
        data: { status: 'REJECTED', decidedBy: actor.id, decidedAt: new Date() },
      });

      if (flipped === 0) throw new ConcurrentDecisionError(matchId);

      await recomputeDocumentationStatus(tx, match.transactionId);

      await recordEvent(tx.reviewEvent, {
        documentId: match.documentId,
        transactionId: match.transactionId,
        matchId: match.id,
        action: 'REJECTED',
        actorId: actor.id,
        actorRole: 'MAKER',
      });

      // Derived, not counted here. A document can still hold a *confirmed* match on
      // another charge, and a count of surviving CANDIDATE rows cannot see that.
      const documentStatus = (await recomputeDocumentStatus(tx, match.documentId)) ?? 'UNMATCHED';

      // Only for the sentence shown to the reviewer — the status above is derived, not
      // inferred from this number.
      const remaining = await tx.documentMatch.count({
        where: { documentId: match.documentId, status: 'CANDIDATE' },
      });

      return {
        ok: true,
        effect: 'REJECTED' as const,
        documentId: match.documentId,
        documentStatus,
        message:
          remaining > 0
            ? `Rejected. ${remaining} candidate${remaining === 1 ? '' : 's'} still to review.`
            : t('result.noneLeft'),
      };
    });

    revalidatePath('/review');
    return result;
  });
