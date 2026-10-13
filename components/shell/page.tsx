import Link from 'next/link';
import { cn } from '@/lib/utils';

/**
 * The page shell every screen in this capability uses.
 *
 * It exists because the alternative was proven not to work: five screens each hand-rolled
 * their own header and picked their own container width, and the result reads as five
 * products rather than one. Consistency of this kind is not achievable by intention — a
 * sixth screen written next week will pick a sixth width — so it is achieved by there
 * being one component and no reason to write another.
 *
 * Everything optional is genuinely optional, so a screen uses exactly the parts it needs
 * and still lands in the same place as every other screen.
 */

export function Page({
  children,
  /** Registers and tables earn the extra width; reading screens do not. */
  width = 'default',
}: {
  children: React.ReactNode;
  width?: 'default' | 'wide';
}) {
  // One width, one rhythm, everywhere. 72rem is wide enough for a register with six
  // columns and narrow enough that a line of prose stays readable.
  return (
    <main
      className={cn(
        'mx-auto w-full px-4 py-8 sm:px-6 lg:px-8',
        width === 'wide' ? 'max-w-[90rem]' : 'max-w-6xl',
      )}
    >
      {children}
    </main>
  );
}

export function PageHeader({
  title,
  description,
  /** The one thing this screen most wants the reader to do. */
  action,
  /** Where this screen came from, when it is a detail view. */
  back,
  /** Secondary facts about the subject — counts, totals, status. */
  meta,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  back?: { href: string; label: string };
  meta?: React.ReactNode;
}) {
  return (
    <header className="mb-6 sm:mb-8">
      {back ? (
        <Link
          href={back.href}
          className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span aria-hidden>←</span> {back.label}
        </Link>
      ) : null}

      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          {/* Large enough to actually lead the page. The old 20px sat barely above body
              text, so no screen had a visible top of its hierarchy. */}
          <h1 className="text-2xl font-semibold tracking-[-0.011em]">{title}</h1>
          {description ? (
            <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted-foreground">
              {description}
            </p>
          ) : null}
          {meta ? <div className="mt-3">{meta}</div> : null}
        </div>

        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
    </header>
  );
}

/**
 * A titled block within a page.
 *
 * Sections carry the vertical rhythm so individual screens stop choosing their own
 * margins — the spacing between two blocks should not depend on which file they are in.
 */
export function Section({
  title,
  description,
  action,
  children,
  className,
}: {
  title?: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    // Sections are separated by a real gap, not a hairline. Two blocks 32px apart with
    // headings of their own read as two things; the same blocks 12px apart read as one.
    <section className={cn('mt-10 first:mt-0', className)}>
      {title ? (
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <div>
            <h2 className="text-base font-semibold tracking-[-0.006em]">{title}</h2>
            {description ? (
              <p className="mt-1 text-sm text-muted-foreground">{description}</p>
            ) : null}
          </div>
          {action ? <div className="shrink-0 text-sm">{action}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/**
 * What a screen shows instead of nothing.
 *
 * Every empty state here says three things: what is absent, why that is so, and the one
 * thing to do about it. An empty table with a heading above it is the single clearest
 * signal that a product is unfinished, and this is the component that makes writing one
 * harder than writing a real answer.
 */
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border bg-card px-6 py-16 text-center shadow-xs">
      <p className="text-base font-medium">{title}</p>
      <p className="mx-auto mt-1.5 max-w-md text-sm leading-relaxed text-muted-foreground">
        {description}
      </p>
      {action ? <div className="mt-5 flex justify-center">{action}</div> : null}
    </div>
  );
}

/**
 * A row of facts about the subject of a detail page.
 *
 * Label above value, wrapping in a grid, because detail pages otherwise drift into prose
 * paragraphs where a reader has to hunt for the one figure they came for.
 */
export function FactGrid({
  facts,
}: {
  facts: { label: string; value: React.ReactNode }[];
}) {
  return (
    <dl className="grid gap-px overflow-hidden rounded-xl border bg-border shadow-xs sm:grid-cols-2 lg:grid-cols-4">
      {facts.map((fact) => (
        <div key={fact.label} className="bg-card px-4 py-3">
          <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {fact.label}
          </dt>
          <dd className="mt-1 text-sm tabular-nums">{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}
