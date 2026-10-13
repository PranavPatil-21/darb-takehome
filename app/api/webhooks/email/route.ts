import { NextResponse } from 'next/server';
import { emailWebhookSchema } from '@/lib/webhooks/schemas';
import { allowUnsignedWebhooks, verifySignature } from '@/lib/webhooks/signature';
import { accepted, badRequest, unauthorized } from '@/lib/webhooks/respond';
import { ingestDocument } from '@/lib/services/document-ingestion';
import { log } from '@/lib/logger';

/** One row per attachment: what we did with it, and why. */
interface AttachmentOutcome {
  filename: string;
  documentId?: number;
  disposition: 'INGESTED' | 'DUPLICATE' | 'FAILED' | 'SKIPPED';
  status?: string;
  outcome?: string | null;
  reason?: string | null;
  topConfidence?: number | null;
}

/** Prisma and node:crypto need the Node runtime, not Edge. */
export const runtime = 'nodejs';

/**
 * Inbound email webhook.
 *
 * One email may carry several attachments. Each becomes its own Document with its own
 * idempotency key, and each is processed inside its own try: a failure on attachment two
 * costs attachment two and nothing else, and is reported rather than swallowed.
 */
export async function POST(request: Request) {
  // Read the body as raw text: HMAC is computed over the exact bytes the provider sent,
  // and re-serialising parsed JSON would never reproduce them.
  //
  // Guarded because this sat outside every try: a truncated or aborted request body
  // throws here, and an unhandled throw in a route handler is the one thing that
  // produces the 500 the rest of this file exists to avoid.
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch (error) {
    return badRequest(
      `Could not read the request body: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }

  const verdict = verifySignature({
    rawBody,
    signatureHeader: request.headers.get('x-darb-signature'),
    secret: process.env.EMAIL_WEBHOOK_SECRET,
    allowUnsigned: allowUnsignedWebhooks(),
  });
  if (!verdict.valid) return unauthorized(verdict.reason);

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return badRequest('Request body is not valid JSON');
  }

  const parsed = emailWebhookSchema.safeParse(json);
  if (!parsed.success) {
    return badRequest('Email webhook payload failed validation', parsed.error);
  }

  const payload = parsed.data;

  // Each attachment is isolated. The loop used to sit inside one try, so a single
  // failure aborted every attachment after it *and* discarded the results already
  // collected — then answered 200, so the provider never redelivered. One bad
  // attachment must cost exactly itself.
  const results: Array<AttachmentOutcome> = [];

  for (const [index, attachment] of payload.attachments.entries()) {
    const bytes = Buffer.from(attachment.contentBase64, 'base64');

    if (bytes.byteLength === 0) {
      // Node's Buffer.from never throws on malformed base64 — it skips invalid
      // characters — so an empty buffer is the only signal that nothing decoded.
      log.warn('Email webhook: undecodable attachment skipped', {
        messageId: payload.messageId,
        filename: attachment.filename,
      });
      results.push({
        filename: attachment.filename,
        disposition: 'SKIPPED',
        reason: 'Attachment did not decode to any bytes',
      });
      continue;
    }

    // One idempotency key per attachment, derived from the provider's message id, so a
    // redelivery of the same email collapses attachment-for-attachment.
    const externalId =
      payload.attachments.length === 1
        ? payload.messageId
        : `${payload.messageId}#${index}`;

    try {
      const result = await ingestDocument({
        source: 'EMAIL',
        externalId,
        senderIdentifier: payload.from,
        bytes,
        mimeType: attachment.contentType,
        filename: attachment.filename,
        receivedAt: new Date(payload.receivedAt),
      });

      results.push({
        filename: attachment.filename,
        documentId: result.documentId,
        disposition: result.disposition,
        status: result.status,
        outcome: result.match?.outcome ?? null,
        reason: result.match?.reason ?? result.detail ?? null,
        topConfidence: result.match?.candidates[0]?.confidence ?? null,
      });
    } catch (error) {
      // Infrastructure, not content: the document may not even exist. Report it against
      // this attachment and carry on with the rest.
      const detail = error instanceof Error ? error.message : String(error);
      log.error('Email webhook: attachment failed, continuing with the rest', {
        messageId: payload.messageId,
        filename: attachment.filename,
        detail,
      });
      results.push({ filename: attachment.filename, disposition: 'FAILED', reason: detail });
    }
  }

  // A payload that passed validation is accepted even when nothing in it was usable.
  // Returning 400 here told a conforming provider its request was malformed, which was
  // untrue and which some providers escalate differently from a 2xx.
  return accepted({ messageId: payload.messageId, documents: results });
}

export function GET() {
  return NextResponse.json({ status: 'ok', endpoint: 'email webhook' });
}
