import { FIXTURES_BY_CONTENT_HASH, sha256 } from '@/fixtures';
import { log } from '@/lib/logger';
import type { DocumentExtractor, ExtractedDocument } from '@/lib/extraction/types';

/**
 * Deterministic fixture-backed OCR.
 *
 * Keyed by SHA-256 of the file bytes, so the same photo always extracts to the same
 * fields — which is what makes the ingestion and matching tests meaningful rather than
 * snapshots of randomness.
 *
 * It implements `DocumentExtractor` and nothing else depends on this class, so a real
 * provider (LLM vision, Textract, Google Document AI) substitutes with a one-line change
 * in `lib/extraction/index.ts`.
 */
export class MockExtractor implements DocumentExtractor {
  async extract(file: Buffer, mimeType: string): Promise<ExtractedDocument> {
    const hash = sha256(file);
    const fixture = FIXTURES_BY_CONTENT_HASH.get(hash);

    if (fixture) {
      return structuredClone(fixture.extraction);
    }

    // An unknown file is not an error. Real OCR returns *something* for every input, and
    // the pipeline must handle a confident-looking nothing — so that is what we return.
    log.warn('MockExtractor: no fixture for this content; returning an UNKNOWN extraction', {
      contentHash: hash.slice(0, 16),
      mimeType,
      bytes: file.byteLength,
    });

    return {
      documentType: 'UNKNOWN',
      merchantName: null,
      vatNumber: null,
      totalAmount: null,
      currency: null,
      documentDate: null,
      cardLast4: null,
      invoiceNumber: null,
      rawText: '',
      extractionConfidence: 0,
    };
  }
}
