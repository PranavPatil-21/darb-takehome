import { formatDay, formatMinorUnits } from '@/lib/format';
import { nextStepText, reasonText, t } from '@/lib/content/messages';
import { SOURCE_LABEL } from '@/lib/ui/vocabulary';
import type { ComparableCharge } from '@/lib/ui/comparison';
import { CandidateComparison } from '@/components/review/candidate-comparison';
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
  /** Drives the date verdict's window — an invoice is allowed to lag further than a receipt. */
  documentType: string | null;
  vatNumber: string | null;
  rawText: string | null;
  failureReason: string | null;
  receivedAt: Date;
  senderLabel: string | null;
}

export function FocusedDocument({
  document,
  candidates,
  decidable,
  nextStep,
}: {
  document: FocusedDocumentData;
  candidates: CandidateCharge[];
  /** Whether confirm/reject can settle this document at all. */
  decidable: boolean;
  /** What to do instead, when it cannot. */
  nextStep: string;
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
    <article className="min-w-0 space-y-4">
      {/* The document's own identity: one card, so the header stops floating against the
          page and reads as the subject of everything below it. */}
      <header className="rounded-xl border bg-card p-5 shadow-xs">
        <h2 className="text-xl font-semibold tracking-[-0.011em]">
          {document.merchantName ?? t('common.unreadableReceipt')}
        </h2>

        <p className="mt-1.5 text-sm tabular-nums">
          <span className="font-medium">
            {formatMinorUnits(document.totalAmount, document.currency ?? 'SAR')}
          </span>
          <span className="text-muted-foreground">
            {' · '}
            {formatDay(document.documentDate)}
            {' · '}
            {document.cardLast4 ? `card ••••${document.cardLast4}` : 'no card number read'}
          </span>
        </p>

        <dl className="mt-4 grid gap-x-6 gap-y-2 border-t pt-3 text-xs sm:grid-cols-3">
          <div>
            <dt className="text-muted-foreground">Arrived by</dt>
            <dd className="mt-0.5">
              {SOURCE_LABEL[document.source] ?? document.source}
              {document.senderLabel ? ` · ${document.senderLabel}` : ''}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Received</dt>
            <dd className="mt-0.5 tabular-nums">{formatDay(document.receivedAt)}</dd>
          </div>
          <div>
            {/* The field that decides whether this document is usable for a VAT filing at
                all. Stated as an observation about the document; whether that makes the
                tax recoverable is a question for the operator's accountant, not this UI. */}
            <dt className="text-muted-foreground">VAT number</dt>
            <dd className="mt-0.5 tabular-nums">
              {document.vatNumber ?? <span className="text-muted-foreground">Not printed</span>}
            </dd>
          </div>
        </dl>
      </header>

      {reason ? (
        <section className="rounded-xl border border-attention-border/60 bg-attention p-5 text-attention-foreground shadow-xs">
          <h3 className="text-sm font-semibold">{reasonText(reason)}</h3>
          {nextStepText(reason) ? (
            <p className="mt-1.5 text-sm leading-relaxed opacity-90">{nextStepText(reason)}</p>
          ) : null}
        </section>
      ) : null}

      <RawTextPanel text={document.rawText} source={document.source} />

      {/* Shown for any document with more than one charge in play, not only the ones the
          engine called ambiguous: "what is actually different between these?" is the same
          question whichever reason code brought the reviewer here. */}
      <CandidateComparison charges={charges} tied={ambiguous} />

      <section className="pt-2">
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t(
            !decidable
              ? 'review.candidates.blocked'
              : candidates.length === 1
                ? 'review.candidates.one'
                : 'review.candidates.many',
          )}
        </h3>

        {candidates.length === 0 ? (
          <p className="rounded-xl border border-dashed bg-card px-5 py-8 text-center text-sm leading-relaxed text-muted-foreground">
            {/* Two genuinely different situations. A decidable document with no candidates
                left has just been worked; an undecidable one never had any, and telling
                its reader to refresh would be an interface inventing progress. */}
            {decidable
              ? 'Every candidate has been decided. This document leaves the queue on refresh.'
              : nextStep}
          </p>
        ) : (
          <div className="space-y-4">
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
              />
            ))}
          </div>
        )}
      </section>
    </article>
  );
}
