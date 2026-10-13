import { AGE_BUCKET_LABEL, TRANSACTION_STATUS } from '@/lib/platform/transaction-status';
import { MATCH_REASONS, type MatchReason } from '@/lib/services/transaction-matcher';
import { nextStepText, reasonText, workKindLabel, workKindNextStep } from '@/lib/content/messages';
import { ROLE_SUMMARY } from '@/lib/platform/identity';
import { TRIGGER_COPY } from '@/lib/platform/verification';
import { SOURCE_LABEL, presentStatus } from '@/lib/ui/vocabulary';
import {
  configureMessages,
  DEFAULT_MESSAGES,
  resetMessages,
  t,
  type MessageKey,
} from '@/lib/content/messages';

/**
 * The content layer.
 *
 * Copy is the part of a product most likely to be changed by somebody who is not the
 * person who wrote it — a host adapting vocabulary, a translator, a compliance reviewer
 * objecting to a phrase. These tests protect the properties that make that safe: a
 * substitution that silently drops a value, or a missing key that renders blank, both
 * produce a sentence that looks finished and says the wrong thing.
 */

afterEach(() => resetMessages());

describe('interpolation', () => {
  it('fills named placeholders', () => {
    expect(t('overview.unsupported', { amount: '21,310.65 SAR' })).toBe(
      '21,310.65 SAR has no receipt',
    );
  });

  it('fills several placeholders in one template', () => {
    const line = t('overview.supporting', {
      undocumented: 85,
      total: 203,
      coverage: '58%',
      vat: '2,779.65 SAR',
    });

    expect(line).toContain('85 of 203 charges');
    expect(line).toContain('58% of spend is covered');
    expect(line).toContain('2,779.65 SAR of input VAT');
  });

  it('leaves an unsupplied placeholder visible rather than blank', () => {
    // A silently dropped value yields "  has no receipt", which reads as finished copy
    // and is wrong. Leaving the token shows the bug the first time anybody looks.
    expect(t('overview.unsupported')).toBe('{amount} has no receipt');
  });

  it('returns the key when the key does not exist', () => {
    // Same reasoning: a missing string is a copy bug, and a visible key reports it where
    // an empty space would not.
    expect(t('does.not.exist' as MessageKey)).toBe('does.not.exist');
  });
});

describe('plural selection', () => {
  it('uses the singular form for exactly one', () => {
    expect(t('overview.desk.review', { count: 1 })).toBe('1 document needs a decision');
  });

  it('uses the plural form for anything else', () => {
    expect(t('overview.desk.review', { count: 6 })).toBe('6 documents need a decision');
    expect(t('overview.desk.review', { count: 0 })).toBe('0 documents need a decision');
  });

  it('ignores the plural split when no count is given', () => {
    expect(t('review.subtitle')).not.toContain('|');
  });
});

describe('host overrides', () => {
  it('lets a host replace a phrase without forking the module', () => {
    configureMessages({ 'nav.charges': 'Transactions' });

    expect(t('nav.charges')).toBe('Transactions');
    expect(t('nav.documents')).toBe('Documents');
  });

  it('keeps interpolation working through an override', () => {
    configureMessages({ 'overview.unsupported': 'Missing receipts worth {amount}' });

    expect(t('overview.unsupported', { amount: 'SAR 100' })).toBe(
      'Missing receipts worth SAR 100',
    );
  });

  it('is undone by reset, so one test cannot leak into another', () => {
    configureMessages({ 'nav.charges': 'Transactions' });
    resetMessages();

    expect(t('nav.charges')).toBe('Charges');
  });
});

describe('the catalogue itself', () => {
  it('has no empty strings', () => {
    for (const [key, value] of Object.entries(DEFAULT_MESSAGES)) {
      expect(`${key}: ${value}`).not.toBe(`${key}: `);
    }
  });

  it('never leaves a plural template without both forms', () => {
    for (const [key, value] of Object.entries(DEFAULT_MESSAGES)) {
      if (!value.includes('|')) continue;
      const forms = value.split('|');
      expect(`${key} has ${forms.length} forms`).toBe(`${key} has 2 forms`);
      expect(forms.every((f) => f.trim().length > 0)).toBe(true);
    }
  });

  it('uses only placeholders made of word characters', () => {
    // A stray brace in copy would otherwise survive to the screen as `{`, and a
    // placeholder with punctuation would never be substituted.
    for (const value of Object.values(DEFAULT_MESSAGES)) {
      for (const token of value.match(/\{[^}]*\}/g) ?? []) {
        expect(token).toMatch(/^\{\w+\}$/);
      }
    }
  });
});

/**
 * The copy tables are getters, not snapshots.
 *
 * `TRANSACTION_STATUS`, `SOURCE_LABEL`, `TRIGGER_COPY` and friends read like plain
 * objects, and the obvious implementation — building them once at module load — would
 * silently freeze the default wording into the bundle. A host that called
 * `configureMessages` would then see its overrides apply on some screens and not others,
 * which is worse than not supporting overrides at all. These tests fail if any of those
 * tables is ever rewritten as a literal.
 */
describe('host overrides reach the copy tables', () => {
  afterEach(() => resetMessages());

  it('reaches the charge status table', () => {
    configureMessages({ 'chargeStatus.MISSING': 'No paperwork' });
    expect(TRANSACTION_STATUS.MISSING.label).toBe('No paperwork');
  });

  it('reaches the ageing bands', () => {
    configureMessages({ 'age.60+': 'Over two months' });
    expect(AGE_BUCKET_LABEL['60+']).toBe('Over two months');
  });

  it('reaches the document status presenter', () => {
    configureMessages({ 'docStatus.NEEDS_REVIEW': 'Your call' });
    expect(presentStatus('NEEDS_REVIEW').label).toBe('Your call');
    // The stance is a code decision and must survive a copy override untouched.
    expect(presentStatus('NEEDS_REVIEW').stance).toBe('needs-you');
  });

  it('reaches the arrival channel labels', () => {
    configureMessages({ 'source.WHATSAPP': 'From the driver' });
    expect(SOURCE_LABEL.WHATSAPP).toBe('From the driver');
  });

  it('reaches the sign-off trigger labels', () => {
    configureMessages({ 'trigger.MATERIAL': 'High value' });
    expect(TRIGGER_COPY.MATERIAL).toBe('High value');
  });

  it('reaches the work-queue group labels', () => {
    configureMessages({ 'work.UNREADABLE': 'Could not be read' });
    expect(workKindLabel('UNREADABLE')).toBe('Could not be read');
  });

  it('reaches the next step a group tells the reader to take', () => {
    configureMessages({ 'work.SENDER_UNKNOWN.next': 'Register them in admin' });
    expect(workKindNextStep('SENDER_UNKNOWN')).toBe('Register them in admin');
  });

  it('reaches the role summaries', () => {
    configureMessages({ 'role.reviewer': 'Attaches receipts' });
    expect(ROLE_SUMMARY.reviewer).toBe('Attaches receipts');
  });
});

describe('every matcher reason the reviewer can see has copy', () => {
  /**
   * The copy layer is keyed by reason code, and nothing connects the two lists. Adding a
   * reason to the matcher without adding its sentence here renders a raw enum — or a
   * fallback — as the headline explaining why a document landed on somebody's desk.
   *
   * That is exactly what happened when `UNEXPLAINED_AMOUNT_GAP` was added: it became the
   * most common review reason in the demo and had no sentence at all.
   *
   * Review-queue reasons only. `CONFIDENT_SINGLE_CANDIDATE` never reaches a reviewer (the
   * document was attached automatically), and the three UNMATCHED reasons are shown on the
   * document register rather than as a next step.
   */
  const REVIEW_REASONS: readonly MatchReason[] = [
    'AMBIGUOUS_TOP_CANDIDATES',
    'TRANSACTION_ALREADY_DOCUMENTED',
    'LOW_EXTRACTION_CONFIDENCE',
    'WEAK_EVIDENCE',
    'MID_CONFIDENCE',
    'UNEXPLAINED_AMOUNT_GAP',
  ];

  // Through the production accessors, not `t()`. `lookup` casts the composed key and
  // falls back to the raw code, so an unmapped reason renders as the bare enum rather
  // than failing to compile — which is precisely why this needs a test and not a type.
  it.each(REVIEW_REASONS)('%s has a reason sentence', (reason) => {
    const copy = reasonText(reason);
    expect(copy).not.toBe(reason);
    expect(copy.length).toBeGreaterThan(10);
  });

  it.each(REVIEW_REASONS)('%s tells the reviewer what to do next', (reason) => {
    const copy = nextStepText(reason);
    expect(copy).not.toBe(reason);
    expect(copy.length).toBeGreaterThan(10);
  });

  it('covers every reason the matcher can return for a review outcome', () => {
    // Guards the list above against the matcher growing a new review reason.
    const unaccounted = MATCH_REASONS.filter(
      (reason) =>
        !REVIEW_REASONS.includes(reason) &&
        ![
          'CONFIDENT_SINGLE_CANDIDATE',
          'NO_PLAUSIBLE_CANDIDATE',
          'NO_CANDIDATE_TRANSACTIONS',
          'UNUSABLE_EXTRACTION',
          'INSUFFICIENT_CORROBORATION',
        ].includes(reason),
    );

    expect(unaccounted).toEqual([]);
  });
});
