import type { Prisma, PrismaClient } from '@prisma/client';
import prismaDefault from '@/lib/prisma';

/**
 * The audit trail.
 *
 * One function writes it, and nothing reads a row back to change it. That is the whole
 * design: an audit trail with an update path is a log of what somebody most recently
 * wanted to be true, which is worth nothing to the auditor it exists for.
 *
 * Events are recorded inside the same database transaction as the decision they describe,
 * so the trail cannot disagree with the data. The alternative — writing the event after
 * the commit — produces a system that occasionally attaches a receipt with no record of
 * who did it, and the gap only ever shows up under the one circumstance where it matters.
 */

export type ReviewAction =
  /** The engine attached this itself. */
  | 'AUTO_MATCHED'
  /** A person attached it. The maker's act. */
  | 'CONFIRMED'
  /** A person rejected a candidate. */
  | 'REJECTED'
  /** A checker signed off somebody else's attachment. */
  | 'VERIFIED'
  /** A checker disagreed and sent it back. */
  | 'OVERTURNED';

export type ActorRole = 'SYSTEM' | 'MAKER' | 'CHECKER';

export interface ReviewEventInput {
  documentId: number;
  transactionId?: number | null;
  matchId?: number | null;
  action: ReviewAction;
  actorId: string;
  actorRole: ActorRole;
  confidence?: number | null;
  note?: string | null;
}

/** The subset of the Prisma client this needs, so it composes inside a `$transaction`. */
type EventWriter = Pick<PrismaClient['reviewEvent'], 'create'>;

/**
 * Records one event.
 *
 * Takes the client as an argument rather than importing the singleton so the caller can
 * pass its open transaction — which is the point, and why this is not simply inlined at
 * the call sites.
 */
export async function recordEvent(
  client: EventWriter,
  input: ReviewEventInput,
): Promise<void> {
  await client.create({
    data: {
      documentId: input.documentId,
      transactionId: input.transactionId ?? null,
      matchId: input.matchId ?? null,
      action: input.action,
      actorId: input.actorId,
      actorRole: input.actorRole,
      confidence: input.confidence ?? null,
      note: input.note ?? null,
    },
  });
}

export interface AuditEntry {
  id: number;
  action: string;
  actorId: string;
  actorRole: string;
  transactionId: number | null;
  confidence: number | null;
  note: string | null;
  createdAt: Date;
}

/**
 * The history of one document, oldest first.
 *
 * Chronological rather than newest-first: this is read as a narrative — arrived, matched,
 * rejected, re-attached, signed off — and a reversed narrative has to be reassembled in
 * the reader's head before it means anything.
 */
export async function documentHistory(
  documentId: number,
  prisma: PrismaClient = prismaDefault,
): Promise<AuditEntry[]> {
  return prisma.reviewEvent.findMany({
    where: { documentId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      action: true,
      actorId: true,
      actorRole: true,
      transactionId: true,
      confidence: true,
      note: true,
      createdAt: true,
    },
  });
}

/** Human sentences for the trail, from the content layer. */
export { auditText as actionCopy } from '@/lib/content/messages';

export type { Prisma };
