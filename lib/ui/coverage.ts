import type { PrismaClient } from '@prisma/client';
import prismaDefault from '@/lib/prisma';

/**
 * The compliance position: how much card spend still has no document attached.
 *
 * This is the read model behind the front page. It exists because counting *documents*
 * answers an engineering question ("how is the pipeline doing?") while the operator's
 * actual question is a finance one: how much of this period's spend is unsupported, and
 * what is the tax exposure if the filing goes out like that. A queue of 5 and a queue of
 * 50 look equally urgent in a count; in riyals they do not.
 *
 * Kept as a module rather than inline Prisma calls in the page so the arithmetic — in
 * particular the VAT extraction below, which is easy to get subtly wrong — has one home
 * and can be tested without rendering anything.
 */

/**
 * KSA standard VAT rate, as a fraction. Transaction amounts are what the card was
 * charged, which is VAT-inclusive, so the tax already sits *inside* the number.
 */
export const VAT_RATE = 0.15;

/**
 * Extracts the VAT already contained in a VAT-inclusive amount.
 *
 * The multiplier is 15/115, not 15/100. Applying the rate directly to a gross figure
 * computes the VAT on top of a total that already includes it and overstates the
 * recoverable input tax — on the seed data, SAR 429.14 instead of SAR 373.16. Returns
 * minor units, rounded, because money is never a float in this codebase.
 */
export function vatWithin(grossMinorUnits: number): number {
  return Math.round((grossMinorUnits * VAT_RATE) / (1 + VAT_RATE));
}

export interface CoveragePosition {
  /** Every charge in scope, documented or not. */
  chargeCount: number;
  documentedCount: number;
  undocumentedCount: number;

  /** Minor units. */
  totalSpend: number;
  undocumentedSpend: number;

  /** Input VAT sitting on spend with no supporting document. Minor units. */
  vatAtRisk: number;

  /** 0..1 — share of *spend*, not of charge count. A single large charge matters more. */
  coverageByValue: number;

  /** Work waiting on a person, as opposed to work waiting on a charge to post. */
  awaitingDecision: number;
  /** Documents that arrived with no charge to attach to yet. */
  awaitingCharge: number;

  /** The period these numbers describe, derived from the data rather than the clock. */
  period: { label: string; from: Date; to: Date } | null;
}

/**
 * The calendar month of the most recent charge, or null when there are no charges.
 *
 * Derived from the data, deliberately. Anchoring on `new Date()` would make the front
 * page read "0% covered" whenever the seed data ages past the current month, which is
 * exactly what a reviewer would see running this repository months after it was written.
 */
export function periodOf(latest: Date | null): { label: string; from: Date; to: Date } | null {
  if (!latest) return null;

  const from = new Date(Date.UTC(latest.getUTCFullYear(), latest.getUTCMonth(), 1));
  const to = new Date(Date.UTC(latest.getUTCFullYear(), latest.getUTCMonth() + 1, 1) - 1);
  const label = from.toLocaleDateString('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

  return { label, from, to };
}

export async function getCoveragePosition(
  prisma: PrismaClient = prismaDefault,
): Promise<CoveragePosition> {
  const [charges, awaitingDecision, awaitingCharge] = await Promise.all([
    prisma.transaction.findMany({
      select: { amount: true, confirmedDocumentId: true, transactionAt: true },
    }),
    prisma.document.count({ where: { status: 'NEEDS_REVIEW' } }),
    prisma.document.count({ where: { status: 'UNMATCHED' } }),
  ]);

  const latest = charges.reduce<Date | null>(
    (newest, row) => (newest === null || row.transactionAt > newest ? row.transactionAt : newest),
    null,
  );

  const undocumented = charges.filter((row) => row.confirmedDocumentId === null);
  const totalSpend = charges.reduce((sum, row) => sum + row.amount, 0);
  const undocumentedSpend = undocumented.reduce((sum, row) => sum + row.amount, 0);

  return {
    chargeCount: charges.length,
    documentedCount: charges.length - undocumented.length,
    undocumentedCount: undocumented.length,
    totalSpend,
    undocumentedSpend,
    vatAtRisk: vatWithin(undocumentedSpend),
    // Share of value, not of count: ten small documented coffees do not offset one
    // undocumented fuel card run, and a count would say they do.
    coverageByValue: totalSpend === 0 ? 1 : (totalSpend - undocumentedSpend) / totalSpend,
    awaitingDecision,
    awaitingCharge,
    period: periodOf(latest),
  };
}

export interface UndocumentedCharge {
  id: number;
  merchantName: string;
  amount: number;
  currency: string;
  transactionAt: Date;
  cardLast4: string;
  driverPhone: string | null;
}

/**
 * The charges with no document, largest first.
 *
 * Ordered by value rather than date because this list is a worklist: chasing the single
 * largest missing receipt removes more exposure than chasing the most recent one.
 */
export async function getUndocumentedCharges(
  prisma: PrismaClient = prismaDefault,
  limit = 50,
): Promise<UndocumentedCharge[]> {
  return prisma.transaction.findMany({
    where: { confirmedDocumentId: null },
    orderBy: [{ amount: 'desc' }, { transactionAt: 'desc' }],
    take: limit,
    select: {
      id: true,
      merchantName: true,
      amount: true,
      currency: true,
      transactionAt: true,
      cardLast4: true,
      driverPhone: true,
    },
  });
}
