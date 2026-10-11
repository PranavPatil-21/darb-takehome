import {
  buildContentBlock,
  parseMinorUnits,
  toExtractedDocument,
} from '@/lib/extraction/llm-extractor';
import { ExtractionError } from '@/lib/extraction/types';

/**
 * The real OCR extractor, tested without a network call.
 *
 * The valuable logic here is not the API call — it is everything around it: converting a
 * printed decimal into integer minor units, normalising the model's output into the
 * domain shape, and refusing input the provider cannot accept. Those are pure functions
 * precisely so they can be tested like this.
 */

describe('parseMinorUnits', () => {
  it('converts printed decimals to halalas', () => {
    expect(parseMinorUnits('125.00')).toBe(12500);
    expect(parseMinorUnits('57.50')).toBe(5750);
    expect(parseMinorUnits('0.05')).toBe(5);
    expect(parseMinorUnits('4875.00')).toBe(487500);
  });

  it('handles a whole number with no decimal part', () => {
    expect(parseMinorUnits('125')).toBe(12500);
  });

  it('pads a single decimal place rather than misreading it', () => {
    // "125.5" is 125 riyals 50 halalas, not 125 riyals 5 halalas.
    expect(parseMinorUnits('125.5')).toBe(12550);
  });

  it('tolerates thousands separators, surrounding whitespace and a currency prefix', () => {
    expect(parseMinorUnits('4,875.00')).toBe(487500);
    expect(parseMinorUnits('1,234,567.89')).toBe(123456789);
    expect(parseMinorUnits(' 125.00 ')).toBe(12500);
    expect(parseMinorUnits('SAR 125.00')).toBe(12500);
  });

  it('rejects a decimal comma instead of reading it as a thousands separator', () => {
    // "125,00" is 125.00 in much of the world. Stripping the comma would yield 12,500.00
    // — a hundredfold error on the signal the matcher weights most heavily.
    expect(parseMinorUnits('125,00')).toBeNull();
    expect(parseMinorUnits('1,23')).toBeNull();
  });

  it('rejects digits separated by interior whitespace', () => {
    // "1 2 5" is an unreadable scan, not the number 125.
    expect(parseMinorUnits('1 2 5')).toBeNull();
    expect(parseMinorUnits('12 5.00')).toBeNull();
  });

  it('returns null rather than guessing at anything ambiguous', () => {
    // A wrong amount produces a confident match against the wrong transaction, which is
    // far worse than no match at all.
    const ambiguous = ['', 'abc', '125.000', '12.5.6', '-125.00', '1 2 5', '125,00', '١٢٥'];
    for (const input of ambiguous) {
      expect(parseMinorUnits(input)).toBeNull();
    }
  });

  it('passes null through', () => {
    expect(parseMinorUnits(null)).toBeNull();
  });

  it('never returns a non-integer or unsafe value', () => {
    for (const input of ['0.01', '999999.99', '1.1', '0']) {
      const result = parseMinorUnits(input);
      expect(result === null || Number.isSafeInteger(result)).toBe(true);
    }
  });
});

describe('toExtractedDocument', () => {
  const raw = {
    documentType: 'RECEIPT' as const,
    merchantName: '  Alfanar Fuel Station  ',
    vatNumber: '300000000000003',
    totalAmount: '125.00',
    currency: ' sar ',
    documentDate: '2025-06-14T11:02:00.000Z',
    cardLast4: '4412',
    invoiceNumber: '',
    rawText: 'ALFANAR FUEL STATION...',
    extractionConfidence: 0.96,
  };

  it('converts the printed amount into minor units', () => {
    expect(toExtractedDocument(raw).totalAmount).toBe(12500);
  });

  it('trims whitespace and uppercases the currency', () => {
    const result = toExtractedDocument(raw);
    expect(result.merchantName).toBe('Alfanar Fuel Station');
    expect(result.currency).toBe('SAR');
  });

  it('treats an empty string as an absent field, not as data', () => {
    // The matcher distinguishes "not present" from "present and contradictory"; an empty
    // string must land on the first side of that line.
    expect(toExtractedDocument(raw).invoiceNumber).toBeNull();
  });

  it('reduces a full card number to its last four digits', () => {
    // Defence in depth: if the model ever echoes a full PAN from the document, it must
    // not reach the database.
    const withPan = { ...raw, cardLast4: '4111 1111 1111 4412' };
    expect(toExtractedDocument(withPan).cardLast4).toBe('4412');
  });

  it('returns null for a card field containing no digits', () => {
    expect(toExtractedDocument({ ...raw, cardLast4: 'illegible' }).cardLast4).toBeNull();
  });

  it('carries an unusable amount through as null rather than failing', () => {
    const unreadable = { ...raw, totalAmount: 'approx 125' };
    expect(toExtractedDocument(unreadable).totalAmount).toBeNull();
  });

  it('preserves the OCR confidence verbatim', () => {
    // This value gates auto-matching; silently adjusting it would undermine the gate.
    expect(toExtractedDocument({ ...raw, extractionConfidence: 0.42 }).extractionConfidence).toBe(
      0.42,
    );
  });
});

describe('buildContentBlock', () => {
  const bytes = Buffer.from('fake-bytes');

  it('sends a PDF as a document block', () => {
    const block = buildContentBlock(bytes, 'application/pdf');
    expect(block.type).toBe('document');
    expect(block.source.media_type).toBe('application/pdf');
    expect(block.source.data).toBe(bytes.toString('base64'));
  });

  it('sends a JPEG as an image block', () => {
    const block = buildContentBlock(bytes, 'image/jpeg');
    expect(block.type).toBe('image');
    expect(block.source.media_type).toBe('image/jpeg');
  });

  it('is case-insensitive about the mime type', () => {
    expect(buildContentBlock(bytes, 'IMAGE/PNG').source.media_type).toBe('image/png');
  });

  it('rejects an image format the provider does not accept', () => {
    expect(() => buildContentBlock(bytes, 'image/tiff')).toThrow(ExtractionError);
  });

  it('rejects a non-document mime type outright', () => {
    // Better to fail fast here than to send bytes the API will reject with a 400 that
    // the pipeline would have to interpret.
    expect(() => buildContentBlock(bytes, 'application/zip')).toThrow(ExtractionError);
  });
});
