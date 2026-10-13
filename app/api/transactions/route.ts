import { NextResponse } from 'next/server';
import { z } from 'zod';
import prisma from '@/lib/prisma';
import { log } from '@/lib/logger';
import { badRequest } from '@/lib/webhooks/respond';
import { rematchUnmatchedDocuments } from '@/lib/services/rematch';

export const runtime = 'nodejs';

/**
 * Transaction ingestion — the trigger for re-matching.
 *
 * A document can arrive before the transaction that pays for it: a driver photographs a
 * receipt at the pump, and the acquirer posts the charge hours or days later. That
 * document is UNMATCHED through no fault of its own, and nothing about it will ever
 * change — so the trigger has to come from this side.
 *
 * Without this endpoint the re-match service would be dead code: a capability with no
 * caller. Every new transaction here sweeps the client's unmatched documents and reports
 * which ones found a home.
 */

const transactionSchema = z.object({
  clientId: z.number().int().positive(),
  cardLast4: z.string().regex(/^\d{4}$/, 'cardLast4 must be exactly four digits'),
  driverPhone: z.string().regex(/^\d{8,15}$/).nullable().optional(),
  merchantName: z.string().min(1),
  /** Minor units (halalas). Integer — money is never a float. */
  amount: z.number().int().positive(),
  currency: z.string().length(3).default('SAR'),
  transactionAt: z.string().datetime({ offset: true }),
});

const payloadSchema = z.object({
  transactions: z.array(transactionSchema).min(1).max(500),
});

/**
 * Scopes an idempotency key to its caller.
 *
 * Without the prefix, two integrations both sending "batch-1" would collide and the
 * second would be told its charges already existed. There is no authentication here yet,
 * so the caller is whatever identifies it today; when auth lands this becomes the
 * authenticated client id and nothing else changes.
 */
function scopedKey(request: Request, key: string): string {
  const caller = request.headers.get('x-darb-caller') ?? 'anonymous';
  return `${caller}:${key}`;
}

/**
 * The stored id list for a replayed batch.
 *
 * Stored as JSON text because the SQLite connector has no array column. A row that is
 * somehow not valid JSON would otherwise make every replay of that key a 500 forever —
 * an unrecoverable state reached through a corrupted cache, which is the wrong trade.
 * Reporting an empty list is honest: the charges exist, this request did not create them.
 */
function parseTransactionIds(raw: string, key: string): number[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((id) => typeof id === 'number')) return parsed;
    log.error('Transactions: idempotency record is not a list of ids', { idempotencyKey: key });
  } catch (error) {
    log.error('Transactions: idempotency record is not valid JSON', { idempotencyKey: key, error });
  }
  return [];
}

/** Marker stored while a batch is being created, before its charge ids are known. */
const CLAIM_IN_FLIGHT = '';

/** Prisma's unique-constraint code. The claim below races deliberately and reads it. */
function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

export async function POST(request: Request) {
  const idempotencyKey = request.headers.get('idempotency-key');
  if (!idempotencyKey || idempotencyKey.trim().length === 0) {
    return badRequest(
      'An Idempotency-Key header is required: this endpoint creates financial records, and the re-match sweep makes a client-side timeout likely enough that a blind retry would double them.',
    );
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return badRequest('Request body is not valid JSON');
  }

  const parsed = payloadSchema.safeParse(json);
  if (!parsed.success) {
    return badRequest('Transaction payload failed validation', parsed.error);
  }

  const { transactions } = parsed.data;

  // Reject up front rather than half-inserting: a batch referencing a client that does
  // not exist is a caller bug, not a partial success.
  const clientIds = [...new Set(transactions.map((t) => t.clientId))];
  const knownClients = await prisma.client.findMany({
    where: { id: { in: clientIds } },
    select: { id: true },
  });
  const known = new Set(knownClients.map((c) => c.id));
  const unknown = clientIds.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    return badRequest(`Unknown clientId(s): ${unknown.join(', ')}`);
  }

  // The key is *claimed* before any charge exists, and the claim is the unique insert
  // itself rather than a read that precedes it.
  //
  // A `findUnique` pre-check leaves the whole creation window unguarded: four concurrent
  // retries of one key all found nothing, and all four wrote their own charges. The
  // losing batches were not even recoverable, because the stored record names only one
  // batch's ids. `lib/services/document-ingestion.ts` already resolves exactly this by
  // catching P2002; money deserves at least the same guarantee as a receipt.
  const key = scopedKey(request, idempotencyKey.trim());

  const claimed = await prisma.transactionBatch
    .create({ data: { idempotencyKey: key, transactionIds: CLAIM_IN_FLIGHT } })
    .then(() => true)
    .catch((error: unknown) => {
      if (isUniqueConstraintViolation(error)) return false;
      throw error;
    });

  if (!claimed) {
    const previous = await prisma.transactionBatch.findUnique({
      where: { idempotencyKey: key },
      select: { transactionIds: true },
    });

    // Claimed but not yet finished: another request is mid-flight with this key. Saying
    // "conflict" is honest — the caller must not assume the charges do not exist.
    if (!previous || previous.transactionIds === CLAIM_IN_FLIGHT) {
      log.warn('Transactions: concurrent request already holds this key', { idempotencyKey: key });
      return NextResponse.json(
        {
          accepted: false,
          error: 'A request with this Idempotency-Key is still being processed. Retry shortly.',
        },
        { status: 409 },
      );
    }

    log.info('Transactions: replay of an already-ingested batch', { idempotencyKey: key });
    return NextResponse.json(
      {
        // Guarded: a corrupt row must not make every replay of this key a permanent 500.
        created: parseTransactionIds(previous.transactionIds, key),
        duplicate: true,
        rematch: { scanned: 0, changed: 0, truncated: false, documents: [] },
      },
      { status: 200 },
    );
  }

  const created = await prisma.$transaction(
    transactions.map((t) =>
      prisma.transaction.create({
        data: {
          clientId: t.clientId,
          cardLast4: t.cardLast4,
          driverPhone: t.driverPhone ?? null,
          merchantName: t.merchantName,
          amount: t.amount,
          currency: t.currency,
          transactionAt: new Date(t.transactionAt),
        },
        select: { id: true },
      }),
    ),
  );

  log.info('Transactions ingested', { count: created.length, clientIds });

  // One sweep covering every affected client. Invoking it per client ran overlapping
  // passes over the same unscoped documents.
  //
  // Run *before* the idempotency key is recorded, and guarded. The key is a promise that
  // this request's work is done; recording it first meant a sweep that threw left a key
  // asserting a rescue that never ran and never could — the retry would answer
  // `duplicate: true` with an empty sweep and the documents would stay UNMATCHED until
  // some unrelated later batch happened to cover the same client.
  let outcomes: Awaited<ReturnType<typeof rematchUnmatchedDocuments>>['outcomes'] = [];
  let truncated = false;
  try {
    ({ outcomes, truncated } = await rematchUnmatchedDocuments({ clientIds }));
  } catch (error) {
    // The charges are committed and are the caller's primary result. A failed sweep is
    // recoverable — the next batch for these clients sweeps them again — so it must not
    // turn a successful ingestion into a 500 the caller will retry.
    log.error('Transactions: re-match sweep failed; charges are committed', { clientIds, error });
  }

  // Completing the claim, not creating it. The row already exists; this fills in which
  // charges it produced so a later replay can answer with them.
  await prisma.transactionBatch
    .update({
      where: { idempotencyKey: key },
      data: { transactionIds: JSON.stringify(created.map((t) => t.id)) },
    })
    .catch((error) => {
      // The charges are written and the key is claimed, so a retry cannot double them —
      // it will see the in-flight marker and get a 409. Worth an error line, not a throw.
      log.error('Transactions: could not record the created ids', { idempotencyKey: key, error });
    });
  const rescued = outcomes.filter((outcome) => outcome.changed);

  return NextResponse.json(
    {
      created: created.map((t) => t.id),
      rematch: {
        scanned: outcomes.length,
        changed: rescued.length,
        // Surfaced rather than hidden: a capped sweep and an empty sweep look identical
        // to a caller otherwise.
        truncated,
        documents: rescued.map((outcome) => ({
          documentId: outcome.documentId,
          from: outcome.previousStatus,
          to: outcome.status,
        })),
      },
    },
    { status: 201 },
  );
}
