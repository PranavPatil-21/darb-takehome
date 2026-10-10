import { NextResponse } from 'next/server';
import { extractWhatsAppMessages, whatsappWebhookSchema } from '@/lib/webhooks/schemas';
import { allowUnsignedWebhooks, verifySignature } from '@/lib/webhooks/signature';
import { accepted, acceptedDespiteFailure, badRequest, unauthorized } from '@/lib/webhooks/respond';
import { getMediaStore } from '@/lib/media/media-store';
import { ingestDocument } from '@/lib/services/document-ingestion';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';

/** Meta sends media ids, not bytes; these are the message types that carry a document. */
const DOCUMENT_BEARING_TYPES = new Set(['image', 'document']);

/**
 * Inbound WhatsApp webhook (simplified Meta Cloud API shape).
 *
 * Media arrives as an id that must be resolved to bytes through the `MediaStore` seam.
 * A media id we cannot resolve is logged and skipped rather than failed: Meta retries
 * aggressively, and a 500 here would replay the whole batch including messages we have
 * already ingested successfully.
 */
export async function POST(request: Request) {
  const rawBody = await request.text();

  const verdict = verifySignature({
    rawBody,
    signatureHeader: request.headers.get('x-hub-signature-256'),
    secret: process.env.WHATSAPP_WEBHOOK_SECRET,
    allowUnsigned: allowUnsignedWebhooks(),
  });
  if (!verdict.valid) return unauthorized(verdict.reason);

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return badRequest('Request body is not valid JSON');
  }

  const parsed = whatsappWebhookSchema.safeParse(json);
  if (!parsed.success) {
    return badRequest('WhatsApp webhook payload failed validation', parsed.error);
  }

  try {
    const messages = extractWhatsAppMessages(parsed.data);
    const mediaStore = getMediaStore();
    const results = [];

    for (const message of messages) {
      if (!DOCUMENT_BEARING_TYPES.has(message.type)) {
        // Text messages, reactions and status callbacks share this endpoint. Not an error.
        log.info('WhatsApp webhook: non-document message ignored', {
          wamid: message.id,
          type: message.type,
        });
        continue;
      }

      const media = message.type === 'image' ? message.image : message.document;
      if (!media) continue; // unreachable: the Zod refinement guarantees it

      const object = await mediaStore.fetch(media.id);
      if (!object) {
        log.warn('WhatsApp webhook: media id could not be resolved; skipping', {
          wamid: message.id,
          mediaId: media.id,
        });
        results.push({
          wamid: message.id,
          disposition: 'FAILED' as const,
          reason: `Media ${media.id} not found`,
        });
        continue;
      }

      const result = await ingestDocument({
        source: 'WHATSAPP',
        // The wamid is Meta's idempotency key and is stable across redeliveries.
        externalId: message.id,
        senderIdentifier: message.from,
        bytes: object.bytes,
        mimeType: media.mime_type || object.mimeType,
        filename: object.filename,
        receivedAt: new Date(Number(message.timestamp) * 1000),
      });

      results.push({
        wamid: message.id,
        documentId: result.documentId,
        disposition: result.disposition,
        status: result.status,
        outcome: result.match?.outcome ?? null,
        reason: result.match?.reason ?? result.detail ?? null,
        topConfidence: result.match?.candidates[0]?.confidence ?? null,
      });
    }

    return accepted({ messages: results });
  } catch (error) {
    return acceptedDespiteFailure('WhatsApp webhook', error);
  }
}

/** Meta's subscription handshake. */
export function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const challenge = params.get('hub.challenge');
  if (params.get('hub.mode') === 'subscribe' && challenge) {
    return new NextResponse(challenge, { status: 200 });
  }
  return NextResponse.json({ status: 'ok', endpoint: 'whatsapp webhook' });
}
