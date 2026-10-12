import { z } from 'zod';
import { log } from '@/lib/logger';

/**
 * Domain enums.
 *
 * Prisma's SQLite connector supports neither `enum` columns nor `Json`, so the database
 * stores these as `String`. The type safety the brief asks for is recovered here: every
 * value that crosses the persistence boundary passes through one of these Zod schemas,
 * so an invalid string is a parse error at the edge rather than an `any` leaking inward.
 */

export const DOCUMENT_SOURCES = ['EMAIL', 'WHATSAPP'] as const;
export type DocumentSource = (typeof DOCUMENT_SOURCES)[number];
export const documentSourceSchema = z.enum(DOCUMENT_SOURCES);

export const DOCUMENT_STATUSES = [
  /** Persisted from the webhook; bytes stored, nothing extracted yet. */
  'RECEIVED',
  /** OCR returned structured fields. */
  'EXTRACTED',
  /** Auto-matched to exactly one transaction with high confidence. */
  'MATCHED',
  /** Plausible candidates exist but a human must choose. */
  'NEEDS_REVIEW',
  /** Extraction succeeded but nothing plausible to match against. Retryable later. */
  'UNMATCHED',
  /** Terminal. Extraction failed or produced unusable output. */
  'FAILED',
] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];
export const documentStatusSchema = z.enum(DOCUMENT_STATUSES);

export const MATCH_STATUSES = [
  /** Ranked suggestion awaiting a human decision. */
  'CANDIDATE',
  /** Confirmed by the matcher without human involvement. */
  'AUTO_CONFIRMED',
  /** Confirmed by a reviewer. */
  'CONFIRMED',
  /** Ruled out, by a reviewer or by a sibling being confirmed. */
  'REJECTED',
] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];
export const matchStatusSchema = z.enum(MATCH_STATUSES);

export const DOCUMENT_TYPES = ['RECEIPT', 'TAX_INVOICE', 'UNKNOWN'] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];
export const documentTypeSchema = z.enum(DOCUMENT_TYPES);

/** A match is settled — it can no longer be acted on by the review queue. */
export const TERMINAL_MATCH_STATUSES: readonly MatchStatus[] = [
  'AUTO_CONFIRMED',
  'CONFIRMED',
  'REJECTED',
];

/** A match that occupies the transaction's single confirmed-document slot. */
export const CONFIRMED_MATCH_STATUSES: readonly MatchStatus[] = ['AUTO_CONFIRMED', 'CONFIRMED'];

/* -------------------------------------------------------------------------- */
/* Signal breakdown codec                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Per-signal scores, stored on DocumentMatch so a reviewer can see *why* a candidate
 * scored what it did. Matches the shape the brief specifies: `Record<string, number>`.
 *
 * A signal that was not available on this document (e.g. OCR found no card number) is
 * **omitted from the record entirely** rather than stored as 0. That distinction is
 * load-bearing: "the receipt shows no card number" and "the receipt shows a *different*
 * card number" must never look alike, and a present-but-zero score means the latter.
 * Callers test availability with `key in signals`.
 */
export const signalBreakdownSchema = z.record(z.string(), z.number());
export type SignalBreakdown = z.infer<typeof signalBreakdownSchema>;

export function encodeSignals(signals: SignalBreakdown): string {
  return JSON.stringify(signals);
}

export function decodeSignals(raw: string): SignalBreakdown {
  try {
    return signalBreakdownSchema.parse(JSON.parse(raw));
  } catch {
    // A corrupt breakdown must never take down the review queue; it is explanatory
    // metadata, not a source of truth for the decision.
    return {};
  }
}

/* ========================================================================== */
/* Decoding values that come back out of the database                          */
/* ========================================================================== */

/**
 * SQLite has no enum type, so `status`, `source` and `signals` are `String` columns and
 * Prisma types them as `string`. Every read therefore crosses a boundary where the
 * application's union types are an assumption rather than a guarantee.
 *
 * Casting with `as DocumentStatus` states the assumption without checking it. These
 * decoders check it, using the same Zod schemas the rest of the module defines — which is
 * what makes "type safety is recovered at the boundary" a true statement rather than an
 * aspiration.
 *
 * An unrecognised value is a data problem, not a reason to take a page down: a single bad
 * row should not blank a register. So each decoder logs and falls back to the safest
 * reading — the one that keeps the row visible and treats it as unsettled, never as
 * settled, because silently promoting an unknown status to MATCHED would overstate the
 * compliance position.
 */

function decode<T>(
  schema: { safeParse: (v: unknown) => { success: boolean; data?: T } },
  value: string,
  fallback: T,
  field: string,
): T {
  const parsed = schema.safeParse(value);
  if (parsed.success && parsed.data !== undefined) return parsed.data;

  log.warn('Unrecognised value read from the database', { field, value });
  return fallback;
}

export function decodeDocumentStatus(value: string): DocumentStatus {
  // UNMATCHED rather than MATCHED: an unknown status must never count as covered.
  return decode(documentStatusSchema, value, 'UNMATCHED', 'Document.status');
}

export function decodeDocumentSource(value: string): DocumentSource {
  return decode(documentSourceSchema, value, 'EMAIL', 'Document.source');
}

export function decodeMatchStatus(value: string): MatchStatus {
  // CANDIDATE is the only safe default: it means "not decided", so an unreadable row
  // surfaces for a human instead of silently holding or releasing a charge.
  return decode(matchStatusSchema, value, 'CANDIDATE', 'DocumentMatch.status');
}
