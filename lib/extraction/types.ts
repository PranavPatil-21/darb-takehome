import type { DocumentType } from '@/lib/domain/enums';

/**
 * The structured output of OCR. Every field is nullable because real OCR routinely
 * fails to find any given field on a crumpled petrol-station receipt — the pipeline is
 * built so that a null is ordinary input, never an exception.
 */
export interface ExtractedDocument {
  documentType: DocumentType;
  merchantName: string | null;
  /** 15-digit KSA VAT number, when present. */
  vatNumber: string | null;
  /** Minor units (halalas). Integer — money is never a float in this codebase. */
  totalAmount: number | null;
  /** ISO 4217. */
  currency: string | null;
  /** ISO 8601. */
  documentDate: string | null;
  cardLast4: string | null;
  invoiceNumber: string | null;
  rawText: string;
  /** 0..1 — the OCR provider's own confidence, not the matcher's. */
  extractionConfidence: number;
}

/**
 * The seam that keeps a real OCR provider swappable. The pipeline depends only on this
 * interface; `MockExtractor` is the default so the repo runs with no API keys, and an
 * LLM-vision or AWS Textract implementation drops in behind it unchanged.
 */
export interface DocumentExtractor {
  extract(file: Buffer, mimeType: string): Promise<ExtractedDocument>;
}

/** Thrown by an extractor when the input is unusable. Caught at the pipeline edge. */
export class ExtractionError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ExtractionError';
  }
}
