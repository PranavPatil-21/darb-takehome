import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The layering rules, enforced rather than asserted in prose.
 *
 * docs/ARCHITECTURE.md stated two of these as invariants and both were false — `lib/services`
 * imported `lib/platform`, and the dev-identity switcher imported `next/headers` directly.
 * Nothing caught either, because a rule that lives only in a document is a wish. These
 * tests are the enforcement; the document now describes what they check.
 */

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

/**
 * Every module specifier in a file.
 *
 * Both quote styles, deliberately. The pattern matched single quotes only, and
 * `components/ui/button.tsx` already uses double quotes — so a forbidden import written
 * the other way slipped past every rule below without a sound. A linter that can be
 * evaded by pressing a different key is not a linter.
 */
const importsOf = (file: string): string[] =>
  [
    ...readFileSync(file, 'utf8').matchAll(
      /from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g,
    ),
  ].map((m) => m[1] ?? m[2] ?? '');

describe('the domain core is independent', () => {
  const core = [...sourceFiles('lib/matching'), ...sourceFiles('lib/domain')];

  test.each(core)('%s does not reach into the platform layer', (file) => {
    expect(importsOf(file).filter((i) => i.includes('lib/platform'))).toEqual([]);
  });

  test.each(core)('%s does not reach into the database', (file) => {
    const forbidden = importsOf(file).filter(
      (i) => i.includes('@prisma/client') || i.includes('lib/prisma'),
    );
    expect(forbidden).toEqual([]);
  });

  test.each(core)('%s does not import framework request APIs', (file) => {
    expect(importsOf(file).filter((i) => i.startsWith('next/'))).toEqual([]);
  });
});

describe('the matching engine is pure', () => {
  test('transaction-matcher imports no I/O', () => {
    const forbidden = importsOf('lib/services/transaction-matcher.ts').filter(
      (i) =>
        i.includes('prisma') ||
        i.includes('lib/platform') ||
        i.startsWith('next/') ||
        i.startsWith('node:'),
    );
    expect(forbidden).toEqual([]);
  });
});

describe('the services layer touches the platform only where it is declared to', () => {
  /**
   * Ingestion genuinely needs two platform capabilities: it writes an audit event when it
   * attaches a document itself, and it decides whether that attachment needs independent
   * sign-off. Both are listed here deliberately. The test is not "no dependency" — that
   * was the claim that turned out to be false — it is "no *undeclared* dependency".
   */
  const ALLOWED = new Map<string, string[]>([
    ['lib/services/document-ingestion.ts', ['@/lib/platform/audit', '@/lib/platform/verification']],
    // `charge-status.ts` maintains the cached documentation status and must call the
    // function that defines it. Importing the derivation is the point — a copy of the
    // rule living in the services layer is exactly the drift the cache is designed to
    // avoid.
    ['lib/services/charge-status.ts', ['@/lib/platform/transaction-status']],
  ]);

  test.each(sourceFiles('lib/services'))('%s declares its platform imports', (file) => {
    const actual = importsOf(file).filter((i) => i.includes('lib/platform'));
    expect(actual.sort()).toEqual((ALLOWED.get(file) ?? []).sort());
  });
});

describe('request state is read in exactly one place', () => {
  test('only the identity seam touches next/headers', () => {
    // `app` is scanned as well. It was not, which is how three route and page files
    // importing the database directly stayed invisible to a suite whose stated job is to
    // notice exactly that.
    const offenders = [...sourceFiles('lib'), ...sourceFiles('components'), ...sourceFiles('app')]
      .filter((file) => file !== 'lib/platform/identity.ts')
      .filter((file) => importsOf(file).some((i) => i === 'next/headers'));

    expect(offenders).toEqual([]);
  });
});

describe('the confirmed-document slot has exactly one writer', () => {
  /**
   * docs/ARCHITECTURE.md calls this "the single invariant the whole product rests on", and
   * until now it rested on a comment asking people not to break it.
   *
   * Neither the `@unique` index nor the scalar column stops a future
   * `update({ data: { confirmedDocumentId } })` from stomping a live claim — only the
   * compare-and-set in `slot-claim.ts` does, and that only helps if every write goes
   * through it. This is the rule that makes "every write" true rather than hoped for.
   */
  // `[^}]` rather than the `s` flag: the project targets ES2017, where `s` is a syntax error.
  const WRITES_SLOT = /data\s*:\s*\{[^}]*confirmedDocumentId\s*:/;
  const ALLOWED = 'lib/services/slot-claim.ts';

  test('no module outside slot-claim.ts writes confirmedDocumentId', () => {
    const offenders = [...sourceFiles('lib'), ...sourceFiles('app'), ...sourceFiles('components')]
      .filter((file) => file !== ALLOWED)
      .filter((file) => WRITES_SLOT.test(readFileSync(file, 'utf8')));

    expect(offenders).toEqual([]);
  });

  test('the rule distinguishes a write from a read', () => {
    // A guard that cannot fail is decoration. These pin what the pattern actually matches.
    expect(
      WRITES_SLOT.test('tx.transaction.update({ where: { id }, data: { confirmedDocumentId: docId } })'),
    ).toBe(true);
    expect(WRITES_SLOT.test('select: { confirmedDocumentId: true }')).toBe(false);
    expect(WRITES_SLOT.test('where: { confirmedDocumentId: null }')).toBe(false);
  });
});
