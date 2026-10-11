import Anthropic from '@anthropic-ai/sdk';
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
import { z } from 'zod';
import { log } from '@/lib/logger';
import { DOCUMENT_TYPES } from '@/lib/domain/enums';
import { ExtractionError, type DocumentExtractor, type ExtractedDocument } from '@/lib/extraction/types';

/**
 * A real OCR implementation, behind the same `DocumentExtractor` interface as the mock.
 *
 * This exists to prove the seam is real rather than decorative: swapping it in is a
 * one-line change in `lib/extraction/index.ts`, and nothing in the pipeline, the matcher,
 * or the tests knows which implementation is running. The mock remains the default so the
 * repository runs end-to-end with no API key.
 *
 * Enable with `EXTRACTOR=llm` and an `ANTHROPIC_API_KEY`.
 */

const MODEL = 'claude-opus-5';

/**
 * What we ask the model for — deliberately NOT the shape the domain uses.
 *
 * Money is requested as the decimal string exactly as printed on the document
 * ("125.00"), not as an integer count of halalas. Asking a language model to do the
 * ×100 conversion invites silent arithmetic errors on the single most important field
 * in the system, and a wrong amount is far worse than a missing one — it produces a
 * confident match against the wrong transaction. The conversion happens in
 * `parseMinorUnits` below, which is pure and unit-tested.
 */
const extractionSchema = z.object({
  documentType: z.enum(DOCUMENT_TYPES),
  merchantName: z.string().nullable(),
  vatNumber: z.string().nullable(),
  /** Decimal string exactly as printed, e.g. "125.00". Never pre-multiplied. */
  totalAmount: z.string().nullable(),
  currency: z.string().nullable(),
  /** ISO 8601 date, or null if unreadable. */
  documentDate: z.string().nullable(),
  cardLast4: z.string().nullable(),
  invoiceNumber: z.string().nullable(),
  rawText: z.string(),
  extractionConfidence: z.number().min(0).max(1),
});

type RawExtraction = z.infer<typeof extractionSchema>;

/**
 * The same contract expressed as JSON Schema, which is what constrains the model.
 *
 * The SDK's Zod helper targets Zod 4; this project is pinned to Zod 3 by the brief, so
 * the schema is written out here and `extractionSchema` above is used to *validate* what
 * comes back. That split is worth having regardless of the version mismatch: the JSON
 * Schema constrains generation, the Zod schema is the trust boundary, and an output that
 * somehow satisfies one but not the other is caught rather than assumed away.
 */
const EXTRACTION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    documentType: { type: 'string', enum: ['RECEIPT', 'TAX_INVOICE', 'UNKNOWN'] },
    merchantName: { type: ['string', 'null'] },
    vatNumber: { type: ['string', 'null'], description: '15-digit KSA VAT number if printed' },
    totalAmount: {
      type: ['string', 'null'],
      description: 'Total exactly as printed, e.g. "125.00". Never multiplied or rounded.',
    },
    currency: { type: ['string', 'null'], description: 'ISO 4217 code, e.g. SAR' },
    documentDate: { type: ['string', 'null'], description: 'ISO 8601' },
    cardLast4: { type: ['string', 'null'], description: 'Last four digits only' },
    invoiceNumber: { type: ['string', 'null'] },
    rawText: { type: 'string', description: 'All text visible on the document' },
    extractionConfidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: [
    'documentType',
    'merchantName',
    'vatNumber',
    'totalAmount',
    'currency',
    'documentDate',
    'cardLast4',
    'invoiceNumber',
    'rawText',
    'extractionConfidence',
  ],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT = `You read receipts and tax invoices from Saudi Arabia and return their fields.

Report only what is legibly present. A field you cannot read is null — never a guess, and
never a value carried over from a similar document. Returning null for a field you could
not read is the correct answer, not a failure.

Record the total exactly as printed, including its decimal places, as a plain string:
"125.00", not "125" or "12500" or "SAR 125.00". Do not convert currencies or units.

Set extractionConfidence to how much you trust your own read of this image: near 1.0 for a
clean scan where every field is unambiguous, below 0.5 where glare, creasing, or print
quality left you uncertain. This figure gates whether the document can be matched without
a human, so an honest low number is more useful than an optimistic high one.

If the image is not a receipt or invoice at all, set documentType to UNKNOWN and leave the
other fields null.`;

/* -------------------------------------------------------------------------- */
/* Pure helpers — the parts worth testing without a network call              */
/* -------------------------------------------------------------------------- */

/**
 * Converts a printed decimal amount to integer minor units.
 *
 * Deliberately strict: anything it cannot parse unambiguously becomes null, which the
 * matcher already treats as "signal unavailable". A wrong amount is far more damaging
 * than a missing one, so this never guesses.
 */
export function parseMinorUnits(raw: string | null): number | null {
  if (raw === null) return null;

  // Trim the ends and an optional currency prefix, but do NOT strip interior whitespace:
  // "1 2 5" is an OCR misread, not the number 125, and collapsing it would invent a
  // confident amount out of an unreadable one.
  const trimmed = raw.trim().replace(/^(SAR|AED|USD)\s*/i, '');

  // Commas are accepted only in true thousands positions. "125,00" is a decimal comma
  // in much of the world; treating it as a thousands separator would read 125.00 as
  // 12,500.00 — a hundredfold error on the field the matcher weights most heavily.
  const grouped = /^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(trimmed);
  const plain = /^\d+(\.\d{1,2})?$/.test(trimmed);
  if (!grouped && !plain) return null;

  const [whole, fraction = ''] = trimmed.replace(/,/g, '').split('.');
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));

  return Number.isSafeInteger(minor) && minor >= 0 ? minor : null;
}

/** Normalises the model's output into the domain shape the pipeline expects. */
export function toExtractedDocument(raw: RawExtraction): ExtractedDocument {
  return {
    documentType: raw.documentType,
    merchantName: emptyToNull(raw.merchantName),
    vatNumber: emptyToNull(raw.vatNumber),
    totalAmount: parseMinorUnits(raw.totalAmount),
    currency: raw.currency ? raw.currency.trim().toUpperCase() : null,
    documentDate: raw.documentDate,
    // Guard against the model returning a full card number if one is printed.
    cardLast4: raw.cardLast4 ? raw.cardLast4.replace(/\D/g, '').slice(-4) || null : null,
    invoiceNumber: emptyToNull(raw.invoiceNumber),
    rawText: raw.rawText,
    extractionConfidence: raw.extractionConfidence,
  };
}

function emptyToNull(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** The content types the Claude API accepts for a document of this MIME type. */
export function buildContentBlock(file: Buffer, mimeType: string) {
  const normalised = mimeType.toLowerCase();

  if (normalised === 'application/pdf') {
    return {
      type: 'document' as const,
      source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: file.toString('base64') },
    };
  }

  if (normalised.startsWith('image/')) {
    const mediaType = (['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const).find(
      (candidate) => candidate === normalised,
    );
    if (!mediaType) {
      throw new ExtractionError(`Unsupported image type for OCR: ${mimeType}`);
    }
    return {
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: mediaType, data: file.toString('base64') },
    };
  }

  throw new ExtractionError(`Unsupported document type for OCR: ${mimeType}`);
}

/* -------------------------------------------------------------------------- */

export class LlmVisionExtractor implements DocumentExtractor {
  constructor(private readonly client: Anthropic = new Anthropic()) {}

  async extract(file: Buffer, mimeType: string): Promise<ExtractedDocument> {
    const content = buildContentBlock(file, mimeType);

    try {
      const response = await this.client.messages.parse({
        model: MODEL,
        // Generous, because thinking and the response share this budget and a truncated
        // extraction is indistinguishable from a bad one.
        max_tokens: 8192,
        // Reading fields off a receipt is perception, not reasoning — low effort keeps
        // latency and cost down without measurably hurting field accuracy.
        output_config: { effort: 'low', format: jsonSchemaOutputFormat(EXTRACTION_JSON_SCHEMA) },
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: [content, { type: 'text', text: 'Extract the fields from this document.' }],
          },
        ],
      });

      if (response.stop_reason === 'refusal') {
        // A declined request returns HTTP 200 with empty content — reading content[0]
        // here would throw. Surfaced as an ExtractionError so the pipeline moves the
        // document to FAILED instead of crashing the webhook.
        throw new ExtractionError(
          `OCR declined this document (${response.stop_details?.category ?? 'unspecified'})`,
        );
      }

      if (!response.parsed_output) {
        throw new ExtractionError('OCR returned no parseable output');
      }

      // Validate at the boundary rather than trusting the generation constraint.
      const parsed = extractionSchema.safeParse(response.parsed_output);
      if (!parsed.success) {
        throw new ExtractionError(
          `OCR output failed validation: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`,
        );
      }

      const extracted = toExtractedDocument(parsed.data);
      log.info('LlmVisionExtractor: extracted', {
        documentType: extracted.documentType,
        extractionConfidence: extracted.extractionConfidence,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      });

      return extracted;
    } catch (error) {
      if (error instanceof ExtractionError) throw error;
      // Everything else — rate limits, timeouts, network — becomes an ExtractionError so
      // the pipeline has exactly one failure type to reason about.
      const detail = error instanceof Error ? error.message : String(error);
      throw new ExtractionError(`OCR provider call failed: ${detail}`, error);
    }
  }
}
