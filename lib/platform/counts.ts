import type { PrismaClient } from '@prisma/client';
import prismaDefault from '@/lib/prisma';
import { clientScopeFilter, type Actor } from '@/lib/platform/identity';

/**
 * The badge counts carried by the module navigation.
 *
 * One query per badge, run together. They exist because a queue nobody can see the depth
 * of is a queue nobody picks up: the number beside a nav item is the difference between
 * "I should check Assurance at some point" and "there are four waiting".
 *
 * Every count is scoped to what the actor may see. A badge is a disclosure like any other
 * — a count of twelve tells a single-tenant user that eleven documents exist somewhere
 * they are not allowed to look.
 */

export interface NavCounts {
  review: number;
  assurance: number;
  exceptions: number;
}

export async function getNavCounts(
  actor: Actor,
  prisma: PrismaClient = prismaDefault,
): Promise<NavCounts> {
  const scope = clientScopeFilter(actor);

  const [review, assurance, exceptions] = await Promise.all([
    prisma.document.count({ where: { ...scope, status: 'NEEDS_REVIEW' } }),
    prisma.documentMatch.count({
      where: {
        status: { in: ['CONFIRMED', 'AUTO_CONFIRMED'] },
        verifiedAt: null,
        verificationRequired: true,
        document: scope,
      },
    }),
    // FAILED is an extraction that produced nothing usable; UNMATCHED with no client is a
    // document from a sender nobody has registered. Both are stuck in a way that no
    // amount of waiting resolves, which is what makes them exceptions rather than
    // in-flight work.
    prisma.document.count({
      where: {
        OR: [{ status: 'FAILED' }, { status: 'UNMATCHED', clientId: null }],
        ...scope,
      },
    }),
  ]);

  return { review, assurance, exceptions };
}
