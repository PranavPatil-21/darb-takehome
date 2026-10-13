import type { Prisma } from '@prisma/client';
import { recomputeDocumentationStatus } from '@/lib/services/charge-status';

/**
 * Claiming a transaction's confirmed-document slot.
 *
 * `Transaction.confirmedDocumentId` is a single nullable column with a unique index,
 * which gives two different guarantees:
 *
 *  - **One confirmed document per transaction** comes from the column being
 *    single-valued. A transaction structurally cannot reference two documents.
 *  - **One transaction per confirmed document** comes from the `@unique` index.
 *
 * What neither gives you is protection against *overwriting*: a plain
 * `update({ data: { confirmedDocumentId } })` would happily replace an existing
 * confirmation and silently discard the first document's evidence. So the claim is
 * written as a conditional `updateMany` — a compare-and-set that only succeeds when the
 * slot is free (or already held by this same document). `count === 0` means somebody
 * else holds it, decided atomically by the database rather than by a read-then-write
 * check that two concurrent reviewers would both pass.
 */

export class TransactionAlreadyDocumentedError extends Error {
  constructor(readonly transactionId: number) {
    super(`Transaction ${transactionId} already has a confirmed document`);
    this.name = 'TransactionAlreadyDocumentedError';
  }
}

type TransactionDelegate = Prisma.TransactionClient['transaction'];

/**
 * The slot and the cached status change together or not at all.
 *
 * Both helpers take the delegate rather than the client, which is what kept them narrow —
 * but the status cache needs the client to re-read the charge's matches. Passing both
 * keeps the compare-and-set exactly as it was while making it impossible to move the slot
 * without the column following.
 */
type SlotClient = Prisma.TransactionClient;

/** Returns true if the slot is now held by `documentId`. Never overwrites another claim. */
export async function claimConfirmedDocumentSlot(
  transactions: TransactionDelegate,
  transactionId: number,
  documentId: number,
  /** Omit only where the caller recomputes the status itself afterwards. */
  client?: SlotClient,
): Promise<boolean> {
  const { count } = await transactions.updateMany({
    where: {
      id: transactionId,
      // Free, or already ours — re-confirming the same document is idempotent.
      OR: [{ confirmedDocumentId: null }, { confirmedDocumentId: documentId }],
    },
    data: { confirmedDocumentId: documentId },
  });

  if (count === 1 && client) await recomputeDocumentationStatus(client, transactionId);

  return count === 1;
}

/** Releases the slot, but only if `documentId` is the current holder. */
export async function releaseConfirmedDocumentSlot(
  transactions: TransactionDelegate,
  transactionId: number,
  documentId: number,
  client?: SlotClient,
): Promise<void> {
  await transactions.updateMany({
    where: { id: transactionId, confirmedDocumentId: documentId },
    data: { confirmedDocumentId: null },
  });

  if (client) await recomputeDocumentationStatus(client, transactionId);
}
