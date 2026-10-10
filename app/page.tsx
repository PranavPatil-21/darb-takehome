import Link from 'next/link';
import prisma from '@/lib/prisma';
import { decodeSignals } from '@/lib/domain/enums';
import { formatDate, formatMinorUnits, formatPercent, REASON_COPY } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

/**
 * Pipeline overview.
 *
 * Not a required deliverable — it exists because the fastest way to understand what the
 * matcher did is to see every document next to the outcome it reached and the reason it
 * reached it.
 */

export const dynamic = 'force-dynamic';

const STATUS_TONE: Record<string, string> = {
  MATCHED: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
  NEEDS_REVIEW: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  UNMATCHED: 'bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-200',
  FAILED: 'bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200',
  RECEIVED: 'bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-200',
  EXTRACTED: 'bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200',
};

export default async function HomePage() {
  const [documents, transactionCount, matchedCount] = await Promise.all([
    prisma.document.findMany({
      orderBy: { id: 'asc' },
      include: {
        matches: {
          orderBy: [{ confidence: 'desc' }, { transactionId: 'asc' }],
          include: { transaction: true },
        },
      },
    }),
    prisma.transaction.count(),
    prisma.transaction.count({ where: { confirmedDocumentId: { not: null } } }),
  ]);

  const needsReview = documents.filter((d) => d.status === 'NEEDS_REVIEW').length;

  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-10">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Darb · document matching</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Receipts and invoices arrive by WhatsApp and email, are extracted by OCR, and are scored
          against card transactions. High-confidence matches attach themselves; everything
          ambiguous goes to{' '}
          <Link href="/review" className="underline underline-offset-4">
            review
          </Link>
          .
        </p>
      </header>

      <div className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Documents ingested" value={documents.length} />
        <Stat label="Transactions seeded" value={transactionCount} />
        <Stat label="Transactions documented" value={matchedCount} />
        <Stat label="Awaiting review" value={needsReview} />
      </div>

      {documents.length === 0 ? (
        <Card>
          <CardContent className="py-14 text-center text-sm text-muted-foreground">
            No documents yet. Run{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">npm run webhooks:demo</code> to
            fire the sample payloads through both webhooks.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Every document, and what the matcher decided</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>#</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Document</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Best candidate</TableHead>
                  <TableHead className="text-right">Confidence</TableHead>
                  <TableHead>Why</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {documents.map((document) => {
                  const best = document.matches[0];
                  const signals = best ? decodeSignals(best.signals) : {};
                  return (
                    <TableRow key={document.id}>
                      <TableCell className="tabular-nums text-muted-foreground">
                        {document.id}
                      </TableCell>
                      <TableCell className="text-xs">{document.source}</TableCell>
                      <TableCell>
                        <div className="font-medium">{document.merchantName ?? '—'}</div>
                        <div className="text-xs text-muted-foreground">
                          {formatDate(document.documentDate)}
                          {document.cardLast4 ? ` · ••••${document.cardLast4}` : ''}
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatMinorUnits(document.totalAmount, document.currency ?? 'SAR')}
                      </TableCell>
                      <TableCell>
                        <Badge className={STATUS_TONE[document.status]}>
                          {document.status.replace('_', ' ')}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {best ? (
                          <>
                            <div className="text-sm">{best.transaction.merchantName}</div>
                            <div className="text-xs text-muted-foreground">
                              txn #{best.transaction.id} ·{' '}
                              {formatMinorUnits(
                                best.transaction.amount,
                                best.transaction.currency,
                              )}
                            </div>
                          </>
                        ) : (
                          <span className="text-sm text-muted-foreground">none</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {best ? formatPercent(best.confidence) : '—'}
                        {best ? (
                          <div className="text-[10px] text-muted-foreground">
                            {Object.entries(signals)
                              .filter(([, score]) => score !== null)
                              .map(([key, score]) => `${key[0]}${Math.round((score ?? 0) * 100)}`)
                              .join(' · ')}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell className="max-w-xs text-xs text-muted-foreground">
                        {document.failureReason
                          ? (REASON_COPY[document.failureReason] ?? document.failureReason)
                          : document.status === 'MATCHED'
                            ? REASON_COPY.CONFIDENT_SINGLE_CANDIDATE
                            : '—'}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </main>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardContent className="py-4">
        <p className="text-2xl font-semibold tabular-nums">{value}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{label}</p>
      </CardContent>
    </Card>
  );
}
