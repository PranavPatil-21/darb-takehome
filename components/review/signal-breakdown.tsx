import { SIGNAL_COPY } from '@/lib/format';
import type { SignalBreakdown } from '@/lib/domain/enums';

const ORDER = ['amount', 'cardLast4', 'merchant', 'date'] as const;

function barColour(score: number): string {
  if (score >= 0.85) return 'bg-emerald-500';
  if (score >= 0.6) return 'bg-amber-500';
  return 'bg-rose-500';
}

/**
 * The per-signal breakdown behind a confidence score.
 *
 * This is the whole point of storing `signals` on the match row: a reviewer deciding
 * between two candidates needs to see *which* evidence differs, not just that one scored
 * 0.91 and the other 0.88. A null signal is rendered as "not on document" rather than as
 * a zero bar, because those mean very different things.
 */
export function SignalBreakdownView({ signals }: { signals: SignalBreakdown }) {
  return (
    <dl className="grid grid-cols-[7rem_1fr_3rem] items-center gap-x-3 gap-y-1.5 text-xs">
      {ORDER.map((key) => {
        const score = signals[key];
        return (
          <div key={key} className="contents">
            <dt className="text-muted-foreground">{SIGNAL_COPY[key] ?? key}</dt>
            <dd className="h-1.5 overflow-hidden rounded-full bg-muted">
              {score !== null && score !== undefined ? (
                <div
                  className={`h-full rounded-full ${barColour(score)}`}
                  style={{ width: `${Math.max(2, score * 100)}%` }}
                />
              ) : null}
            </dd>
            <dd className="text-right tabular-nums text-muted-foreground">
              {score === null || score === undefined ? (
                <span title="This signal was not present on the document">n/a</span>
              ) : (
                `${Math.round(score * 100)}%`
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
