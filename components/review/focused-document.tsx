import { formatDay, formatMinorUnits, NEXT_STEP_COPY, REASON_COPY } from '@/lib/format';
import { SOURCE_LABEL } from '@/lib/ui/vocabulary';
import type { ComparableCharge } from '@/lib/ui/comparison';
import { AmbiguityCallout } from '@/components/review/ambiguity-callout';
import { CandidateCard, type CandidateCharge } from '@/components/review/candidate-card';
import { RawTextPanel } from '@/components/review/raw-text-panel';

/**
 * The decision, assembled.
 *
 * Order is the argument here. The reason the matcher stopped comes first, because it
 * frames everything below it; then what to do about it; then the document's own facts and
 * the text it was read from, so the reader can check the extraction before trusting any
 * comparison built on it; then the candidates. A reviewer who reads top to bottom has
 * seen the evidence before they see a button.
 */

export interface FocusedDocumentData {
  id: number;
  source: string;
  merchantName: string | null;
  totalAmount: number | null;
  currency: string | null;
  documentDate: Date | null;
  cardLast4: string | null;
  vatNumber: string | null;
  rawText: string | null;
  failureReason: string | null;
  receivedAt: Date;
  senderLabel: string | null;
}

export function FocusedDocument({
  document,
  candidates,
}: {
  document: FocusedDocumentData;
  candidates: CandidateCharge[];
}) {
  const reason = document.failureReason;
  const ambiguous = reason === 'AMBIGUOUS_TOP_CANDIDATES';
  const charges: ComparableCharge[] = candidates.map((c) => ({
    merchantName: c.merchantName,
    amount: c.amount,
    currency: c.currency,
    transactionAt: c.transactionAt,
    cardLast4: c.cardLast4,
  }));

  return (
    // `min-w-0` is load-bearing: this is a grid item, and a `1fr` track defaults to
    // `min-width: auto` — the intrinsic width of its widest content. The monospace
    // receipt block below therefore pushed the whole column past the viewport and the
    // page scrolled sideways on a phone. Without this, no amount of wrapping inside the
    // children fixes it.
    <article className="min-w-0">
      <header>
        <h2 className="text-xl font-semibold tracking-tight">
          {document.merchantName ?? 'Unreadable receipt'}
        </h2>

        <p className="mt-1 text-sm text-muted-foreground tabular-nums">
          {formatMinorUnits(document.totalAmount, document.currency ?? 'SAR')} ·{' '}
          {formatDay(document.documentDate)} ·{' '}
          {document.cardLast4 ? `card ••••${document.cardLast4}` : 'no card number read'}
        </p>

        <p className="mt-0.5 text-xs text-muted-foreground">
          {SOURCE_LABEL[document.source] ?? document.source}
          {document.senderLabel ? ` · ${document.senderLabel}` : ''} · received{' '}
          {formatDay(document.receivedAt)}
        </p>

        {/* The field that decides whether this document is usable for a VAT filing at
            all. Stated as an observation about the document; whether that makes the tax
            recoverable is a question for the operator's accountant, not for this UI. */}
        <p className="mt-0.5 text-xs text-muted-foreground">
          {document.vatNumber
            ? `VAT number ${document.vatNumber}`
            : 'No VAT number on this document'}
        </p>
      </header>

      {reason ? (
        <section className="mt-4 border-l-2 border-amber-400 pl-3">
          <p className="text-sm font-medium">{REASON_COPY[reason] ?? reason}</p>
          {NEXT_STEP_COPY[reason] ? (
            <p className="mt-1 text-sm text-muted-foreground">{NEXT_STEP_COPY[reason]}</p>
          ) : null}
        </section>
      ) : null}

      <RawTextPanel text={document.rawText} source={document.source} />

      {ambiguous ? <AmbiguityCallout charges={charges} /> : null}

      <section className="mt-6">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {candidates.length === 1 ? 'The charge it would attach to' : 'Which charge is this?'}
        </h3>

        {candidates.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            Every candidate has been decided. This document leaves the queue on refresh.
          </p>
        ) : (
          <div className="mt-3 space-y-6">
            {candidates.map((candidate, index) => (
              <CandidateCard
                key={candidate.matchId}
                candidate={candidate}
                document={document}
                rank={index + 1}
                // Rank emphasis is suppressed exactly where the engine declined to rank:
                // on an ambiguous document a "1" would be the interface asserting a
                // preference the matcher explicitly refused to express.
                showRank={!ambiguous}
                documentId={document.id}
              />
            ))}
          </div>
        )}
      </section>
    </article>
  );
}
