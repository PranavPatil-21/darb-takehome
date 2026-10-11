import { MockExtractor } from '@/lib/extraction/mock-extractor';
import type { DocumentExtractor } from '@/lib/extraction/types';

/**
 * The single place the application decides which OCR implementation it is using.
 *
 * Swapping in a real provider is a change to this file only — every caller depends on the
 * `DocumentExtractor` interface, never on a concrete class. The fixture-backed mock is
 * the default so the repository runs end-to-end with no API keys.
 */

let extractor: DocumentExtractor = new MockExtractor();

export function getExtractor(): DocumentExtractor {
  return extractor;
}

/** Test seam: lets a test substitute a failing, slow, or stub extractor. */
export function setExtractor(next: DocumentExtractor): void {
  extractor = next;
}

export { MockExtractor };
export type { DocumentExtractor };
