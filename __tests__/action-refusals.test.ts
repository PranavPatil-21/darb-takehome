import { confirmMatch, rejectMatch } from '@/lib/actions/review';
import { upholdAttachment, overturnAttachment } from '@/lib/actions/assurance';
import { resetActorResolver, setActorResolver, type Actor } from '@/lib/platform/identity';
import { resetDatabase, seedMinimalWorld, syncChargeStatuses, testPrisma } from './helpers/db';

/**
 * A refusal is not an error.
 *
 * Every write in this module is gated twice — once by capability (may this person decide
 * at all) and once by segregation (may this person sign off *this* attachment). Both
 * gates used to answer by throwing, and `handleServerError` flattens any throw into
 * "Something went wrong while recording that decision. Please retry."
 *
 * That is wrong in two ways at once. It presents a control that is working correctly as
 * a fault in the software, which teaches operators that the permissions are flaky rather
 * than deliberate. And it instructs them to retry an action that cannot ever succeed, so
 * the advice is not merely unhelpful but false.
 *
 * These tests pin the refusals to a typed result the interface can render as a sentence.
 * They fail if either gate goes back to throwing.
 */

const VIEWER: Actor = {
  id: 'viewer',
  displayName: 'Read-only',
  capabilities: ['view'],
  clientIds: null,
};

const MAKER: Actor = {
  id: 'maker',
  displayName: 'Maker',
  capabilities: ['view', 'decide'],
  clientIds: null,
};

const CHECKER: Actor = {
  id: 'checker',
  displayName: 'Checker',
  capabilities: ['view', 'decide', 'verify'],
  clientIds: null,
};

/** The generic sentence a thrown error collapses into. No refusal may produce it. */
const GENERIC_FAILURE = 'Something went wrong while recording that decision. Please retry.';

afterEach(() => resetActorResolver());

describe('a missing capability is refused, not thrown', () => {
  it('refuses to confirm without the decide capability', async () => {
    setActorResolver(async () => VIEWER);
    const result = await confirmMatch({ matchId: 1 });

    expect(result).toMatchObject({ ok: false, effect: 'REFUSED' });
    expect('serverError' in result).toBe(false);
  });

  it('refuses to reject without the decide capability', async () => {
    setActorResolver(async () => VIEWER);
    const result = await rejectMatch({ matchId: 1 });

    expect(result).toMatchObject({ ok: false, effect: 'REFUSED' });
  });

  it('refuses to sign off without the verify capability', async () => {
    setActorResolver(async () => MAKER);
    const result = await upholdAttachment({ matchId: 1 });

    expect(result).toMatchObject({ ok: false, effect: 'REFUSED' });
  });

  it('refuses to overturn without the verify capability', async () => {
    setActorResolver(async () => MAKER);
    const result = await overturnAttachment({
      matchId: 1,
      reason: 'The receipt is for another branch.',
    });

    expect(result).toMatchObject({ ok: false, effect: 'REFUSED' });
  });

  it('never tells the operator to retry a refusal', async () => {
    setActorResolver(async () => VIEWER);

    for (const result of [
      await confirmMatch({ matchId: 1 }),
      await rejectMatch({ matchId: 1 }),
      await upholdAttachment({ matchId: 1 }),
      await overturnAttachment({ matchId: 1, reason: 'Wrong branch entirely.' }),
    ]) {
      const message =
        'message' in result
          ? (result as { message: string }).message
          : (result as { serverError: string }).serverError;
      expect(message).not.toBe(GENERIC_FAILURE);
      // A refusal has to say what was refused, or it is no better than the generic one.
      expect(message.length).toBeGreaterThan(10);
    }
  });
});

describe('segregation of duties is refused, not thrown', () => {
  beforeEach(async () => {
    await resetDatabase();
    await seedMinimalWorld();
  });

  it('refuses to let the person who attached a receipt sign off their own work', async () => {
    const transaction = await testPrisma.transaction.findFirstOrThrow();
    const document = await testPrisma.document.create({
      data: {
        clientId: transaction.clientId,
        source: 'WHATSAPP',
        senderIdentifier: '966551234567',
        externalId: 'refusal-test-1',
        contentHash: 'refusal-test-content-hash',
        status: 'MATCHED',
        rawText: 'ALFANAR FUEL ST 04 RUH  125.00 SAR',
        merchantName: 'Alfanar Fuel Station',
        totalAmount: transaction.amount,
        currency: 'SAR',
      },
    });
    const match = await testPrisma.documentMatch.create({
      data: {
        documentId: document.id,
        transactionId: transaction.id,
        status: 'CONFIRMED',
        confidence: 0.9,
        decidedBy: CHECKER.id,
        decidedAt: new Date(),
        signals: '{}',
      },
    });
    // The confirmed match and the slot that mirrors it are written together, because a
    // confirmation in production always claims the slot. Writing only one side produces a
    // state no write path can reach, and the global slot-agreement invariant rejects it.
    await testPrisma.transaction.update({
      where: { id: transaction.id },
      data: { confirmedDocumentId: document.id },
    });
    // Fixtures written directly bypass the write paths that maintain the cache, so it is
    // brought back in line the way a backfill would.
    await syncChargeStatuses();

    setActorResolver(async () => CHECKER);
    const result = await upholdAttachment({ matchId: match.id });

    expect(result).toMatchObject({ ok: false, effect: 'REFUSED' });
    expect((result as { message: string }).message).toContain('You attached this');
  });
});
