import type { PrismaClient } from '@prisma/client';
import prismaDefault from '@/lib/prisma';
import { clientScopeFilter, type Actor } from '@/lib/platform/identity';
import { getWorkCounts } from '@/lib/platform/work-queue';

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
  /** Everything waiting on a person, decidable or not. The badge the reviewer reads. */
  review: number;
  /** Of those, the ones a reviewer can actually settle with confirm/reject. */
  reviewDecidable: number;
  /** Of those, the ones needing a different kind of fix entirely. */
  reviewBlocked: number;
  assurance: number;
}

export async function getNavCounts(
  actor: Actor,
  prisma: PrismaClient = prismaDefault,
): Promise<NavCounts> {
  const scope = clientScopeFilter(actor);

  // The review badge and the exception badge used to be two counts over two overlapping
  // queries, which is exactly how they came to disagree. Both now come from the one
  // taxonomy the queue itself is built from, so the number on the tab and the number of
  // rows behind it cannot drift apart.
  const [work, assurance] = await Promise.all([
    getWorkCounts(actor, prisma),
    prisma.documentMatch.count({
      where: {
        status: { in: ['CONFIRMED', 'AUTO_CONFIRMED'] },
        verifiedAt: null,
        verificationRequired: true,
        document: scope,
      },
    }),
  ]);

  return {
    review: work.total,
    reviewDecidable: work.decidable,
    reviewBlocked: work.blocked,
    assurance,
  };
}
