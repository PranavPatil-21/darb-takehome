import { z } from 'zod';

/**
 * Zod schemas for the two inbound webhook shapes.
 *
 * These are the only place untrusted outside data enters the system, so they are
 * deliberately strict about structure and lenient about content: a provider adding a
 * field must not break us (hence no `.strict()`), but a missing `messageId` must.
 */

/* ------------------------------- Email -------------------------------- */

export const emailAttachmentSchema = z.object({
  filename: z.string().min(1),
  contentType: z.string().min(1),
  /** Base64 file bytes. Validated as decodable in the route, not here. */
  contentBase64: z.string().min(1),
});

export const emailWebhookSchema = z.object({
  messageId: z.string().min(1),
  from: z.string().email(),
  to: z.string().min(1),
  subject: z.string().optional().default(''),
  receivedAt: z.string().datetime({ offset: true }),
  attachments: z.array(emailAttachmentSchema).min(1, 'An email with no attachment carries no document'),
});

export type EmailWebhookPayload = z.infer<typeof emailWebhookSchema>;

/* ------------------------------ WhatsApp ------------------------------ */

const whatsappImageSchema = z.object({
  id: z.string().min(1),
  mime_type: z.string().min(1),
  sha256: z.string().optional(),
});

const whatsappDocumentSchema = whatsappImageSchema.extend({
  filename: z.string().optional(),
});

/**
 * Meta sends `type` alongside a matching payload key. The refinement makes "type says
 * image but there is no image object" a 400 rather than an undefined dereference three
 * layers down.
 */
export const whatsappMessageSchema = z
  .object({
    id: z.string().min(1),
    from: z.string().min(1),
    /**
     * Unix seconds, as a string — Meta's format.
     *
     * Validated as numeric *here* rather than left to `Number()` downstream. A
     * non-numeric value yields `new Date(NaN)`, an Invalid Date that survives every
     * intermediate step and only fails at the database write — turning a malformed
     * payload into an opaque "accepted but not processed" instead of the 400 naming the
     * offending field that the brief asks for and the sender can actually act on. The
     * second check catches values too large to be a representable date.
     */
    timestamp: z
      .string()
      .regex(/^\d+$/, 'timestamp must be Unix seconds as a digit string')
      .refine((value) => !Number.isNaN(new Date(Number(value) * 1000).getTime()), {
        message: 'timestamp is not a representable date',
      }),
    type: z.string().min(1),
    image: whatsappImageSchema.optional(),
    document: whatsappDocumentSchema.optional(),
  })
  .refine((message) => message.type !== 'image' || message.image !== undefined, {
    message: "message.type is 'image' but no image object was provided",
    path: ['image'],
  })
  .refine((message) => message.type !== 'document' || message.document !== undefined, {
    message: "message.type is 'document' but no document object was provided",
    path: ['document'],
  });

export const whatsappWebhookSchema = z.object({
  entry: z
    .array(
      z.object({
        changes: z
          .array(
            z.object({
              value: z.object({
                messages: z.array(whatsappMessageSchema).optional(),
                /** Delivery/read receipts arrive on the same endpoint and carry no document. */
                statuses: z.array(z.unknown()).optional(),
              }),
            }),
          )
          .min(1),
      }),
    )
    .min(1),
});

export type WhatsAppWebhookPayload = z.infer<typeof whatsappWebhookSchema>;
export type WhatsAppMessage = z.infer<typeof whatsappMessageSchema>;

/**
 * Flattens Meta's entry[].changes[].value.messages[] nesting into the list we actually
 * care about. Returns [] for a status-only callback, which is a normal, non-error case.
 */
export function extractWhatsAppMessages(payload: WhatsAppWebhookPayload): WhatsAppMessage[] {
  return payload.entry.flatMap((entry) =>
    entry.changes.flatMap((change) => change.value.messages ?? []),
  );
}
