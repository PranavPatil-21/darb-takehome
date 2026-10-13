/**
 * The public type surface of the receipt-matching capability.
 *
 * Everything a host application — or a future real OCR provider, or a consumer of the
 * matcher — needs to type against, re-exported from one path. The implementations stay
 * where they belong (the extractor contract next to the extractors, the match types next
 * to the matcher); this is the published index, so a consumer writes
 * `import type { MatchResult } from '@/types'` and is not coupled to the internal layout.
 *
 * Types only. Nothing here emits runtime code, so importing it cannot pull the database,
 * the extractor or the content layer into a consumer's bundle.
 */

/* -- Extraction: the seam a real OCR provider implements ------------------- */
export type { DocumentExtractor, ExtractedDocument } from '@/lib/extraction/types';

/* -- Media: the seam a real WhatsApp media client implements --------------- */
export type { MediaObject, MediaStore } from '@/lib/media/media-store';

/* -- Matching: the engine's inputs and outputs ----------------------------- */
export type {
  CandidateTransaction,
  MatchCandidate,
  MatchOutcome,
  MatchReason,
  MatchResult,
  MatchableDocument,
  VetoReason,
} from '@/lib/services/transaction-matcher';
export type { SignalName } from '@/lib/matching/signal-names';
export type { SignalBreakdown } from '@/lib/domain/enums';

/* -- Domain lifecycle ------------------------------------------------------ */
export type {
  DocumentSource,
  DocumentStatus,
  DocumentType,
  MatchStatus,
} from '@/lib/domain/enums';

/* -- Ingestion: what the webhook pipeline returns -------------------------- */
export type { IngestionInput, IngestionResult } from '@/lib/services/document-ingestion';

/* -- Host seams: identity and configuration -------------------------------- */
export type { Actor, Capability } from '@/lib/platform/identity';
export type { ModuleConfig } from '@/lib/platform/module-config';
