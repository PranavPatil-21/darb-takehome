import { NextResponse } from 'next/server';
import { extractWhatsAppMessages, whatsappWebhookSchema } from '@/lib/webhooks/schemas';
import { allowUnsignedWebhooks, verifySignature } from '@/lib/webhooks/signature';
import { accepted, badRequest, unauthorized, retryLater } from '@/lib/webhooks/respond';
import { getMediaStore, MediaUnavailableError } from '@/lib/media/media-store';
import { ingestDocument } from '@/lib/services/document-ingestion';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';

/** One row per inbound message: what we did with it, and why. */
interface MessageOutcome {
  wamid: string;
  documentId?: number;
  disposition: 'INGESTED' | 'DUPLICATE' | 'FAILED' | 'SKIPPED' | 'RETRYABLE';
  status?: string;
  outcome?: string | null;
  reason?: string | null;
  topConfidence?: number | null;
}

/** Meta sends media ids, not bytes; these are the message types that carry a document. */
const DOCUMENT_BEARING_TYPES = new Set(['image', 'document']);

/**
 * Inbound WhatsApp webhook (simplified Meta Cloud API shape).
 *
 * Media arrives as an id that must be resolved to bytes through the `MediaStore` seam.
 * Each message is processed in isolation, and the two ways a media id can fail are kept
 * apart: an id the provider does not know is skipped, while a provider that is reachable
 * but failing is reported as retryable so the receipt is not silently lost.
 */
export async function POST(request: Request) {
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

  const messages = extractWhatsAppMessages(parsed.data);
  const mediaStore = getMediaStore();
  const results: MessageOutcome[] = [];

  // Each message is isolated. The loop used to sit inside one try, so a single media
  // fetch that threw aborted every message after it and still answered 200 — Meta would
  // never redeliver, and those receipts were gone with no record of them.
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

    try {
      const object = await mediaStore.fetch(media.id);

      if (!object) {
        // Permanently unknown to the provider. Retrying will never help, so this is a
        // skip rather than a retry — distinct from the throw handled below.
        log.warn('WhatsApp webhook: media id unknown; skipping', {
          wamid: message.id,
          mediaId: media.id,
        });
        results.push({
          wamid: message.id,
          disposition: 'SKIPPED',
          reason: `Media ${media.id} is unknown to the provider`,
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
    } catch (error) {
      // `MediaUnavailableError` is the provider being reachable but failing, as opposed
      // to the id being unknown. The distinction is the whole point: there are no bytes,
      // so there is no content hash and therefore no Document we could park in FAILED.
      // The only way not to lose the receipt is for Meta to send it again, which means
      // this message must be reported as retryable rather than quietly acknowledged.
      const retryable = error instanceof MediaUnavailableError;
      const detail = error instanceof Error ? error.message : String(error);

      log.error('WhatsApp webhook: message failed, continuing with the rest', {
        wamid: message.id,
        mediaId: media.id,
        retryable,
        detail,
      });

      results.push({
        wamid: message.id,
        disposition: retryable ? 'RETRYABLE' : 'FAILED',
        reason: detail,
      });
    }
  }

  // One unreadable message makes the whole response a request for redelivery. The items
  // that succeeded are reported either way, and dedupe on redelivery.
  const anyRetryable = results.some((r) => r.disposition === 'RETRYABLE');
  return anyRetryable ? retryLater({ messages: results }) : accepted({ messages: results });
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
