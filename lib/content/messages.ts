/**
 * Every sentence this capability shows a person.
 *
 * Copy written inline in JSX has three costs that only appear later. Changing a wording
 * means finding every component that happens to contain it. A host mounting the module
 * cannot adapt a single phrase to their own vocabulary without forking it. And the product
 * cannot be translated at all — which for a Saudi VAT product is not a future nicety:
 * Arabic is the language the people doing this work read receipts in.
 *
 * So the strings live here, keyed, with named interpolation. Components ask for a key and
 * never contain a sentence. That makes the wording reviewable in one file, overridable by
 * the host, and translatable by adding a second catalogue rather than by editing views.
 *
 * Deliberately not a dependency. A full i18n library brings locale negotiation, plural
 * rule tables, date and currency formatting and a runtime — all of which this already has
 * or does not need, and none of which is worth a package for one locale. The shape below
 * is the part that matters, and `t()` is small enough to read in a minute.
 */

/**
 * The default catalogue. Keys are `area.thing`, values are templates.
 *
 * `{name}` placeholders are substituted from the params object. A template with no
 * placeholder is a plain string; a value that varies with a count uses `|` to separate
 * the singular form from the plural.
 */
export const DEFAULT_MESSAGES = {
  /* ---- shell ------------------------------------------------------------ */
  'nav.overview': 'Overview',
  'nav.review': 'Review',
  'nav.assurance': 'Assurance',
  'nav.charges': 'Charges',
  'nav.documents': 'Documents',
  'nav.exceptions': 'Exceptions',
  'nav.actingAs': 'Acting as',

  /* ---- overview --------------------------------------------------------- */
  'overview.period.all': 'All charges',
  'overview.noCharges.title': 'No charges loaded yet',
  'overview.noCharges.body': 'Card transactions arrive through POST /api/transactions.',
  'overview.allCovered': 'Every charge has a receipt',
  'overview.unsupported': '{amount} has no receipt',
  'overview.supporting':
    '{undocumented} of {total} charges · {coverage} of spend is covered · {vat} of input VAT cannot be reclaimed without them',
  'overview.stale':
    'This is the most recent month with charges. Nothing has posted in {gap}.',
  'overview.desk.review': '{count} document needs a decision|{count} documents need a decision',
  'overview.desk.assurance':
    '{count} attachment needs sign-off|{count} attachments need sign-off',
  'overview.desk.exceptions': '{count} exception|{count} exceptions',
  'overview.spend.title': 'Where the period’s spend sits',
  'overview.spend.hint': 'By value, not by count — one large charge outweighs ten small ones.',
  'overview.ageing.title': 'How long the gap has been open',
  'overview.ageing.hint': 'Undocumented charges only, by age.',
  'overview.automation.title': 'Automation',
  'overview.automation.body':
    '{attached} of {processed} documents attached without a person — {rate}.',
  'overview.automation.oldest': 'The longest-waiting document has been in the queue {age}.',
  'overview.automation.note':
    'A sustained fall in this rate usually means an acquirer changed how it writes merchant names — the queue fills before coverage moves.',

  /* ---- review ----------------------------------------------------------- */
  'review.title': 'Review queue',
  'review.subtitle':
    'One document the matcher would not decide on its own.|{count} documents the matcher would not decide on its own.',
  'review.empty.title': 'Nothing waiting for you',
  'review.empty.body':
    'Every document either attached itself to a charge or is still waiting for one to post. Nothing here needs a decision.',
  'review.empty.action': 'Back to the overview',
  'review.denied.title': 'This queue is not yours',
  'review.denied.body':
    'Attaching a receipt to a charge needs the decide permission, which the host application grants.',
  'review.denied.action': 'Go to your queue',
  'review.queue.heading': 'Waiting · {count}',
  'review.candidates.one': 'The charge it would attach to',
  'review.candidates.many': 'Which charge is this?',
  'review.candidates.none':
    'Every candidate has been decided. This document leaves the queue on refresh.',
  'review.attach': 'Attach to {charge}',
  'review.attach.short': 'Attach',
  'review.reject': 'Not this one',
  'review.blocked':
    'That charge already has a receipt attached. Reject that one first if this is the correct receipt for it.',
  'review.vat.present': 'VAT number {number}',
  'review.vat.absent': 'No VAT number on this document',
  'review.rawText.whatsapp': 'What the driver sent',
  'review.rawText.email': 'What the supplier sent',
  'review.engine.summary': 'How the engine scored this',

  /* ---- ambiguity -------------------------------------------------------- */
  'ambiguity.title': 'These charges are equally good matches',
  'ambiguity.differs':
    'Everything the receipt can be compared on is identical. They differ only in {fields} — check the paper receipt for that, not the figures below.',
  'ambiguity.identical':
    'Nothing in either charge separates them. The receipt cannot decide this — rejecting both and asking the driver which purchase it was is safer than guessing.',

  /* ---- comparison phrases ----------------------------------------------- */
  'compare.receipt': 'Receipt',
  'compare.charge': 'Charge',
  'compare.notOnReceipt': 'not on receipt',
  'compare.field.amount': 'Amount',
  'compare.field.card': 'Card',
  'compare.field.merchant': 'Merchant',
  'compare.field.date': 'Date',
  'compare.differs.branch': 'the branch',
  'compare.differs.merchant': 'the merchant',
  'compare.differs.amount': 'the amount',
  'compare.differs.card': 'the card',
  'compare.differs.time': 'the time of day',
  'compare.differs.date': 'the date',

  /* ---- assurance -------------------------------------------------------- */
  'assurance.title': 'Assurance',
  'assurance.subtitle':
    '{count} attachment needs an independent sign-off, largest first.|{count} attachments need an independent sign-off, largest first.',
  'assurance.mine.none': 'None of them are yours, so you may sign off any.',
  'assurance.mine.some': '{count} is your own and must go to a colleague.|{count} are your own and must go to a colleague.',
  'assurance.empty.title': 'All clear',
  'assurance.empty.body':
    'Every attachment selected for review has been signed off. New ones appear here when they are above {threshold}, attached automatically, or drawn by sampling.',
  'assurance.denied.title': 'You cannot sign off attachments',
  'assurance.denied.body': 'This queue needs the verify permission, which the host application grants.',
  'assurance.off.title': 'Independent sign-off is switched off',
  'assurance.off.body':
    'Attachments stand on the decision of whoever made them. Set DARB_MAKER_CHECKER to POST_HOC and new attachments will be selected for review by value and by sampling.',
  'assurance.automatic': 'Attached automatically — no person has seen this',
  'assurance.attachedBy': 'Attached by {who}',
  'assurance.signOff': 'Sign off',
  'assurance.overturn': 'Not right',
  'assurance.overturn.prompt': 'Why is this attachment wrong?',
  'assurance.overturn.confirm': 'Detach it',
  'assurance.policy':
    'Selected by value above {threshold}, by automatic attachment, and by {rate} sampling of everything else — so “small” does not become a blind spot.',
  'assurance.segregation':
    'A reviewer attaches receipts; a controller does that and signs off other people’s attachments. Nobody signs off their own, whichever role they hold — that rule is per attachment, not per person, which is why your own work appears here greyed rather than hidden.',

  /* ---- charges ---------------------------------------------------------- */
  'charges.title': 'Charges',
  'charges.subtitle': 'Every card charge and whether a receipt supports it.',
  'charges.count': '{count} charge · {value}|{count} charges · {value}',
  'charges.filtered': ' matching this filter',
  'charges.all': ' in total',
  'charges.empty.title': 'Nothing matches this filter',
  'charges.empty.body': 'Try a different status, or clear the search.',
  'charges.empty.action': 'Show all charges',
  'charges.search.placeholder': 'Merchant or card',
  'charges.search.submit': 'Search',
  'charges.truncated': 'Showing the first {shown} of {total}. Narrow the filter to see the rest.',
  'charges.derivedNote':
    'Status is derived from the charge’s confirmed document, not stored — so it cannot drift from the attachment it describes.',

  /* ---- documents -------------------------------------------------------- */
  'documents.title': 'Documents',
  'documents.subtitle': 'Everything WhatsApp and email delivered, whatever became of it.',
  'documents.empty.title': 'No documents match',
  'documents.empty.body': 'Try a different status, or clear the search.',
  'documents.empty.action': 'Show everything',
  'documents.search.placeholder': 'Merchant, sender or VAT no.',
  'documents.attached': 'attached to a charge',

  /* ---- exceptions ------------------------------------------------------- */
  'exceptions.title': 'Exceptions',
  'exceptions.subtitle':
    '{count} document is stuck in a way that waiting will not resolve.|{count} documents are stuck in a way that waiting will not resolve.',
  'exceptions.none': 'Nothing is stuck.',
  'exceptions.empty.title': 'Nothing stuck',
  'exceptions.empty.body':
    'Every document either attached itself, is waiting on a charge to post, or is in the review queue.',
  'exceptions.decide': 'Decide these in the review queue',

  /* ---- charge detail ---------------------------------------------------- */
  'charge.back': 'All charges',
  'charge.fact.amount': 'Amount',
  'charge.fact.charged': 'Charged',
  'charge.fact.card': 'Card',
  'charge.fact.driver': 'Driver',
  'charge.fact.noDriver': 'Pool card — no driver',
  'charge.receipt': 'Receipt',
  'charge.noReceipt.title': 'No receipt attached',
  'charge.noReceipt.proposed':
    'A receipt has been proposed for this charge and is waiting on a decision.',
  'charge.noReceipt.none':
    'Nothing has been proposed for this charge. It needs a receipt before the filing.',
  'charge.noReceipt.action': 'Open the review queue',
  'charge.considered.title': 'Everything considered',
  'charge.considered.hint':
    'Every document the matcher scored against this charge, and what became of it.',
  'charge.rejectedNote':
    'A rejected pairing is permanent — the matcher will not propose it again, though the document stays open to other charges.',
  'charge.history.title': 'History',
  'charge.history.hint': 'Every decision taken about the attached receipt, in order.',
} as const;

export type MessageKey = keyof typeof DEFAULT_MESSAGES;
export type MessageCatalogue = Partial<Record<MessageKey, string>>;

export type MessageParams = Record<string, string | number>;

let overrides: MessageCatalogue = {};

/**
 * Lets a host replace any phrase without forking the module, and is also how a second
 * language is supplied: a full catalogue is just an override of every key.
 */
export function configureMessages(catalogue: MessageCatalogue): void {
  overrides = { ...overrides, ...catalogue };
}

export function resetMessages(): void {
  overrides = {};
}

/**
 * Looks up a message and fills its placeholders.
 *
 * `count` additionally selects between the two halves of a `singular|plural` template.
 * The rule is deliberately English-shaped; a language with richer plural categories would
 * supply its own selector alongside its catalogue, which is the point at which a real
 * i18n library starts to earn its place.
 *
 * An unknown key returns the key itself rather than throwing or rendering blank. A missing
 * string is a copy bug, and a visible `overview.unsupported` in the interface reports it
 * immediately, where an empty space or a crash would not.
 */
export function t(key: MessageKey, params: MessageParams = {}): string {
  const template = overrides[key] ?? DEFAULT_MESSAGES[key];
  if (template === undefined) return key;

  const forms = template.split('|');
  const chosen =
    forms.length > 1 && params.count !== undefined
      ? Number(params.count) === 1
        ? forms[0]
        : forms[1]
      : forms[0];

  return chosen.replace(/\{(\w+)\}/g, (whole, name: string) =>
    params[name] === undefined ? whole : String(params[name]),
  );
}
