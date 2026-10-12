import {
  decodeDocumentSource,
  decodeDocumentStatus,
  decodeMatchStatus,
} from '@/lib/domain/enums';

/**
 * Decoding values that come back out of the database.
 *
 * SQLite has no enum type, so these columns are `String` and Prisma types them as
 * `string`. Every read crosses a boundary where the union types are an assumption. These
 * tests exist because the previous code stated that assumption with `as DocumentStatus`
 * and never checked it — which made "type safety is recovered at the boundary" a claim
 * the codebase did not actually honour.
 */

describe('decoding a known value', () => {
  it('returns it unchanged', () => {
    expect(decodeDocumentStatus('MATCHED')).toBe('MATCHED');
    expect(decodeMatchStatus('AUTO_CONFIRMED')).toBe('AUTO_CONFIRMED');
    expect(decodeDocumentSource('WHATSAPP')).toBe('WHATSAPP');
  });
});

describe('decoding a value the application does not recognise', () => {
  it('keeps the row readable instead of throwing', () => {
    // A single corrupt row must not blank a register. The alternative — throwing — turns
    // one bad value into an unusable page.
    expect(() => decodeDocumentStatus('GARBAGE')).not.toThrow();
    expect(() => decodeMatchStatus('GARBAGE')).not.toThrow();
    expect(() => decodeDocumentSource('GARBAGE')).not.toThrow();
  });

  it('never lets an unknown document status count as covered', () => {
    // The direction of the fallback is the whole safety argument. Falling back to MATCHED
    // would let a corrupt row inflate the coverage figure, which is the one number nobody
    // should discover is optimistic during an audit.
    expect(decodeDocumentStatus('GARBAGE')).toBe('UNMATCHED');
    expect(decodeDocumentStatus('')).toBe('UNMATCHED');
  });

  it('never lets an unknown match status hold or release a charge', () => {
    // CANDIDATE means "not decided", so an unreadable row surfaces for a human rather
    // than silently occupying a transaction's single confirmed-document slot.
    expect(decodeMatchStatus('GARBAGE')).toBe('CANDIDATE');
  });

  it('falls back to a source that changes no scoping decision', () => {
    // EMAIL scopes to the client rather than to one driver's cards, so an unreadable
    // source cannot widen a WhatsApp document's reach beyond what it already had.
    expect(decodeDocumentSource('GARBAGE')).toBe('EMAIL');
  });
});
