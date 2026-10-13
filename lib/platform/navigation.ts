import { t } from '@/lib/content/messages';
import type { Actor, Capability } from '@/lib/platform/identity';
import { can } from '@/lib/platform/identity';
import { modulePath } from '@/lib/platform/module-config';

/**
 * The module's own navigation.
 *
 * Declared as data rather than written into a component so that two things stay true:
 * a host mounting the capability at a different base path gets correct links for free,
 * and an actor without a capability never sees the destination rather than reaching it
 * and being refused. The second is worth stating — hiding a link is a courtesy, and the
 * server actions check permission independently, but a navigation that offers work a
 * person cannot do is a navigation that wastes their time every day.
 */

export interface NavItem {
  label: string;
  href: string;
  /** Hidden from actors lacking this. Undefined means everyone who can see the module. */
  requires?: Capability;
  /** Which badge count, if any, belongs beside it. */
  badge?: 'review' | 'assurance';
  /** One line, for a title attribute and for the mobile menu. */
  hint: string;
}

/** A nav row before its href is resolved against the host's mount point. */
interface NavEntry extends Omit<NavItem, 'href'> {
  /** Path below the module root; `undefined` is the root itself. */
  segment: string | undefined;
}

const NAV_ITEMS: readonly NavEntry[] = [
  {
    label: 'Overview',
    segment: undefined,
    hint: t('nav.overview.hint'),
  },
  {
    label: 'Review',
    segment: 'review',
    requires: 'decide',
    badge: 'review',
    hint: t('nav.review.hint'),
  },
  {
    label: 'Assurance',
    segment: 'assurance',
    requires: 'verify',
    // Both queues appear for anyone who works them. Hiding Assurance from a person who
    // attaches receipts implied the two are different jobs; they are the same job, and the
    // only thing they may not do is sign off their own attachment.
    badge: 'assurance',
    hint: t('nav.assurance.hint'),
  },
  {
    label: 'Charges',
    segment: 'transactions',
    hint: t('nav.charges.hint'),
  },
  {
    label: 'Documents',
    segment: 'documents',
    hint: t('nav.documents.hint'),
  },
];

export function visibleNavItems(actor: Actor): NavItem[] {
  // The table below stores a path *segment*, not a finished href, and `modulePath` is
  // called here — once per invocation, against live configuration.
  //
  // It used to store the finished href and "rebuild" it with `{ ...item, href: item.href }`,
  // which copies a string computed at module-import time. `moduleConfig()` memoises on
  // first read, so importing this file before the host called `configureModule` froze the
  // base path permanently. The map read as a fix and was dead work.
  return NAV_ITEMS.filter((item) => item.requires === undefined || can(actor, item.requires)).map(
    ({ segment, ...item }) => ({
      ...item,
      href: segment === undefined ? modulePath() : modulePath(segment),
    }),
  );
}

/**
 * Whether a nav item is the one currently being viewed.
 *
 * Exact match for the module root, prefix match for everything else, so a detail page
 * keeps its section highlighted. Without the root special case, `/vat` would light up on
 * every page in the module.
 */
export function isCurrent(itemHref: string, pathname: string): boolean {
  const root = modulePath();
  if (itemHref === root) return pathname === root || pathname === `${root}/`;
  return pathname === itemHref || pathname.startsWith(`${itemHref}/`);
}
