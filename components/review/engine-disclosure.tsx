import { SignalBreakdownView } from '@/components/review/signal-breakdown';
import type { SignalBreakdown } from '@/lib/domain/enums';

/**
 * The matcher's own working, one click away.
 *
 * The per-signal scores are no longer the primary evidence — the field comparison above
 * is — but they are not deleted either. They are what makes a confidence number
 * accountable, and a reviewer who distrusts a verdict should be able to see exactly which
 * signal carried it. Collapsed by default because that question is occasional; present
 * always because a matching product that cannot show its working is asking for trust it
 * has not earned.
 */
export function EngineDisclosure({ signals }: { signals: SignalBreakdown }) {
  return (
    <details className="group mt-3">
      <summary className="cursor-pointer list-none text-xs text-muted-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm">
        How the engine scored this
        <span aria-hidden className="ml-1 inline-block transition-transform group-open:rotate-90">
          ›
        </span>
      </summary>
      <div className="mt-2 rounded-md bg-muted/40 p-3">
        <SignalBreakdownView signals={signals} />
      </div>
    </details>
  );
}
