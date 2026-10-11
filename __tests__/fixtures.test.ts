import { DOCUMENT_FIXTURES, FIXTURES_BY_CONTENT_HASH, FIXTURES_BY_SLUG } from '@/fixtures';
import { MEDIA_MAP } from '@/lib/media/media-store';

/**
 * Guards on the fixture catalogue itself.
 *
 * These exist because the catalogue has three invariants that fail *silently* rather than
 * loudly. A demo scenario whose bytes collide with another's is rejected as a duplicate and
 * proves nothing; a media id pointing at a slug that no longer exists returns a 404 the
 * webhook treats as ordinary; a fixture missing from the hash map extracts to UNKNOWN. In
 * every case the script still prints a 200 and the scenario quietly stops demonstrating what
 * its annotation claims. This project has already paid for the first of those once.
 */

describe('fixture catalogue', () => {
  it('gives every fixture distinct bytes, so none collapses into another as a duplicate', () => {
    // Document.contentHash is globally unique. Two fixtures sharing bytes means the second
    // is never ingested, and whatever it was meant to demonstrate silently disappears.
    expect(FIXTURES_BY_CONTENT_HASH.size).toBe(DOCUMENT_FIXTURES.length);
  });

  it('gives every fixture a distinct slug', () => {
    expect(FIXTURES_BY_SLUG.size).toBe(DOCUMENT_FIXTURES.length);
  });

  it('points every media id at a fixture that exists', () => {
    for (const [mediaId, slug] of Object.entries(MEDIA_MAP)) {
      expect(FIXTURES_BY_SLUG.has(slug)).toBe(true);
      // Named in the failure message so a broken entry identifies itself.
      expect({ mediaId, resolved: FIXTURES_BY_SLUG.has(slug) }).toEqual({
        mediaId,
        resolved: true,
      });
    }
  });

  it('states what each fixture is for', () => {
    // The intent string is what the demo script and the docs quote. An empty one means a
    // scenario nobody can explain.
    for (const fixture of DOCUMENT_FIXTURES) {
      expect(fixture.intent.trim().length).toBeGreaterThan(0);
    }
  });
});
