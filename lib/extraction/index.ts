import { MockExtractor } from '@/lib/extraction/mock-extractor';
import { log } from '@/lib/logger';
import type { DocumentExtractor } from '@/lib/extraction/types';

/**
 * The single place the application decides which OCR implementation it is using.
 *
 * Swapping in a real provider is a change to this file only — every caller depends on
 * the `DocumentExtractor` interface. The mock stays the default so the repository runs
 * end-to-end with no API keys.
 *
 * Set `EXTRACTOR=llm` (with `ANTHROPIC_API_KEY`) to use the real vision extractor.
 */

function selectExtractor(): DocumentExtractor {
  if (process.env.EXTRACTOR !== 'llm') return new MockExtractor();

  if (!process.env.ANTHROPIC_API_KEY) {
    // Falling back rather than throwing: a missing key is a configuration mistake, and
    // a repository that refuses to boot is a worse failure than one that runs on
    // fixtures and says so loudly.
    log.warn('EXTRACTOR=llm but ANTHROPIC_API_KEY is unset — falling back to MockExtractor');
    return new MockExtractor();
  }

  // Imported lazily so the SDK is never loaded on the default path.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { LlmVisionExtractor } = require('@/lib/extraction/llm-extractor') as typeof import('@/lib/extraction/llm-extractor');
  log.info('Using LlmVisionExtractor for OCR');
  return new LlmVisionExtractor();
}

let extractor: DocumentExtractor | null = null;

export function getExtractor(): DocumentExtractor {
  if (extractor === null) extractor = selectExtractor();
  return extractor;
}

/** Test seam: lets a test substitute a failing, slow, or stub extractor. */
export function setExtractor(next: DocumentExtractor): void {
  extractor = next;
}

export { MockExtractor };
export type { DocumentExtractor };
