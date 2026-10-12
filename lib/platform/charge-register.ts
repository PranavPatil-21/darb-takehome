import type { PrismaClient } from '@prisma/client';
import prismaDefault from '@/lib/prisma';
import { clientScopeFilter, type Actor } from '@/lib/platform/identity';
import {
  ageBucket,
  ageingReference,
  daysUndocumented,
  documentationStatusOf,
  type AgeBucket,
  type TransactionDocumentationStatus,
} from '@/lib/platform/transaction-status';
import { periodOf } from '@/lib/ui/coverage';

/**
 * The charge register: every card transaction and where it stands.
 *
 * Filtering on a derived status is the awkward part of deriving rather than storing it.
 * The compromise here is honest about its limits: the database narrows by everything it
 * can express — client scope, card, date, free-text merchant — and the derived status and
 * age are applied afterwards, in memory.
 *
 * That is correct at this size and would not be at a hundred times it, where the answer is
 * a projection table maintained by the same transaction that writes the slot. The shape
 * returned here is deliberately what such a projection would have to produce, so the swap
 * is a change of source rather than a change of contract.
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
  status?: TransactionDocumentationStatus;
  age?: AgeBucket;
  /** Free text across merchant name and card suffix. */
  query?: string;
}

export interface ChargeRegisterResult {
  rows: ChargeRow[];
  /** Totals for what the filter selected, so the header can state the exposure. */
  matchedCount: number;
  matchedValue: number;
  /** Counts per status across the unfiltered set, for the filter chips. */
  statusCounts: Record<TransactionDocumentationStatus, number>;
  truncated: boolean;
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

  const charges = await prisma.transaction.findMany({
    where: {
      ...scope,
      ...(query
        ? {
            OR: [
              { merchantName: { contains: query } },
              { cardLast4: { contains: query } },
            ],
          }
        : {}),
    },
    orderBy: [{ transactionAt: 'desc' }, { id: 'desc' }],
    select: {
      id: true,
      merchantName: true,
      amount: true,
      currency: true,
      transactionAt: true,
      cardLast4: true,
      driverPhone: true,
      confirmedDocumentId: true,
      documents: {
        select: { status: true, verificationRequired: true, verifiedAt: true, documentId: true },
      },
    },
  });

  // Same reference the overview uses, derived from the same data, so the two screens
  // cannot report different ages for one charge.
  const latest = charges.reduce<Date | null>(
    (newest, row) => (newest === null || row.transactionAt > newest ? row.transactionAt : newest),
    null,
  );
  const asOf = ageingReference(periodOf(latest)?.to ?? null, now);

  const statusCounts: Record<TransactionDocumentationStatus, number> = {
    DOCUMENTED: 0,
    IN_REVIEW: 0,
    REJECTED: 0,
    MISSING: 0,
  };

  const all: ChargeRow[] = charges.map((charge) => {
    const status = documentationStatusOf({
      confirmedDocumentId: charge.confirmedDocumentId,
      matches: charge.documents,
    });
    statusCounts[status] += 1;

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
      status,
      age,
      bucket: ageBucket(age),
      documentId: charge.confirmedDocumentId,
      awaitingVerification:
        holding?.verificationRequired === true && holding?.verifiedAt === null,
    };
  });

  const filtered = all.filter((row) => {
    if (filter.status && row.status !== filter.status) return false;
    // Ageing describes an open gap, so an age filter implicitly excludes settled charges;
    // otherwise "over two months" would return documented history nobody can act on.
    if (filter.age && (row.status === 'DOCUMENTED' || row.bucket !== filter.age)) return false;
    return true;
  });

  return {
    rows: filtered.slice(0, PAGE_LIMIT),
    matchedCount: filtered.length,
    matchedValue: filtered.reduce((sum, row) => sum + row.amount, 0),
    statusCounts,
    truncated: filtered.length > PAGE_LIMIT,
  };
}
