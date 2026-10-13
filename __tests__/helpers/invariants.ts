import type { PrismaClient } from '@prisma/client';
import prismaDefault from '@/lib/prisma';
import { documentationStatusOf } from '@/lib/platform/transaction-status';
import { CONFIRMED_MATCH_STATUSES, decodeMatchStatus } from '@/lib/domain/enums';

/**
 * The materialised charge status must equal what the derivation would say.
 *
 * `Transaction.documentationStatus` is a cache of `documentationStatusOf`, kept current by
 * `recomputeDocumentationStatus` on every write path that can change its inputs. A cache
 * maintained by seven call sites will drift the moment an eighth is added, and the drift
 * is silent: the register shows a stale state and nothing errors.
 *
 * So this re-derives the status for *every* charge from its live relations and compares.
 * It is deliberately called at the end of ordinary scenarios — ingestion, confirm, reject,
 * overturn, rematch — rather than only from one dedicated test. A write path added later
 * without a recompute fails somebody else's test, which is where an invariant actually
 * gets noticed.
 */
export async function expectStatusesConsistent(
  prisma: PrismaClient = prismaDefault,
): Promise<void> {
  const charges = await prisma.transaction.findMany({
    select: {
      id: true,
      documentationStatus: true,
      confirmedDocumentId: true,
      documents: { select: { status: true } },
    },
  });

  const drifted = charges
    .map((charge) => {
      const derived = documentationStatusOf({
        confirmedDocumentId: charge.confirmedDocumentId,
        matches: charge.documents.map((m) => ({ status: decodeMatchStatus(m.status) })),
      });
      return derived === charge.documentationStatus
        ? null
        : { id: charge.id, stored: charge.documentationStatus, derived };
    })
    .filter((row) => row !== null);

  expect(drifted).toEqual([]);
}

/**
 * A charge may hold at most one confirmed document, and its slot must agree with its
 * matches.
 *
 * `Transaction.confirmedDocumentId` is a mirror; `DocumentMatch.status` is the fact. The
 * database constrains the mirror — the column is scalar and uniquely indexed — and
 * constrains the fact not at all, so nothing stops two `CONFIRMED` rows pointing at one
 * charge. Agreement is maintained by compare-and-set in application code, which is
 * exactly the kind of guarantee that needs a net under it.
 *
 * It had none. `expectStatusesConsistent` re-derives the cached documentation status and
 * nothing else, so a write path that released a slot without flipping its match committed
 * silently through a green suite. This closes that gap the same way: re-derived after
 * every test, so the failure lands on whoever introduces it.
 */
export async function expectSlotAgreesWithMatches(
  prisma: PrismaClient = prismaDefault,
): Promise<void> {
  const charges = await prisma.transaction.findMany({
    select: {
      id: true,
      confirmedDocumentId: true,
      documents: { select: { documentId: true, status: true } },
    },
  });

  const broken = charges
    .map((charge) => {
      const confirmed = charge.documents.filter((m) =>
        CONFIRMED_MATCH_STATUSES.includes(decodeMatchStatus(m.status)),
      );

      if (confirmed.length > 1) {
        return { id: charge.id, problem: 'two confirmed matches', confirmed: confirmed.length };
      }
      // The slot must name the document its confirmed match names, and be empty when
      // there is no confirmed match.
      const expected = confirmed[0]?.documentId ?? null;
      return expected === charge.confirmedDocumentId
        ? null
        : { id: charge.id, problem: 'slot disagrees', slot: charge.confirmedDocumentId, expected };
    })
    .filter((row) => row !== null);

  expect(broken).toEqual([]);
}
