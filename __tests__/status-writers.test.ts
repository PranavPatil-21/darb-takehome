import { documentStatusOf, documentFailureReasonOf } from '@/lib/domain/document-status';
import { recomputeDocumentStatus } from '@/lib/services/document-status';
import { recomputeDocumentationStatus } from '@/lib/services/charge-status';
import { resetDatabase, seedMinimalWorld, testPrisma } from './helpers/db';

/**
 * The two single writers, and the pure derivation under them.
 *
 * These modules carry the correctness argument for every cached status in the product —
 * `IMPLEMENTATION.md` calls each "the only writer" — and their branches were the least
 * covered code in the repository. The row-deleted-underneath-us guard in particular is a
 * deliberate design decision, argued in a comment, asserted nowhere: a decision that
 * otherwise succeeded must not fail because its subject vanished mid-transaction.
 */

beforeEach(async () => {
  await resetDatabase();
  await seedMinimalWorld();
});

afterAll(async () => {
  await testPrisma.$disconnect();
});

describe('the derivation is total over its inputs', () => {
  it('keeps a FAILED document terminal however its matches look', () => {
    // An unreadable scan does not become matchable because a match row exists.
    expect(
      documentStatusOf({ currentStatus: 'FAILED', matches: [{ status: 'CONFIRMED' }] }),
    ).toBe('FAILED');
  });

  it.each(['RECEIVED', 'EXTRACTED'] as const)(
    'leaves a %s document alone while it is still mid-pipeline',
    (currentStatus) => {
      expect(documentStatusOf({ currentStatus, matches: [] })).toBe(currentStatus);
    },
  );

  it('moves a pre-match document on once it actually has matches', () => {
    expect(
      documentStatusOf({ currentStatus: 'EXTRACTED', matches: [{ status: 'CANDIDATE' }] }),
    ).toBe('NEEDS_REVIEW');
  });

  it('prefers a confirmed match over surviving candidates', () => {
    expect(
      documentStatusOf({
        currentStatus: 'NEEDS_REVIEW',
        matches: [{ status: 'CANDIDATE' }, { status: 'AUTO_CONFIRMED' }],
      }),
    ).toBe('MATCHED');
  });

  it('returns UNMATCHED when every candidate was ruled out', () => {
    expect(
      documentStatusOf({ currentStatus: 'NEEDS_REVIEW', matches: [{ status: 'REJECTED' }] }),
    ).toBe('UNMATCHED');
  });
});

describe('the failure reason carries both of its meanings', () => {
  it('names the rejection when candidates existed and were all ruled out', () => {
    expect(documentFailureReasonOf('UNMATCHED', [{ status: 'REJECTED' }], 'MID_CONFIDENCE')).toBe(
      'ALL_CANDIDATES_REJECTED',
    );
  });

  it('keeps the original reason when nothing was ever proposed', () => {
    expect(documentFailureReasonOf('UNMATCHED', [], 'NO_CANDIDATE_TRANSACTIONS')).toBe(
      'NO_CANDIDATE_TRANSACTIONS',
    );
  });

  it('clears the reason once the document is settled', () => {
    expect(documentFailureReasonOf('MATCHED', [{ status: 'CONFIRMED' }], 'MID_CONFIDENCE')).toBeNull();
  });

  it('preserves the matcher’s reason while a person is still looking', () => {
    expect(
      documentFailureReasonOf('NEEDS_REVIEW', [{ status: 'CANDIDATE' }], 'AMBIGUOUS_TOP_CANDIDATES'),
    ).toBe('AMBIGUOUS_TOP_CANDIDATES');
  });
});

describe('a writer whose row vanished reports it rather than throwing', () => {
  // Both guards exist so a decision that otherwise succeeded is not failed by its subject
  // being deleted mid-transaction. Each was argued in a comment and asserted nowhere.
  it('recomputeDocumentStatus returns null for a document that no longer exists', async () => {
    await expect(recomputeDocumentStatus(testPrisma, 999_999)).resolves.toBeNull();
  });

  it('recomputeDocumentationStatus returns null for a charge that no longer exists', async () => {
    await expect(recomputeDocumentationStatus(testPrisma, 999_999)).resolves.toBeNull();
  });
});
