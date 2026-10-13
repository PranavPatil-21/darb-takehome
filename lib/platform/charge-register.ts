import type { PrismaClient } from '@prisma/client';
import prismaDefault from '@/lib/prisma';
import { clientScopeFilter, type Actor } from '@/lib/platform/identity';
import {
  ageBucket,
  ageBucketRange,
  ageingReference,
  daysUndocumented,
  type AgeBucket,
  type TransactionDocumentationStatus,
} from '@/lib/platform/transaction-status';
import { decodeDocumentationStatus } from '@/lib/domain/enums';
import { periodOf } from '@/lib/ui/coverage';

/**
 * The charge register: every card transaction and where it stands.
 *
 * Every filter this register offers is expressed in SQL — client scope, card, date,
 * free-text merchant, documentation status and age. Nothing is narrowed in memory.
 *
 * That was not always true, and the reason it is worth stating: status and age used to be
 * derived per row after loading, which meant the register had to read every charge and its
 * matches to answer a filtered question. `Transaction.documentationStatus` is the
 * projection that removed it — maintained by `recomputeDocumentationStatus` inside the
 * same transaction as every write that can change it, and re-derived against the live
 * relations after every test by `expectStatusesConsistent`. See
 * `docs/specs/2026-10-13-platform-architecture-design.md`.
 */

export interface ChargeRow {
  id: number;
  merchantName: string;
  amount: number;
  currency: string;
  transactionAt: Date;
  cardLast4: string;
  driverPhone: string | null;
  status: TransactionDocumentationStatus;
  age: number;
  bucket: AgeBucket;
  /** The document holding the slot, when there is one. */
  documentId: number | null;
  /** True when that attachment is still waiting on an independent sign-off. */
  awaitingVerification: boolean;
}

export interface ChargeFilter {
  // `| undefined` is explicit because callers build these straight from `searchParams`,
  // where an absent filter is literally the value `undefined` rather than a missing key.
  status?: TransactionDocumentationStatus | undefined;
  age?: AgeBucket | undefined;
  /** Free text across merchant name and card suffix. */
  query?: string | undefined;
  /** Id of the last row on the previous page. Paging happens in the query, not in Node. */
  cursor?: number | undefined;
}

export interface ChargeRegisterResult {
  /** True when another page exists. */
  hasMore: boolean;
  /** Pass back as `filter.cursor` to fetch it. */
  nextCursor: number | null;
  rows: ChargeRow[];
  /** Totals for what the filter selected, so the header can state the exposure. */
  matchedCount: number;
  matchedValue: number;
  /** Counts per status across the unfiltered set, for the filter chips. */
  statusCounts: Record<TransactionDocumentationStatus, number>;
}

const PAGE_LIMIT = 200;

export async function getChargeRegister(
  actor: Actor,
  filter: ChargeFilter,
  now: Date,
  prisma: PrismaClient = prismaDefault,
): Promise<ChargeRegisterResult> {
  const scope = clientScopeFilter(actor);
  const query = filter.query?.trim();

  const search = query
    ? {
        OR: [
          { merchantName: { contains: query } },
          { cardLast4: { contains: query } },
        ],
      }
    : {};

  // The ageing reference is the end of the period the data actually covers, so the
  // register and the overview never disagree about how old a charge is. One indexed read
  // for the newest timestamp, rather than loading every charge to find the maximum.
  // Scope only — deliberately *not* `search`. The reference describes the period this
  // actor's data covers, which is a property of the dataset and not of whatever the
  // operator happens to have typed. Including the query moved the reference with it, so
  // the same charge aged differently depending on the search box: 78 days unfiltered,
  // 16 days once the newer charges were filtered out. Two numbers for one row on one
  // screen, and the comment above promised the opposite.
  const newest = await prisma.transaction.findFirst({
    where: scope,
    orderBy: { transactionAt: 'desc' },
    select: { transactionAt: true },
  });
  const asOf = ageingReference(periodOf(newest?.transactionAt ?? null)?.to ?? null, now);

  // An age filter describes an *open* gap, so it implicitly excludes settled charges —
  // otherwise "over two months" returns documented history nobody can act on.
  const ageFilter = filter.age
    ? {
        transactionAt: ageBucketRange(filter.age, asOf),
        documentationStatus: { not: 'DOCUMENTED' },
      }
    : {};

  // `AND`, not a spread. Both the status chip and the age chip constrain
  // `documentationStatus` — the age bands are defined over *undocumented* charges — so
  // spreading them into one object let the later key silently replace the earlier one.
  // An operator could select "Documented" and "1 to 4 weeks" together and be shown a
  // priced set of charges with no receipt at all, under a chip reading Documented.
  //
  // Composed, the two are simply intersected, and selecting a status that cannot overlap
  // the age band correctly yields nothing rather than yielding the wrong thing.
  const where = {
    ...scope,
    ...search,
    AND: [
      ...(filter.status ? [{ documentationStatus: filter.status }] : []),
      ...(Object.keys(ageFilter).length > 0 ? [ageFilter] : []),
    ],
  };

  const [statusGroups, matched, charges] = await Promise.all([
    // Four counts from one indexed grouping. This replaced loading every charge and its
    // matches into Node to tally them, which is the whole reason the status is stored.
    prisma.transaction.groupBy({
      by: ['documentationStatus'],
      where: { ...scope, ...search },
      _count: true,
    }),
    prisma.transaction.aggregate({
      where,
      _count: true,
      _sum: { amount: true },
    }),
    prisma.transaction.findMany({
      where,
      orderBy: [{ transactionAt: 'desc' }, { id: 'desc' }],
      // One more than the page, so "is there another page" costs no extra query.
      take: PAGE_LIMIT + 1,
      ...(filter.cursor ? { skip: 1, cursor: { id: filter.cursor } } : {}),
      select: {
        id: true,
        merchantName: true,
        amount: true,
        currency: true,
        transactionAt: true,
        cardLast4: true,
        driverPhone: true,
        confirmedDocumentId: true,
        documentationStatus: true,
        // Only the sign-off flags are still needed per row; the status no longer is.
        documents: {
          where: { status: { in: ['CONFIRMED', 'AUTO_CONFIRMED'] } },
          select: { verificationRequired: true, verifiedAt: true, documentId: true },
        },
      },
    }),
  ]);

  const statusCounts: Record<TransactionDocumentationStatus, number> = {
    DOCUMENTED: 0,
    IN_REVIEW: 0,
    REJECTED: 0,
    MISSING: 0,
  };
  // `+=`, not `=`. `decodeDocumentationStatus` maps every unrecognised value onto
  // `MISSING` so a corrupt row stays visible and counts as unsettled — which means two
  // raw groups can decode onto one key. Assigning threw the first group away, so a single
  // bad row could delete an entire status from the chips while the rows below still
  // listed them.
  for (const group of statusGroups) {
    statusCounts[decodeDocumentationStatus(group.documentationStatus)] += group._count;
  }

  const hasMore = charges.length > PAGE_LIMIT;
  const page = hasMore ? charges.slice(0, PAGE_LIMIT) : charges;

  const rows: ChargeRow[] = page.map((charge) => {
    const age = daysUndocumented(charge.transactionAt, asOf);

    // Only the match that actually holds the slot can be awaiting sign-off; a rejected
    // sibling carrying a stale verificationRequired flag must not light up the row.
    const holding = charge.documents.find(
      (m) => charge.confirmedDocumentId !== null && m.documentId === charge.confirmedDocumentId,
    );

    return {
      id: charge.id,
      merchantName: charge.merchantName,
      amount: charge.amount,
      currency: charge.currency,
      transactionAt: charge.transactionAt,
      cardLast4: charge.cardLast4,
      driverPhone: charge.driverPhone,
      status: decodeDocumentationStatus(charge.documentationStatus),
      age,
      bucket: ageBucket(age),
      documentId: charge.confirmedDocumentId,
      awaitingVerification:
        holding?.verificationRequired === true && holding?.verifiedAt === null,
    };
  });

  return {
    rows,
    matchedCount: matched._count,
    matchedValue: matched._sum.amount ?? 0,
    statusCounts,
    hasMore,
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
  };
}
