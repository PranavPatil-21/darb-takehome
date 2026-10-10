import { NextResponse } from 'next/server';
import type { ZodError } from 'zod';
import { log } from '@/lib/logger';

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
 * The last line of defence. If something escapes every guard in the pipeline we still
 * acknowledge the webhook — losing our own processing is strictly better than asking the
 * provider to replay a message forever.
 */
export function acceptedDespiteFailure(context: string, error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  log.error(`${context}: unexpected failure, acknowledging anyway`, { detail });
  return NextResponse.json(
    { accepted: true, processed: false, error: 'Accepted but not processed; see server logs.' },
    { status: 200 },
  );
}
