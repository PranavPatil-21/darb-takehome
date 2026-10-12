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
