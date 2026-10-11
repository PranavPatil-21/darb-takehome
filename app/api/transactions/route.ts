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

export async function POST(request: Request) {
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

  // Sweep only the affected clients — a global sweep would rescan every unmatched
  // document in the system on every batch.
  const outcomes = (
    await Promise.all(clientIds.map((clientId) => rematchUnmatchedDocuments({ clientId })))
  ).flat();

  const rescued = outcomes.filter((outcome) => outcome.changed);

  return NextResponse.json(
    {
      created: created.map((t) => t.id),
      rematch: {
        scanned: outcomes.length,
        changed: rescued.length,
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
