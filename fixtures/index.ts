import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtractedDocument } from '@/lib/extraction/types';

/**
 * Fixture catalogue.
 *
 * Each entry pairs a file in `fixtures/documents/` with the extraction a real OCR
 * provider would plausibly return for it. The keying is by SHA-256 of the file bytes,
 * **computed from the file on disk at load time** — never a hardcoded digest string.
 * Hardcoding would silently desynchronise the moment anyone edits a fixture by a
 * character, and every match would quietly stop working.
 */

export interface DocumentFixture {
  /** Stable key used by the media store and the sample payloads. */
  slug: string;
  filename: string;
  mimeType: string;
  /** What this fixture is here to prove. Surfaced in the demo script output. */
  intent: string;
  extraction: ExtractedDocument;
}

const DOCUMENTS_DIR = join(process.cwd(), 'fixtures', 'documents');

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export function readFixtureFile(slug: string): Buffer {
  return readFileSync(join(DOCUMENTS_DIR, `${slug}.txt`));
}

export const DOCUMENT_FIXTURES: readonly DocumentFixture[] = [
  {
    slug: 'whatsapp-alfanar-exact',
    filename: 'alfanar-receipt.jpg',
    mimeType: 'image/jpeg',
    intent: 'Edge case 1 — every signal agrees; expect AUTO_MATCHED.',
    extraction: {
      documentType: 'RECEIPT',
      merchantName: 'Alfanar Fuel Station',
      vatNumber: '300000000000003',
      totalAmount: 12500,
      currency: 'SAR',
      documentDate: '2025-06-14T11:02:00.000Z',
      cardLast4: '4412',
      invoiceNumber: null,
      rawText: readFileSync(join(DOCUMENTS_DIR, 'whatsapp-alfanar-exact.txt'), 'utf8'),
      extractionConfidence: 0.96,
    },
  },
  {
    slug: 'whatsapp-tamimi-ambiguous',
    filename: 'tamimi-receipt.jpg',
    mimeType: 'image/jpeg',
    intent:
      'Edge case 2 — two same-amount, same-day transactions at the same chain; expect NEEDS_REVIEW.',
    extraction: {
      documentType: 'RECEIPT',
      merchantName: 'Tamimi Markets',
      vatNumber: '300000000000011',
      totalAmount: 4500,
      currency: 'SAR',
      documentDate: '2025-06-17T00:00:00.000Z',
      cardLast4: '4412',
      invoiceNumber: null,
      rawText: readFileSync(join(DOCUMENTS_DIR, 'whatsapp-tamimi-ambiguous.txt'), 'utf8'),
      extractionConfidence: 0.93,
    },
  },
  {
    slug: 'whatsapp-najd-tip',
    filename: 'najd-receipt.jpg',
    mimeType: 'image/jpeg',
    intent:
      'Edge case 3 — receipt 57.50 vs transaction 63.25 (tip); expect NEEDS_REVIEW, not a silent attach.',
    extraction: {
      documentType: 'RECEIPT',
      merchantName: 'Najd Village Restaurant',
      vatNumber: '300000000000027',
      totalAmount: 5750,
      currency: 'SAR',
      documentDate: '2025-06-12T19:30:00.000Z',
      cardLast4: '4412',
      invoiceNumber: null,
      rawText: readFileSync(join(DOCUMENTS_DIR, 'whatsapp-najd-tip.txt'), 'utf8'),
      extractionConfidence: 0.9,
    },
  },
  {
    slug: 'email-alfanar-invoice',
    filename: 'invoice-99812.pdf',
    mimeType: 'application/pdf',
    intent:
      'Emailed tax invoice with no card number; proves renormalisation over present signals still auto-matches.',
    extraction: {
      documentType: 'TAX_INVOICE',
      merchantName: 'Alfanar Fuel Company',
      vatNumber: '300000000000003',
      totalAmount: 487500,
      currency: 'SAR',
      documentDate: '2025-06-14T00:00:00.000Z',
      cardLast4: null,
      invoiceNumber: 'INV-99812',
      rawText: readFileSync(join(DOCUMENTS_DIR, 'email-alfanar-invoice.txt'), 'utf8'),
      extractionConfidence: 0.97,
    },
  },
  {
    slug: 'whatsapp-orphan-receipt',
    filename: 'kudu-receipt.jpg',
    mimeType: 'image/jpeg',
    intent: 'Edge case 5 — a good receipt for a transaction that does not exist; expect UNMATCHED.',
    extraction: {
      documentType: 'RECEIPT',
      merchantName: 'Kudu Restaurant',
      vatNumber: '300000000000044',
      totalAmount: 3300,
      currency: 'SAR',
      documentDate: '2025-06-19T13:12:00.000Z',
      cardLast4: '4412',
      invoiceNumber: null,
      rawText: readFileSync(join(DOCUMENTS_DIR, 'whatsapp-orphan-receipt.txt'), 'utf8'),
      extractionConfidence: 0.91,
    },
  },
  {
    slug: 'whatsapp-blurry-garbage',
    filename: 'blurry.jpg',
    mimeType: 'image/jpeg',
    intent:
      'Edge case 6 — OCR returned garbage; expect a terminal state and no crash anywhere in the pipeline.',
    extraction: {
      documentType: 'UNKNOWN',
      merchantName: null,
      vatNumber: null,
      totalAmount: null,
      currency: null,
      documentDate: null,
      cardLast4: null,
      invoiceNumber: null,
      rawText: readFileSync(join(DOCUMENTS_DIR, 'whatsapp-blurry-garbage.txt'), 'utf8'),
      extractionConfidence: 0.07,
    },
  },
  {
    slug: 'email-jarir-lowconfidence',
    filename: 'jarir-invoice.pdf',
    mimeType: 'application/pdf',
    intent:
      'Signals agree but the OCR distrusts its own read; expect NEEDS_REVIEW via the extraction-confidence gate.',
    extraction: {
      documentType: 'RECEIPT',
      merchantName: 'Jarir Bookstore',
      vatNumber: '300000000000055',
      totalAmount: 18000,
      currency: 'SAR',
      documentDate: '2025-06-05T00:00:00.000Z',
      cardLast4: null,
      invoiceNumber: null,
      rawText: readFileSync(join(DOCUMENTS_DIR, 'email-jarir-lowconfidence.txt'), 'utf8'),
      extractionConfidence: 0.42,
    },
  },
  {
    slug: 'whatsapp-petromin-generic',
    filename: 'petromin-receipt.jpg',
    mimeType: 'image/jpeg',
    intent:
      'Two fuel stations share the words FUEL and STATION; proves the generic-token discount keeps them apart.',
    extraction: {
      documentType: 'RECEIPT',
      merchantName: 'Petromin Fuel Station',
      vatNumber: '300000000000066',
      totalAmount: 9000,
      currency: 'SAR',
      documentDate: '2025-06-16T07:30:00.000Z',
      cardLast4: '4412',
      invoiceNumber: null,
      rawText: readFileSync(join(DOCUMENTS_DIR, 'whatsapp-petromin-generic.txt'), 'utf8'),
      extractionConfidence: 0.94,
    },
  },
] as const;

/** slug -> fixture */
export const FIXTURES_BY_SLUG: ReadonlyMap<string, DocumentFixture> = new Map(
  DOCUMENT_FIXTURES.map((fixture) => [fixture.slug, fixture]),
);

/**
 * sha256(file bytes) -> fixture. Built by hashing the real files, so a fixture edit can
 * never leave the lookup table pointing at a digest that no longer exists.
 */
export const FIXTURES_BY_CONTENT_HASH: ReadonlyMap<string, DocumentFixture> = new Map(
  DOCUMENT_FIXTURES.map((fixture) => [sha256(readFixtureFile(fixture.slug)), fixture]),
);

export function contentHashOf(slug: string): string {
  return sha256(readFixtureFile(slug));
}

export { sha256 };
