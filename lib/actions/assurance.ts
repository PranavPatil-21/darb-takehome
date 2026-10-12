'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import prisma from '@/lib/prisma';
import { log } from '@/lib/logger';
import { actionClient } from '@/lib/actions/safe-action-client';
import { can, resolveActor } from '@/lib/platform/identity';
import { recordEvent } from '@/lib/platform/audit';
import { canVerify } from '@/lib/platform/verification';
import { releaseConfirmedDocumentSlot } from '@/lib/services/slot-claim';
import { CONFIRMED_MATCH_STATUSES, decodeMatchStatus } from '@/lib/domain/enums';
import { modulePath } from '@/lib/platform/module-config';

/**
 * The checker's half of maker-checker.
 *
 * Two outcomes, and they are not symmetrical. Upholding an attachment changes nothing
 * about the data — it records that an independent person read it and agreed, which is the
 * evidence the control exists to produce. Overturning one detaches the receipt, and that
 * is a destructive act on something another person deliberately did, so it goes through
 * the same slot-release path a rejection uses and demands a reason.
 *
 * Both are idempotent and both check the segregation rule on the server. A checker who
 * is also the maker is refused here, not merely hidden from in the interface — the
 * control is the refusal, and an interface-only version of it is a control that a second
 * browser tab defeats.
 */

const upholdSchema = z.object({ matchId: z.number().int().positive() });
const overturnSchema = z.object({
  matchId: z.number().int().positive(),
  // A detachment that nobody has to explain is a detachment nobody can review later.
  reason: z.string().trim().min(3, 'Say why this attachment is wrong').max(500),
});

export interface AssuranceResult {
  ok: boolean;
  effect: 'UPHELD' | 'OVERTURNED' | 'ALREADY_VERIFIED' | 'REFUSED' | 'STALE';
  message: string;
}

async function requireChecker() {
  const actor = await resolveActor();
  if (!can(actor, 'verify')) {
    throw new Error('You do not have permission to sign off attachments');
  }
  return actor;
}

export const upholdAttachment = actionClient
  .schema(upholdSchema)
  .action(async ({ parsedInput }): Promise<AssuranceResult> => {
    const actor = await requireChecker();

    const result = await prisma.$transaction(async (tx) => {
      const match = await tx.documentMatch.findUnique({
        where: { id: parsedInput.matchId },
        select: {
          id: true,
          documentId: true,
          transactionId: true,
          decidedBy: true,
          verifiedAt: true,
          confidence: true,
          status: true,
        },
      });

      if (!match) throw new Error(`Attachment ${parsedInput.matchId} no longer exists`);

      // Idempotent, like the review actions: a second click finds the work done.
      if (match.verifiedAt !== null) {
        return { ok: true, effect: 'ALREADY_VERIFIED' as const, message: 'Already signed off.' };
      }

      const permitted = canVerify({ verifierId: actor.id, makerId: match.decidedBy });
      if (!permitted.allowed) {
        return { ok: false, effect: 'REFUSED' as const, message: permitted.reason };
      }

      await tx.documentMatch.update({
        where: { id: match.id },
        data: {
          verifiedBy: actor.id,
          verifiedAt: new Date(),
          verificationOutcome: 'UPHELD',
        },
      });

      await recordEvent(tx.reviewEvent, {
        documentId: match.documentId,
        transactionId: match.transactionId,
        matchId: match.id,
        action: 'VERIFIED',
        actorId: actor.id,
        actorRole: 'CHECKER',
        confidence: match.confidence,
      });

      return { ok: true, effect: 'UPHELD' as const, message: 'Signed off.' };
    });

    revalidatePath(modulePath('assurance'));
    revalidatePath(modulePath());
    return result;
  });

export const overturnAttachment = actionClient
  .schema(overturnSchema)
  .action(async ({ parsedInput }): Promise<AssuranceResult> => {
    const actor = await requireChecker();

    const result = await prisma.$transaction(async (tx) => {
      const match = await tx.documentMatch.findUnique({
        where: { id: parsedInput.matchId },
        select: {
          id: true,
          documentId: true,
          transactionId: true,
          decidedBy: true,
          verifiedAt: true,
          confidence: true,
          status: true,
        },
      });

      if (!match) throw new Error(`Attachment ${parsedInput.matchId} no longer exists`);

      if (match.verifiedAt !== null) {
        return { ok: true, effect: 'ALREADY_VERIFIED' as const, message: 'Already signed off.' };
      }

      const permitted = canVerify({ verifierId: actor.id, makerId: match.decidedBy });
      if (!permitted.allowed) {
        return { ok: false, effect: 'REFUSED' as const, message: permitted.reason };
      }

      // The attachment may have been detached by a maker since this page was rendered.
      // `verifiedAt` alone does not catch that: it is still null, so without this guard an
      // overturn would run against a match that no longer holds anything — releasing a
      // slot it does not own, possibly flipping the document's status, and writing an
      // audit event asserting that a checker detached an attachment which by then did not
      // exist. Polluting the trail is the real harm; the trail is the product.
      if (!CONFIRMED_MATCH_STATUSES.includes(decodeMatchStatus(match.status))) {
        return {
          ok: false,
          effect: 'STALE' as const,
          message: 'This attachment was already removed by someone else. Refresh to see the queue.',
        };
      }

      // Detaching goes through the same compare-and-set release a rejection uses, so the
      // one-confirmed-document-per-transaction guarantee holds through this path too.
      // Writing `confirmedDocumentId = null` directly here would be a second write path
      // to the column the whole correctness argument rests on.
      await releaseConfirmedDocumentSlot(tx.transaction, match.transactionId, match.documentId);

      await tx.documentMatch.update({
        where: { id: match.id },
        data: {
          status: 'REJECTED',
          verifiedBy: actor.id,
          verifiedAt: new Date(),
          verificationOutcome: 'OVERTURNED',
        },
      });

      const remaining = await tx.documentMatch.count({
        where: { documentId: match.documentId, status: 'CANDIDATE' },
      });

      await tx.document.update({
        where: { id: match.documentId },
        data: {
          status: remaining > 0 ? 'NEEDS_REVIEW' : 'UNMATCHED',
          failureReason: remaining > 0 ? null : 'ALL_CANDIDATES_REJECTED',
        },
      });

      await recordEvent(tx.reviewEvent, {
        documentId: match.documentId,
        transactionId: match.transactionId,
        matchId: match.id,
        action: 'OVERTURNED',
        actorId: actor.id,
        actorRole: 'CHECKER',
        confidence: match.confidence,
        note: parsedInput.reason,
      });

      log.warn('Assurance: attachment overturned', {
        matchId: match.id,
        documentId: match.documentId,
        by: actor.id,
      });

      return {
        ok: true,
        effect: 'OVERTURNED' as const,
        message: 'Detached. The charge is free for the correct receipt.',
      };
    });

    revalidatePath(modulePath('assurance'));
    revalidatePath(modulePath('review'));
    revalidatePath('/review');
    revalidatePath(modulePath());
    return result;
  });
