import { diceCoefficient, merchantSimilarity, normaliseMerchant } from '@/lib/matching/merchant';

describe('normaliseMerchant', () => {
  it('uppercases and splits on punctuation', () => {
    expect(normaliseMerchant('Alfanar-Fuel, Station')).toEqual(['ALFANAR', 'FUEL', 'STATION']);
  });

  it('drops branch and terminal numbers an acquirer appends', () => {
    expect(normaliseMerchant('ALFANAR FUEL ST 04 RUH')).toEqual(['ALFANAR', 'FUEL']);
  });

  it('drops legal forms and city codes', () => {
    expect(normaliseMerchant('ALFANAR TRADING CO LLC JEDDAH')).toEqual(['ALFANAR']);
  });

  it('strips diacritics so Café and Cafe agree', () => {
    expect(normaliseMerchant('Café Bateel')).toEqual(normaliseMerchant('Cafe Bateel'));
  });

  it('returns an empty list for null, undefined and blank input', () => {
    expect(normaliseMerchant(null)).toEqual([]);
    expect(normaliseMerchant(undefined)).toEqual([]);
    expect(normaliseMerchant('   ')).toEqual([]);
    expect(normaliseMerchant('### 0042 ###')).toEqual([]);
  });

  it('keeps Arabic script intact rather than stripping it as punctuation', () => {
    expect(normaliseMerchant('محطة الفنار')).toEqual(['محطة', 'الفنار']);
  });

  it('normalises zero-padded branch numbers before discarding them', () => {
    expect(normaliseMerchant('TAMIMI MARKETS 0007')).toEqual(['TAMIMI', 'MARKETS']);
  });
});

describe('diceCoefficient', () => {
  it('is 1 for identical strings and 0 for disjoint ones', () => {
    expect(diceCoefficient('ALFANAR', 'ALFANAR')).toBe(1);
    expect(diceCoefficient('ALFANAR', 'ZZZZZZZ')).toBe(0);
  });

  it('is symmetric', () => {
    expect(diceCoefficient('ALFANARFUEL', 'ALFANARFUELSTATION')).toBeCloseTo(
      diceCoefficient('ALFANARFUELSTATION', 'ALFANARFUEL'),
      6,
    );
  });

  it('handles strings too short to have bigrams', () => {
    expect(diceCoefficient('A', 'A')).toBe(1);
    expect(diceCoefficient('A', 'B')).toBe(0);
  });
});

describe('merchantSimilarity', () => {
  it('scores the brief\'s worked example highly', () => {
    expect(merchantSimilarity('ALFANAR FUEL ST 04 RUH', 'Alfanar Fuel Station')).toBeGreaterThan(0.8);
  });

  it('is symmetric in its arguments', () => {
    const a = merchantSimilarity('ALFANAR FUEL ST 04 RUH', 'Alfanar Fuel Station');
    const b = merchantSimilarity('Alfanar Fuel Station', 'ALFANAR FUEL ST 04 RUH');
    expect(a).toBeCloseTo(b, 6);
  });

  it('matches real acquirer noise against real trading names', () => {
    const cases: Array<[string, string]> = [
      ['TAMIMI MARKETS 0007 RUH', 'Tamimi Markets'],
      ['NAJD VILLAGE REST RUH', 'Najd Village Restaurant'],
      ['SACO HARDWARE CO LLC', 'SACO'],
      ['PANDA HYPERMARKET BR 112', 'Panda Hypermarket'],
      ['ADV*UBER TRIP', 'Uber Trip'],
    ];

    for (const [acquirer, receipt] of cases) {
      expect(merchantSimilarity(acquirer, receipt)).toBeGreaterThan(0.6);
    }
  });

  it('keeps genuinely different merchants apart', () => {
    expect(merchantSimilarity('ALFANAR FUEL ST 04 RUH', 'Tamimi Markets')).toBeLessThan(0.3);
    expect(merchantSimilarity('SACO HARDWARE', 'IKEA JEDDAH')).toBeLessThan(0.3);
  });

  it('discounts a match that rests only on sector vocabulary', () => {
    // Both are fuel stations; neither is the other. The shared words FUEL and STATION
    // must not manufacture confidence.
    const generic = merchantSimilarity('ALFANAR FUEL STATION', 'PETROMIN FUEL STATION');
    const real = merchantSimilarity('ALFANAR FUEL STATION', 'Alfanar Fuel');

    expect(generic).toBeLessThan(0.45);
    expect(real).toBeGreaterThan(generic + 0.3);
  });

  it('separates two branches of the same chain only as far as their names allow', () => {
    // Branch numbers are stripped, so same-chain branches are *expected* to tie. This is
    // why the matcher needs the ambiguity margin rather than relying on merchant alone.
    expect(merchantSimilarity('ALFANAR FUEL ST 04 RUH', 'Alfanar Fuel Station')).toBeCloseTo(
      merchantSimilarity('ALFANAR FUEL ST 11 RUH', 'Alfanar Fuel Station'),
      6,
    );
  });

  it('returns 0 when either side is missing', () => {
    expect(merchantSimilarity(null, 'Alfanar')).toBe(0);
    expect(merchantSimilarity('Alfanar', null)).toBe(0);
    expect(merchantSimilarity('LLC', 'Alfanar')).toBe(0);
  });

  it('always returns a finite value in 0..1', () => {
    const inputs = ['', '   ', 'A', '####', 'ALFANAR', 'محطة', null, undefined];
    for (const a of inputs) {
      for (const b of inputs) {
        const score = merchantSimilarity(a, b);
        expect(Number.isFinite(score)).toBe(true);
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
      }
    }
  });
});
