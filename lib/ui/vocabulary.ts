import type { DocumentStatus } from '@/lib/domain/enums';

/**
 * The words an operator sees, as opposed to the words the pipeline uses.
 *
 * `DocumentStatus` has six values because the ingestion pipeline genuinely has six
 * states, and the engine needs all of them. A finance person does not: `RECEIVED` and
 * `EXTRACTED` are moments inside a single request that nobody will ever observe in a
 * list, and `FAILED` versus `UNMATCHED` is a distinction about *where* processing stopped,
 * not about what the reader should now do.
 *
 * Collapsing them here rather than at each call site means the vocabulary is one table to
 * argue with, and the database keeps its precision. Every label answers the only question
 * a reader has — is this done, is it mine, or is it waiting on something else.
 */

export type DocumentStance =
  /** Attached to a charge. Nothing to do. */
  | 'settled'
  /** A person has to decide. This is the only stance that generates work for a human. */
  | 'needs-you'
  /** Waiting on the world — the charge has not posted, or the sender is unknown. */
  | 'waiting'
  /** Nothing usable came out of the document. */
  | 'unreadable';

export interface StatusPresentation {
  /** Shown in a badge. Sentence case: this is a label, not a constant. */
  label: string;
  /** One line of explanation, for places with room. */
  hint: string;
  stance: DocumentStance;
}

const SETTLED: StatusPresentation = {
  label: 'Attached',
  hint: 'Attached to a charge.',
  stance: 'settled',
};

/**
 * Only four of the six are ever worth showing.
 *
 * `RECEIVED` and `EXTRACTED` exist for the moments between storing the bytes and
 * finishing the match. A document sitting in either state in a list means the pipeline
 * died halfway, which the reader cannot act on — so both read as in-progress rather than
 * inventing a fifth idea for them to interpret.
 */
export const STATUS_PRESENTATION: Readonly<Record<DocumentStatus, StatusPresentation>> = {
  MATCHED: SETTLED,
  NEEDS_REVIEW: {
    label: 'Needs you',
    hint: 'The matcher would not decide this on its own.',
    stance: 'needs-you',
  },
  UNMATCHED: {
    label: 'No charge yet',
    hint: 'No charge to attach this to — it retries automatically when one posts.',
    stance: 'waiting',
  },
  FAILED: {
    label: "Couldn't read",
    hint: 'Nothing usable came out of this document.',
    stance: 'unreadable',
  },
  RECEIVED: { label: 'Processing', hint: 'Still being read.', stance: 'waiting' },
  EXTRACTED: { label: 'Processing', hint: 'Read, now being matched.', stance: 'waiting' },
};

export function presentStatus(status: string): StatusPresentation {
  // A status the application does not recognise is a data problem, not a reason to crash
  // a page or render a raw constant at someone.
  return STATUS_PRESENTATION[status as DocumentStatus] ?? SETTLED;
}

/**
 * Tailwind classes per stance.
 *
 * Deliberately a small, closed set: colour is a second channel here, never the only one.
 * Every badge carries its word, so the palette can be quiet and still be legible to a
 * reader who cannot distinguish amber from emerald.
 */
export const STANCE_TONE: Readonly<Record<DocumentStance, string>> = {
  settled: 'bg-emerald-50 text-emerald-800 ring-emerald-600/20 dark:bg-emerald-950/50 dark:text-emerald-300 dark:ring-emerald-400/20',
  'needs-you': 'bg-amber-50 text-amber-900 ring-amber-600/25 dark:bg-amber-950/50 dark:text-amber-200 dark:ring-amber-400/20',
  waiting: 'bg-slate-50 text-slate-700 ring-slate-500/20 dark:bg-slate-900 dark:text-slate-300 dark:ring-slate-400/20',
  unreadable: 'bg-rose-50 text-rose-800 ring-rose-600/20 dark:bg-rose-950/50 dark:text-rose-300 dark:ring-rose-400/20',
};

/**
 * How a document arrived. Shown as a word rather than a coloured pill: the channel
 * matters for context ("the driver sent this from his phone") but never drives a
 * decision, so it should not compete with the status badge for attention.
 */
export const SOURCE_LABEL: Readonly<Record<string, string>> = {
  WHATSAPP: 'WhatsApp',
  EMAIL: 'Email',
};
