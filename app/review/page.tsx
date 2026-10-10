import Link from 'next/link';
import { AlertTriangle, FileWarning, Inbox } from 'lucide-react';
import prisma from '@/lib/prisma';
import { decodeSignals } from '@/lib/domain/enums';
import { formatDate, formatMinorUnits, formatPercent, REASON_COPY } from '@/lib/format';
import { SignalBreakdownView } from '@/components/review/signal-breakdown';
import { MatchActions } from '@/components/review/match-actions';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';

/**
 * Review queue.
 *
 * Every document the matcher refused to decide, with its ranked candidates and the
 * evidence behind each score. A reviewer's whole job is comparing two rows, so the page
 * puts the document's extracted fields directly above the candidates that reference them.
 */

export const dynamic = 'force-dynamic';

const SOURCE_TONE: Record<string, string> = {
  WHATSAPP: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
  EMAIL: 'bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200',
};

export default async function ReviewPage() {
  const [documents, counts] = await Promise.all([
    prisma.document.findMany({
      where: { status: 'NEEDS_REVIEW' },
      orderBy: { receivedAt: 'desc' },
      include: {
        matches: {
          where: { status: 'CANDIDATE' },
          orderBy: [{ confidence: 'desc' }, { transactionId: 'asc' }],
          include: { transaction: true },
        },
      },
    }),
    prisma.document.groupBy({ by: ['status'], _count: { _all: true } }),
  ]);

  const countFor = (status: string) =>
    counts.find((row) => row.status === status)?._count._all ?? 0;

  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-10">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Review queue</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Documents the matcher would not decide on its own. Each candidate shows the signal
          evidence behind its score.
        </p>
      </header>

      <div className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {(['MATCHED', 'NEEDS_REVIEW', 'UNMATCHED', 'FAILED'] as const).map((status) => (
          <Card key={status}>
            <CardContent className="py-4">
              <p className="text-2xl font-semibold tabular-nums">{countFor(status)}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{status.replace('_', ' ')}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {documents.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <Inbox className="size-8 text-muted-foreground" />
            <p className="font-medium">Nothing waiting for review</p>
            <p className="max-w-sm text-sm text-muted-foreground">
              Seed the database and fire the sample webhooks to populate the queue:{' '}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">npm run webhooks:demo</code>
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {documents.map((document) => (
            <Card key={document.id}>
              <CardHeader className="gap-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <CardTitle className="text-base">
                      {document.merchantName ?? 'Unreadable merchant'}
                      <span className="ml-2 font-normal text-muted-foreground">#{document.id}</span>
                    </CardTitle>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {formatMinorUnits(document.totalAmount, document.currency ?? 'SAR')} ·{' '}
                      {formatDate(document.documentDate)} ·{' '}
                      {document.cardLast4 ? `card ••••${document.cardLast4}` : 'no card read'}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-1.5">
                    <Badge className={SOURCE_TONE[document.source]}>{document.source}</Badge>
                    <span className="text-xs text-muted-foreground">
                      OCR confidence {formatPercent(document.extractionConfidence)}
                    </span>
                  </div>
                </div>

                {document.failureReason ? (
                  <div className="flex items-start gap-2 rounded-md bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                    <span>{REASON_COPY[document.failureReason] ?? document.failureReason}</span>
                  </div>
                ) : null}
              </CardHeader>

              <CardContent className="space-y-4">
                {document.matches.length === 0 ? (
                  <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <FileWarning className="size-4" />
                    Every candidate has been decided. This document leaves the queue on refresh.
                  </p>
                ) : null}

                {document.matches.map((match, index) => (
                  <div key={match.id}>
                    {index > 0 ? <Separator className="mb-4" /> : null}
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{match.transaction.merchantName}</span>
                          {index === 0 ? (
                            <Badge variant="secondary" className="text-[10px]">
                              best
                            </Badge>
                          ) : null}
                        </div>
                        <p className="mt-0.5 text-sm text-muted-foreground">
                          {formatMinorUnits(match.transaction.amount, match.transaction.currency)} ·{' '}
                          {formatDate(match.transaction.transactionAt)} · card ••••
                          {match.transaction.cardLast4} · txn #{match.transaction.id}
                        </p>
                      </div>

                      <div className="w-56 shrink-0">
                        <p className="mb-1.5 text-right text-sm font-semibold tabular-nums">
                          {formatPercent(match.confidence)} confidence
                        </p>
                        <SignalBreakdownView signals={decodeSignals(match.signals)} />
                      </div>

                      <MatchActions matchId={match.id} />
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <p className="mt-10 text-center text-xs text-muted-foreground">
        <Link href="/" className="underline underline-offset-4">
          Back to pipeline overview
        </Link>
      </p>
    </main>
  );
}
