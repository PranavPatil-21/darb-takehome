'use server';

import { recomputeDocumentStatus } from '@/lib/services/document-status';

import { t } from '@/lib/content/messages';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import prisma from '@/lib/prisma';
import { log } from '@/lib/logger';
import { actionClient } from '@/lib/actions/safe-action-client';
import { can, resolveActor, type Actor } from '@/lib/platform/identity';
import { recordEvent } from '@/lib/platform/audit';
import { canVerify } from '@/lib/platform/verification';
import { releaseConfirmedDocumentSlot } from '@/lib/services/slot-claim';
import { recomputeDocumentationStatus } from '@/lib/services/charge-status';
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
  reason: z.string().trim().min(3, t('result.reasonTooShort')).max(500),
});

export interface AssuranceResult {
  ok: boolean;
  effect: 'UPHELD' | 'OVERTURNED' | 'ALREADY_VERIFIED' | 'REFUSED' | 'STALE';
  message: string;
}

/**
 * The capability gate, checked on the write path rather than only in the interface — a
 * button that is not rendered is not a control.
 *
 * It returns a refusal rather than throwing. A thrown error is flattened by
 * `handleServerError` into "something went wrong, please retry", which is wrong twice
 * over for a refusal: it describes a working control as a fault, and it tells the
 * operator to do something that cannot ever succeed. Per-item segregation below already
 * answers with `REFUSED`; the capability check answers the same way, so every refusal in
 * this module reads as a decision rather than a failure.
 */
async function resolveChecker(): Promise<
  { ok: true; actor: Actor } | { ok: false; result: AssuranceResult }
> {
  const actor = await resolveActor();
  if (!can(actor, 'verify')) {
    return {
      ok: false,
      result: { ok: false, effect: 'REFUSED', message: t('result.denied.verify') },
    };
  }
  return { ok: true, actor };
}

export const upholdAttachment = actionClient
  .schema(upholdSchema)
  .action(async ({ parsedInput }): Promise<AssuranceResult> => {
    const checker = await resolveChecker();
    if (!checker.ok) return checker.result;
    const actor = checker.actor;

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
        return { ok: true, effect: 'ALREADY_VERIFIED' as const, message: t('result.alreadySignedOff') };
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

      return { ok: true, effect: 'UPHELD' as const, message: t('result.signedOff') };
    });

    revalidatePath(modulePath('assurance'));
    revalidatePath(modulePath());
    return result;
  });

/** The attachment was decided by somebody else between our read and our write. */
class StaleAttachmentError extends Error {
  constructor(readonly matchId: number) {
    super(`Attachment ${matchId} was decided concurrently`);
    this.name = 'StaleAttachmentError';
  }
}

export const overturnAttachment = actionClient
  .schema(overturnSchema)
  .action(async ({ parsedInput }): Promise<AssuranceResult> => {
    const checker = await resolveChecker();
    if (!checker.ok) return checker.result;
    const actor = checker.actor;

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
        return { ok: true, effect: 'ALREADY_VERIFIED' as const, message: t('result.alreadySignedOff') };
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
          message: t('result.alreadyRemoved'),
        };
      }

      // Detaching goes through the same compare-and-set release a rejection uses, so the
      // one-confirmed-document-per-transaction guarantee holds through this path too.
      // Writing `confirmedDocumentId = null` directly here would be a second write path
      // to the column the whole correctness argument rests on.
      // The slot is released without recomputing the cached charge status here: the match
      // below has not flipped yet, so a recompute at this point would derive the status of
      // a world that is about to stop existing — and that is precisely what it used to do,
      // leaving the charge reading MISSING when its match says REJECTED.
      // Compare-and-set FIRST, then release. The order is the correctness argument.
      //
      // Releasing before the flip meant a lost race committed a half-write: `return`
      // inside `$transaction` *resolves* the callback, so Prisma commits — leaving the
      // slot freed while `DocumentMatch.status` still said CONFIRMED. A second document
      // could then claim the free slot, and the charge ended up holding two confirmed
      // matches, which is the one thing this module exists to prevent. The unique index
      // on `confirmedDocumentId` cannot catch it: that constrains the mirror, not the fact.
      const { count: flipped } = await tx.documentMatch.updateMany({
        where: { id: match.id, status: match.status },
        data: {
          status: 'REJECTED',
          verifiedBy: actor.id,
          verifiedAt: new Date(),
          verificationOutcome: 'OVERTURNED',
        },
      });

      // Thrown, not returned, so the transaction rolls back and nothing above survives —
      // the same choice `rejectMatch` makes for the same race.
      if (flipped === 0) throw new StaleAttachmentError(match.id);

      await releaseConfirmedDocumentSlot(tx.transaction, match.transactionId, match.documentId);

      // Both caches recomputed only now, after every input to them has settled.
      await recomputeDocumentationStatus(tx, match.transactionId);
      await recomputeDocumentStatus(tx, match.documentId);

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
        message: t('result.detached'),
      };
    })
      .catch((error): AssuranceResult => {
        // A lost race is not a fault. The other checker did the work; reporting it as a
        // server error would tell the operator to retry something that already happened.
        if (error instanceof StaleAttachmentError) {
          return { ok: false, effect: 'STALE' as const, message: t('result.alreadyRemoved') };
        }
        throw error;
      });

    revalidatePath(modulePath('assurance'));
    revalidatePath(modulePath('review'));
    revalidatePath('/review');
    revalidatePath(modulePath());
    return result;
  });
