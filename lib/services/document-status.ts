import type { Prisma, PrismaClient } from '@prisma/client';
import { decodeDocumentStatus, decodeMatchStatus } from '@/lib/domain/enums';
import { documentFailureReasonOf, documentStatusOf } from '@/lib/domain/document-status';
import type { DocumentStatus } from '@/lib/domain/enums';

/**
 * The one writer of `Document.status` once matching has run.
 *
 * The same argument as `recomputeDocumentationStatus` on the charge side, and the same
 * discipline: re-read rather than trust the caller, derive through one pure function, and
 * call it inside the transaction that changed the inputs. A caller that already believes
 * it knows the new status is a caller that can be wrong — which is how a document ended
 * up reported as `UNMATCHED` while a charge still held it as confirmed evidence.
 *
 * Ingestion keeps its own direct writes for the pre-match lifecycle (`RECEIVED` →
 * `EXTRACTED` → `FAILED`), because those states are properties of extraction rather than
 * of matches and this function deliberately refuses to invent them.
 */

type Client = PrismaClient | Prisma.TransactionClient;

export async function recomputeDocumentStatus(
  prisma: Client,
  documentId: number,
): Promise<DocumentStatus | null> {
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    select: { status: true, matches: { select: { status: true } } },
  });

  // Deleted underneath us. Throwing here would fail a decision that otherwise succeeded.
  if (!document) return null;

  const matches = document.matches.map((m) => ({ status: decodeMatchStatus(m.status) }));
  const status = documentStatusOf({
    currentStatus: decodeDocumentStatus(document.status),
    matches,
  });

  await prisma.document.update({
    where: { id: documentId },
    data: { status, failureReason: documentFailureReasonOf(status, matches) },
  });

  return status;
}
