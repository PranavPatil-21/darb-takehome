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
  'nav.actingAs': 'Acting as',
  'nav.overview.hint': 'Coverage, exposure and what needs attention',
  'nav.review.hint': 'Documents the matcher would not decide on its own',
  'nav.assurance.hint': 'Attachments awaiting an independent sign-off',
  'nav.charges.hint': 'Every card charge and its documentation status',
  'nav.documents.hint': 'Everything WhatsApp and email delivered',

  // Why an attachment was, or was not, selected for sign-off.
  'verify.off': 'Independent sign-off is not enabled.',
  'verify.material': 'Above the materiality threshold.',
  'verify.automatic': 'Attached automatically — no person has seen this yet.',
  'verify.sampled': 'Selected by routine sampling.',
  'verify.notRequired': 'Below the threshold and not sampled.',
  'verify.ownWork': 'You attached this. Someone else has to sign it off.',
  'trigger.MATERIAL': 'Material value',
  'trigger.AUTOMATIC': 'Automatic match',
  'trigger.SAMPLED': 'Sampled',
  'trigger.NOT_REQUIRED': 'Not required',

  // Notes beside a compared field, when the difference needs explaining.
  'compare.note.currencyMismatch':
    'The receipt and the charge are in different currencies — these are not the same payment.',
  'compare.note.noAmount': 'No total could be read from this document.',
  'compare.note.rounding': 'Differs by a few halalas — VAT rounding.',
  'compare.note.noDate': 'No date could be read from this document.',
  'compare.note.noCard': 'No card number printed on this document.',
  'compare.note.otherCard': 'Different card. This receipt belongs to another charge.',
  'compare.note.noMerchant': 'No merchant name could be read from this document.',
  'compare.note.acquirer': 'Acquirer names are abbreviated and carry branch codes.',

  // What comes back from a decision.
  'result.denied.decide': 'You do not have permission to decide matches',
  'result.denied.verify': 'You do not have permission to sign off attachments',
  'result.alreadyRejected': 'This candidate was already rejected.',
  'result.alreadyDecided': 'Another reviewer decided this one a moment ago.',
  'result.noneLeft': 'Rejected. No candidates left — the document is back in the unmatched pool.',
  'result.alreadySignedOff': 'Already signed off.',
  'result.signedOff': 'Signed off.',
  'result.alreadyRemoved': 'This attachment was already removed by someone else. Refresh to see the queue.',
  'result.detached': 'Detached. The charge is free for the correct receipt.',
  'result.reasonTooShort': 'Say why this attachment is wrong',

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
  'overview.desk.blocked':
    '{count} document needs more than a decision|{count} documents need more than a decision',
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
  /*
   * Counts the two kinds separately. "Documents the matcher would not decide" described
   * the queue accurately while it held only NEEDS_REVIEW; now that it also holds things
   * no decision can settle, one number would flatter the first figure and misdescribe
   * the second.
   */
  'review.subtitle': 'One document is waiting.|{count} documents are waiting.',
  /* Two keys rather than one, because `t` pluralises on `count` and this sentence has
     two independent counts to agree with. */
  'review.subtitle.decidable': '{count} needs a decision|{count} need a decision',
  'review.subtitle.blocked': '{count} needs something else|{count} need something else',
  'review.emptyFiltered.title': 'Nothing left of this kind',
  'review.emptyFiltered.body':
    'You have cleared every document in this group. {count} others are still waiting under the other kinds.',
  'review.empty.title': 'Nothing waiting for you',
  'review.empty.body':
    'Every document either attached itself to a charge or is still waiting for one to post. Nothing here needs a decision.',
  'review.empty.action': 'Back to the overview',
  'review.denied.title': 'This queue is not yours',
  'review.denied.body':
    'Attaching a receipt to a charge needs the decide permission, which the host application grants.',
  'review.denied.action': 'Go to your queue',
  'review.queue.heading': 'Waiting · {count}',
  'review.queue.aria': 'Documents waiting for review',
  'review.candidates.one': 'The charge it would attach to',
  'review.candidates.many': 'Which charge is this?',
  /* No charge is in play and none can be picked — so the heading does not ask. */
  'review.candidates.blocked': 'What to do with this one',
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
  'review.queue.waiting': 'Waiting',
  'review.blocked.title': 'Nothing to decide here',

  /* ---- ambiguity -------------------------------------------------------- */
  /*
   * Two headings, because "equally good" is a claim about the scores and is only true
   * when they actually tie. Saying it of a clear leader would overstate the difficulty
   * and invite a reviewer to toss a coin over a decision the engine had nearly made.
   */
  'ambiguity.title.tied':
    'This charge is an equally good match|{count} charges are equally good matches',
  'ambiguity.title.competing': 'Another charge is in the running|{count} charges are in the running',
  'ambiguity.differs.tied':
    'Everything the receipt can be compared on is identical. They differ only in {fields} — check the paper receipt for that, not the figures below.',
  'ambiguity.differs':
    'They differ in {fields}. Check that against the paper receipt before attaching.',
  'ambiguity.identical':
    'Nothing in these charges separates them. The receipt cannot decide this — rejecting them and asking the driver which purchase it was is safer than guessing.',

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
  'assurance.none': 'Nothing is waiting on a second pair of eyes.',
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
  'assurance.overturn.placeholder': 'The receipt is for the other Tamimi branch.',
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

  /* Why the trail is empty, said out loud. A section that vanishes when it has nothing
     reads as "nothing happened", which is a different claim and usually a false one. */
  'charge.history.none.unattached':
    'Nothing has been attached to this charge yet, so there is nothing to record.',
  'charge.history.none.automatic':
    'Attached by the matcher with no human step, and before the decision trail recorded automatic attachments. Anything done to it from now on appears here.',
  'charge.history.none.imported':
    'This attachment predates the decision trail — imported or seeded rather than decided in the queue. Anything done to it from now on appears here.',

  /* ---- sign-off state on a charge --------------------------------------- */
  'charge.signOff.notRequired': 'No independent sign-off required',
  'charge.signOff.pending': 'Waiting for independent sign-off',
  'charge.signOff.upheld': 'Signed off',
  'charge.signOff.overturned': 'Overturned on review',
  'charge.evidence.title': 'Why this was attached',
  'charge.evidence.automatic': 'Attached by the matcher without a human step.',
  'charge.evidence.human': 'Attached by a reviewer.',
  /* ---- why the matcher stopped --------------------------------------------
   * These were previously a separate table in lib/format.ts. They belong here for the
   * same reason as every other sentence: one place to review the wording, one mechanism
   * to override or translate it. */
  'reason.AMBIGUOUS_TOP_CANDIDATES':
    'Two transactions score almost identically — there is no evidence favouring either.',
  'reason.TRANSACTION_ALREADY_DOCUMENTED':
    'The best-matching transaction already has a confirmed document. Possible duplicate receipt.',
  'reason.LOW_EXTRACTION_CONFIDENCE':
    'The signals agree, but the OCR distrusted its own read of this document.',
  'reason.WEAK_EVIDENCE':
    'No amount and no card number could be read — merchant and date alone cannot attach money.',
  'reason.MID_CONFIDENCE': 'Plausible but short of the auto-match threshold.',
  'reason.UNEXPLAINED_AMOUNT_GAP':
    'The receipt total and the charge do not agree, and the difference is more than VAT rounding.',
  'reason.NO_PLAUSIBLE_CANDIDATE':
    'No transaction in scope came close enough to be worth reviewing.',
  'reason.NO_CANDIDATE_TRANSACTIONS':
    'No transactions exist in this document’s scope and date window.',
  'reason.UNUSABLE_EXTRACTION': 'OCR returned nothing usable — no amount, no card, no merchant.',
  'reason.ALL_CANDIDATES_REJECTED': 'Every candidate was rejected by a reviewer.',
  'reason.CONFIDENT_SINGLE_CANDIDATE': 'One clear winner, well clear of the runner-up.',

  /* ---- what to do about it ------------------------------------------------ */
  'nextStep.AMBIGUOUS_TOP_CANDIDATES':
    'Check the paper receipt for the branch or the time, or ask the driver which purchase this was.',
  'nextStep.TRANSACTION_ALREADY_DOCUMENTED':
    'Compare this against the receipt already attached. Only one of them belongs to that charge.',
  'nextStep.LOW_EXTRACTION_CONFIDENCE':
    'Read the amount and card number off the receipt below and check they match the charge.',
  'nextStep.WEAK_EVIDENCE':
    'The receipt shows no total and no card number. Confirm only if you can tell from the receipt itself which charge this is.',
  'nextStep.MID_CONFIDENCE': 'Check the difference flagged below, then attach it or reject it.',
  'nextStep.UNEXPLAINED_AMOUNT_GAP':
    'Usually a tip or a service charge. Confirm the receipt covers this charge; if the gap is not explained, reject it.',

  /* ---- document status, in the reader's words ----------------------------- */
  'docStatus.MATCHED': 'Attached',
  'docStatus.MATCHED.hint': 'Attached to a charge.',
  'docStatus.NEEDS_REVIEW': 'Needs you',
  'docStatus.NEEDS_REVIEW.hint': 'The matcher would not decide this on its own.',
  'docStatus.UNMATCHED': 'No charge yet',
  'docStatus.UNMATCHED.hint':
    'No charge to attach this to — it retries automatically when one posts.',
  'docStatus.FAILED': 'Couldn’t read',
  'docStatus.FAILED.hint': 'Nothing usable came out of this document.',
  'docStatus.RECEIVED': 'Processing',
  'docStatus.RECEIVED.hint': 'Still being read.',
  'docStatus.EXTRACTED': 'Processing',
  'docStatus.EXTRACTED.hint': 'Read, now being matched.',

  /* ---- charge documentation status ---------------------------------------- */
  'chargeStatus.DOCUMENTED': 'Documented',
  'chargeStatus.DOCUMENTED.hint': 'A receipt is attached to this charge.',
  'chargeStatus.IN_REVIEW': 'In review',
  'chargeStatus.IN_REVIEW.hint': 'A receipt has been proposed and is waiting on a decision.',
  'chargeStatus.REJECTED': 'Receipt rejected',
  'chargeStatus.REJECTED.hint':
    'Every receipt proposed for this charge was rejected. It still needs one.',
  'chargeStatus.MISSING': 'No receipt',
  'chargeStatus.MISSING.hint': 'Nothing has been proposed for this charge yet.',
  'chargeStatus.awaitingSignOff': '· sign-off due',
  'chargeStatus.awaitingSignOff.hint':
    'Attached, but still waiting on an independent sign-off',

  /* ---- ageing bands ------------------------------------------------------- */
  'age.0-7': 'Up to a week',
  'age.8-30': '1 to 4 weeks',
  'age.31-60': '1 to 2 months',
  'age.60+': 'Over 2 months',

  /* ---- work-queue kinds --------------------------------------------------- */
  /*
   * Three strings per kind: what the group is called, why these documents are in it, and
   * what the person should actually do. The third is the one that matters — a queue that
   * names a problem without naming its remedy is a list of complaints.
   */
  'work.CHOOSE_CHARGE': 'Pick the right charge',
  'work.CHOOSE_CHARGE.why':
    'Several charges fit this receipt equally well, so the matcher refused to guess.',
  'work.CHOOSE_CHARGE.next':
    'Compare what separates them — usually the branch or the time of day — against the paper receipt.',

  'work.CHECK_FIGURES': 'Check the figures',
  'work.CHECK_FIGURES.why':
    'One charge leads, but not clearly enough to attach it to money without a person looking.',
  'work.CHECK_FIGURES.next': 'Read the amount and card number off the receipt and confirm they match.',

  'work.WEAK_EVIDENCE': 'Not enough was read',
  'work.WEAK_EVIDENCE.why':
    'The merchant and the date agree, and nothing else could be read from the document.',
  'work.WEAK_EVIDENCE.next':
    'A merchant and a date are not enough on their own — check the total against the charge before attaching.',

  'work.POSSIBLE_DUPLICATE': 'Possible duplicate',
  'work.POSSIBLE_DUPLICATE.why': 'The best-matching charge already has a receipt attached.',
  'work.POSSIBLE_DUPLICATE.next':
    'One of the two is wrong. Reject the existing attachment first if this document is the correct one.',

  'work.NO_CHARGE_FOUND': 'No matching charge',
  'work.NO_CHARGE_FOUND.why':
    'Nothing in the window is a plausible match — often because the charge has not posted yet.',
  'work.NO_CHARGE_FOUND.next':
    'No action needed yet. These are re-matched automatically as charges arrive; chase the acquirer if one stays here for weeks.',

  'work.UNREADABLE': 'Could not be read',
  'work.UNREADABLE.why': 'Nothing usable came out of the document.',
  'work.UNREADABLE.next': 'Ask the driver to send a clearer photo. Nothing here can be attached as it stands.',

  'work.SENDER_UNKNOWN': 'Sender not registered',
  'work.SENDER_UNKNOWN.why':
    'Nobody has registered this sender, so the document cannot be scoped to a client.',
  'work.SENDER_UNKNOWN.next':
    'Register the sender. The document is matched automatically once it can be scoped.',

  /* ---- audit actions ------------------------------------------------------ */
  'audit.AUTO_MATCHED': 'Attached automatically by the matcher',
  'audit.CONFIRMED': 'Attached by',
  'audit.REJECTED': 'Rejected by',
  'audit.VERIFIED': 'Signed off by',
  'audit.OVERTURNED': 'Sent back by',

  /* ---- signals ------------------------------------------------------------ */
  'signal.na': 'n/a',
  'signal.na.hint': 'This signal was not present on the document',
  'signal.amount': 'Amount',
  'signal.cardLast4': 'Card ••••',
  'signal.merchant': 'Merchant',
  'signal.date': 'Date',

  /* ---- sources and roles -------------------------------------------------- */
  'source.WHATSAPP': 'WhatsApp',
  'source.EMAIL': 'Email',
  'role.reviewer': 'Attaches receipts to charges. Cannot sign off attachments.',
  'role.controller':
    'Attaches receipts, signs off other people’s attachments, and sets thresholds.',

  /* ---- misc --------------------------------------------------------------- */
  'app.title': 'Darb · document matching',
  'app.description':
    'Receipts and invoices arrive by WhatsApp and email, are extracted by OCR, and are matched to card transactions with an explainable confidence score.',
  'common.unreadableDocument': 'Unreadable document',
  'common.unreadableReceipt': 'Unreadable receipt',
  'common.unreadableMerchant': 'Unreadable merchant',
  'common.noCardRead': 'no card number read',
  'common.showAll': 'Show everything',
  'common.all': 'All',
  'common.clear': 'Clear',
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

  // A pluralised key with no forms is a content bug, not a runtime one: fall back to the
  // raw key so the screen still renders and the gap is visible.
  if (chosen === undefined) return key;

  return chosen.replace(/\{(\w+)\}/g, (whole, name: string) =>
    params[name] === undefined ? whole : String(params[name]),
  );
}

/**
 * Lookups whose key is built from a runtime value.
 *
 * `t()` keeps its exact-key type so a typo in a literal is a compile error. These wrap the
 * cases where the key genuinely comes from data — a matcher reason, a status, an ageing
 * band — and fall back to the raw code when the catalogue has no entry, so an unmapped
 * value surfaces as itself rather than as a blank.
 */
const lookup = (prefix: string, code: string, fallback?: string): string => {
  const key = `${prefix}.${code}` as MessageKey;
  const value = overrides[key] ?? DEFAULT_MESSAGES[key];
  return value ?? fallback ?? code;
};

export const reasonText = (code: string) => lookup('reason', code);
export const nextStepText = (code: string) => lookup('nextStep', code, '');
export const docStatusLabel = (code: string) => lookup('docStatus', code);
export const docStatusHint = (code: string) => lookup(`docStatus`, `${code}.hint`, '');
export const chargeStatusLabel = (code: string) => lookup('chargeStatus', code);
export const chargeStatusHint = (code: string) => lookup('chargeStatus', `${code}.hint`, '');
export const ageLabel = (code: string) => lookup('age', code);
export const workKindLabel = (code: string) => lookup('work', code);
export const workKindWhy = (code: string) => lookup('work', `${code}.why`, '');
export const workKindNextStep = (code: string) => lookup('work', `${code}.next`, '');
export const auditText = (code: string) => lookup('audit', code);
export const signalLabel = (code: string) => lookup('signal', code);
export const sourceLabel = (code: string) => lookup('source', code);
export const roleSummary = (code: string) => lookup('role', code, '');
