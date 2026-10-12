import { cn } from '@/lib/utils';
import { presentStatus, STANCE_TONE } from '@/lib/ui/vocabulary';

/**
 * A document's state, in one word a reader can act on.
 *
 * The only place in the UI where a status becomes a colour, so the palette cannot drift
 * between screens the way three separate tone maps did. The word always appears: colour
 * is a second channel for people who read quickly, never the only one.
 */
export function StatusPill({ status, className }: { status: string; className?: string }) {
  const { label, hint, stance } = presentStatus(status);

  return (
    <span
      title={hint}
      className={cn(
        'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs ring-1 ring-inset',
        STANCE_TONE[stance],
        className,
      )}
    >
      {label}
    </span>
  );
}
