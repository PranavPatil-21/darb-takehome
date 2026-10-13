import { NextResponse } from 'next/server';
import type { ZodError } from 'zod';

/**
 * Webhook response helpers.
 *
 * The contract both providers expect, and the brief states explicitly: a malformed
 * payload is a 400 with a body you can debug from, and *everything else* is a 2xx. A 500
 * tells the provider to redeliver a message we have already stored, which turns one bad
 * document into an infinite retry loop.
 */

export function badRequest(message: string, error?: ZodError) {
  return NextResponse.json(
    {
      accepted: false,
      error: message,
      // Field-level detail — the difference between a useful 400 and a shrug.
      issues: error?.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    },
    { status: 400 },
  );
}

export function unauthorized(reason: string) {
  return NextResponse.json({ accepted: false, error: reason }, { status: 401 });
}

export function accepted(body: Record<string, unknown>) {
  return NextResponse.json({ accepted: true, ...body }, { status: 200 });
}

/**
 * Accepted what we could, but at least one item must be sent again.
 *
 * The distinction this carries is the whole reason it exists. A `200` tells the provider
 * the message was delivered, and it will never redeliver — so an item we could not read
 * is lost, permanently and silently. When there are no bytes there is also no content
 * hash, and therefore no `Document` row to park in a failed state: the receipt would
 * survive only as a log line.
 *
 * `503` asks for the batch again. Redelivering the whole batch is safe precisely because
 * ingestion is idempotent on both the provider's message id and the file's content hash,
 * so the items that did succeed resolve to `DUPLICATE` rather than doubling.
 */
export function retryLater(body: Record<string, unknown>) {
  return NextResponse.json({ accepted: true, ...body }, { status: 503 });
}
