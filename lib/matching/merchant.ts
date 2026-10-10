/**
 * Merchant-name normalisation and similarity.
 *
 * Acquirer-provided merchant names are hostile input: uppercased, abbreviated, padded
 * with branch numbers and city codes ("ALFANAR FUEL ST 04 RUH"), while the receipt
 * carries the trading name ("Alfanar Fuel Station"). Comparing them raw is useless, so
 * every comparison goes through `normaliseMerchant` first.
 */

/**
 * Tokens that carry no identifying information: legal forms, country/city markers, and
 * filler. Removing them before comparison stops "ALFANAR TRADING CO LLC RUH" and
 * "ALFANAR" from looking like different merchants.
 */
const NOISE_TOKENS = new Set([
  // Legal forms
  'LLC', 'LTD', 'INC', 'CO', 'COMPANY', 'EST', 'ESTABLISHMENT', 'CORP', 'PLC', 'WLL', 'LLP',
  'TRADING', 'TRDG', 'TRAD', 'GROUP', 'HOLDING', 'INTL', 'INTERNATIONAL',
  // Country / region markers
  'KSA', 'SAU', 'SA', 'SAUDI', 'ARABIA',
  // City and airport codes commonly appended by acquirers
  'RUH', 'JED', 'DMM', 'RIYADH', 'JEDDAH', 'DAMMAM', 'KHOBAR', 'MAKKAH', 'MADINAH',
  'ALKHOBAR', 'MECCA', 'MEDINA', 'TABUK', 'ABHA',
  // Filler
  'THE', 'AND', 'FOR', 'OF', 'AL',
  // Branch markers (the number itself is stripped separately)
  'BR', 'BRANCH', 'STORE', 'STR', 'ST', 'NO', 'NUM', 'UNIT', 'POS', 'TERM', 'TERMINAL',
]);

/**
 * Tokens that are real words but shared across a whole sector. Two merchants matching
 * only on these are not evidence of anything — see `merchantSimilarity`.
 */
const GENERIC_TOKENS = new Set([
  'FUEL', 'PETROL', 'GAS', 'GASOLINE', 'OIL', 'ENERGY', 'STATION', 'STATIONS',
  'MARKET', 'SUPERMARKET', 'HYPERMARKET', 'MART', 'STORES', 'SHOP', 'CENTER', 'CENTRE',
  'RESTAURANT', 'RESTAURANTS', 'CAFE', 'COFFEE', 'KITCHEN', 'FOOD', 'FOODS', 'CATERING',
  'SERVICES', 'SERVICE', 'SUPPLIES', 'SOLUTIONS', 'RENT', 'RENTAL', 'CAR', 'CARS', 'AUTO',
  'HOTEL', 'PHARMACY', 'CLINIC', 'TRANSPORT', 'LOGISTICS',
]);

/** Strips accents so "Café" and "Cafe" compare equal. */
function stripDiacritics(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Reduces a raw merchant string to its distinctive tokens.
 *
 * Returns tokens rather than a string so callers can reason about overlap. Pure and
 * deterministic — it is the most heavily unit-tested helper in the repo because every
 * merchant-signal score depends on it.
 */
export function normaliseMerchant(raw: string | null | undefined): string[] {
  if (!raw) return [];

  const cleaned = stripDiacritics(raw)
    .toUpperCase()
    // Anything that is not a letter or digit is a separator. Keeps Arabic script intact.
    .replace(/[^A-Z0-9\u0600-\u06ff]+/g, ' ')
    .trim();

  if (!cleaned) return [];

  return cleaned
    .split(/\s+/)
    .map((token) => token.replace(/^0+(?=\d)/, '')) // "04" -> "4" before the digit test
    .filter((token) => {
      if (!token) return false;
      if (/^\d+$/.test(token)) return false; // bare branch / terminal numbers
      if (NOISE_TOKENS.has(token)) return false;
      if (token.length === 1) return false; // stray initials left by punctuation splits
      return true;
    });
}

/** Character bigrams of a string, used for the Dice coefficient. */
function bigrams(value: string): string[] {
  const grams: string[] = [];
  for (let i = 0; i < value.length - 1; i += 1) grams.push(value.slice(i, i + 2));
  return grams;
}

/**
 * Sørensen–Dice coefficient over character bigrams. Chosen over Levenshtein because it
 * is order-tolerant and length-tolerant: "ALFANAR FUEL" vs "FUEL ALFANAR STATION" scores
 * well, which is the common acquirer-vs-receipt failure mode, whereas edit distance
 * punishes both reordering and the extra word.
 */
export function diceCoefficient(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;

  const aGrams = bigrams(a);
  const bCounts = new Map<string, number>();
  for (const gram of bigrams(b)) bCounts.set(gram, (bCounts.get(gram) ?? 0) + 1);

  let hits = 0;
  for (const gram of aGrams) {
    const remaining = bCounts.get(gram) ?? 0;
    if (remaining > 0) {
      bCounts.set(gram, remaining - 1);
      hits += 1;
    }
  }

  return (2 * hits) / (aGrams.length + bigrams(b).length);
}

/**
 * Similarity in 0..1 between an acquirer merchant name and a receipt merchant name.
 *
 * Blends two measures because each covers the other's blind spot:
 *  - **Token containment** handles the receipt carrying extra words the acquirer dropped
 *    ("Alfanar Fuel Station" vs "ALFANAR FUEL ST 04 RUH" -> containment 1.0).
 *  - **Dice on bigrams** handles spelling drift and concatenation that tokenisation
 *    cannot see ("ALFANARFUEL" vs "ALFANAR FUEL").
 *
 * A match resting only on sector-generic tokens ("FUEL", "RESTAURANT") is deliberately
 * discounted: half the merchants in a fleet's statement contain the word FUEL, so that
 * overlap carries almost no discriminating power and must not inflate confidence.
 */
export function merchantSimilarity(
  acquirerName: string | null | undefined,
  documentName: string | null | undefined,
): number {
  const a = normaliseMerchant(acquirerName);
  const b = normaliseMerchant(documentName);

  if (a.length === 0 || b.length === 0) return 0;

  const setA = new Set(a);
  const setB = new Set(b);
  const intersection = [...setA].filter((token) => setB.has(token));

  const containment = intersection.length / Math.min(setA.size, setB.size);
  const dice = diceCoefficient(a.join(''), b.join(''));

  let score = 0.55 * containment + 0.45 * dice;

  const distinctiveOverlap = intersection.filter((token) => !GENERIC_TOKENS.has(token));
  const bothHaveDistinctiveTokens =
    [...setA].some((t) => !GENERIC_TOKENS.has(t)) && [...setB].some((t) => !GENERIC_TOKENS.has(t));

  // Both names have a distinctive part, but none of it overlaps — the apparent
  // similarity is sector vocabulary, not the same merchant.
  if (distinctiveOverlap.length === 0 && bothHaveDistinctiveTokens) {
    score *= 0.4;
  }

  return Math.min(1, Math.max(0, Number(score.toFixed(4))));
}
