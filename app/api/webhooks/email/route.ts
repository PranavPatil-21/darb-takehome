import { NextResponse } from 'next/server';
import { emailWebhookSchema } from '@/lib/webhooks/schemas';
import { allowUnsignedWebhooks, verifySignature } from '@/lib/webhooks/signature';
import { accepted, acceptedDespiteFailure, badRequest, unauthorized } from '@/lib/webhooks/respond';
import { ingestDocument, type IngestionResult } from '@/lib/services/document-ingestion';
import { log } from '@/lib/logger';

/** Prisma and node:crypto need the Node runtime, not Edge. */
export const runtime = 'nodejs';

/**
 * Inbound email webhook.
 *
 * One email may carry several attachments; each becomes its own Document with its own
 * idempotency key, so a partial failure on attachment two never costs us attachment one.
 */
export async function POST(request: Request) {
  // Read the body as raw text: HMAC is computed over the exact bytes the provider sent,
  // and re-serialising parsed JSON would never reproduce them.
  const rawBody = await request.text();

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

  try {
    const results: Array<IngestionResult & { filename: string }> = [];

    for (const [index, attachment] of payload.attachments.entries()) {
      let bytes: Buffer;
      try {
        bytes = Buffer.from(attachment.contentBase64, 'base64');
      } catch {
        log.warn('Email webhook: undecodable attachment skipped', {
          messageId: payload.messageId,
          filename: attachment.filename,
        });
        continue;
      }

      if (bytes.byteLength === 0) {
        log.warn('Email webhook: empty attachment skipped', {
          messageId: payload.messageId,
          filename: attachment.filename,
        });
        continue;
      }

      // One idempotency key per attachment, derived from the provider's message id, so a
      // redelivery of the same email collapses attachment-for-attachment.
      const externalId =
        payload.attachments.length === 1
          ? payload.messageId
          : `${payload.messageId}#${index}`;

      const result = await ingestDocument({
        source: 'EMAIL',
        externalId,
        senderIdentifier: payload.from,
        bytes,
        mimeType: attachment.contentType,
        filename: attachment.filename,
        receivedAt: new Date(payload.receivedAt),
      });

      results.push({ ...result, filename: attachment.filename });
    }

    if (results.length === 0) {
      return badRequest('No decodable attachments on this message');
    }

    return accepted({
      messageId: payload.messageId,
      documents: results.map((result) => ({
        documentId: result.documentId,
        filename: result.filename,
        disposition: result.disposition,
        status: result.status,
        outcome: result.match?.outcome ?? null,
        reason: result.match?.reason ?? result.detail ?? null,
        topConfidence: result.match?.candidates[0]?.confidence ?? null,
      })),
    });
  } catch (error) {
    return acceptedDespiteFailure('Email webhook', error);
  }
}

export function GET() {
  return NextResponse.json({ status: 'ok', endpoint: 'email webhook' });
}
