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
  badge?: 'review' | 'assurance' | 'exceptions';
  /** One line, for a title attribute and for the mobile menu. */
  hint: string;
}

export const NAV_ITEMS: readonly NavItem[] = [
  {
    label: 'Overview',
    href: modulePath(),
    hint: 'Coverage, exposure and what needs attention',
  },
  {
    label: 'Review',
    href: modulePath('review'),
    requires: 'decide',
    badge: 'review',
    hint: 'Documents the matcher would not decide on its own',
  },
  {
    label: 'Assurance',
    href: modulePath('assurance'),
    requires: 'verify',
    // Both queues appear for anyone who works them. Hiding Assurance from a person who
    // attaches receipts implied the two are different jobs; they are the same job, and the
    // only thing they may not do is sign off their own attachment.
    badge: 'assurance',
    hint: 'Attachments awaiting an independent sign-off',
  },
  {
    label: 'Charges',
    href: modulePath('transactions'),
    hint: 'Every card charge and its documentation status',
  },
  {
    label: 'Documents',
    href: modulePath('documents'),
    hint: 'Everything WhatsApp and email delivered',
  },
  {
    label: 'Exceptions',
    href: modulePath('exceptions'),
    badge: 'exceptions',
    hint: 'What the happy path could not place',
  },
];

export function visibleNavItems(actor: Actor): NavItem[] {
  // Rebuilt per call rather than memoised: `modulePath` reads live configuration, and a
  // module whose links were frozen at import time would point at the wrong base path for
  // any host that configured it after the module was first touched.
  return NAV_ITEMS.map((item) => ({ ...item, href: item.href })).filter(
    (item) => item.requires === undefined || can(actor, item.requires),
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
