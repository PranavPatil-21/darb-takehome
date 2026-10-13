import type { Config } from 'jest';

const config: Config = {
  // Coverage is gated on the engine, not on the whole repo. A global number would be
  // satisfied by testing whatever is easiest; these two directories are where a
  // regression actually costs money, and they are already at or near 100%.
  collectCoverageFrom: ['lib/**/*.ts'],
  coverageThreshold: {
    // A deliberately modest floor for the repo as a whole: much of `lib/platform` and
    // `lib/ui` is read-model and presentation code covered through the pages, and a high
    // global number would only invite tests written to raise a number.
    // Set just under what the suite actually achieves (88.29 / 74.92 / 84.64 / 89.96), so
    // the gains are locked in rather than left as headroom that silently erodes. An
    // earlier revision claimed this and did not do it — the floor sat at 58% branches
    // against 74% achieved, which is a gate that cannot fail. Still a floor, not a target:
    // `lib/platform` and `lib/ui` are read-model and presentation code exercised through
    // the pages, and chasing a higher global number here only invites tests written to
    // move it.
    // Note these are measured against `lib` *minus* the files carrying their own
    // thresholds below — Jest removes a path-specific group from the global one — so the
    // number is lower than the summary table's "All files" row by construction.
    global: { statements: 87, branches: 73, functions: 83, lines: 89 },
    'lib/matching/**/*.ts': { statements: 95, branches: 95, functions: 95, lines: 95 },
    'lib/services/transaction-matcher.ts': { statements: 97, branches: 92, functions: 95, lines: 99 },
    // Measured against this file alone, which Jest reports a few points below the summary
    // table's row for it. The shortfall is concentrated in the P2002 recovery path — the
    // branch that reopens candidates when another document claims the slot between the
    // match decision and the write. It is only reachable under a genuine concurrent claim,
    // which SQLite's single-writer lock cannot produce, so it is covered by reasoning and
    // by the constraint itself rather than by a test. Stated rather than papered over.
    'lib/services/document-ingestion.ts': { statements: 83, branches: 83, functions: 80, lines: 83 },
  },
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
    // next-safe-action ships ESM only, which ts-jest's CommonJS transform cannot load.
    // The double applies the same schema and calls the real action body, so the tests
    // exercise production code instead of a mirror of it. See the file for what it does
    // and does not reproduce.
    '^next-safe-action$': '<rootDir>/__tests__/helpers/next-safe-action.ts',
    // `revalidatePath` throws outside a Next request context. See the stub for why it is
    // stubbed rather than hidden behind a seam in production code.
    '^next/cache$': '<rootDir>/__tests__/helpers/next-cache.ts',
  },
  testMatch: ['**/__tests__/**/*.test.ts'],
  // Integration tests hit a real SQLite file; keep them off the unit-test worker pool's
  // shared database by running serially.
  maxWorkers: 1,
  setupFilesAfterEnv: ['<rootDir>/__tests__/setup.ts'],
  globalSetup: '<rootDir>/__tests__/global-setup.ts',
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/__tests__/helpers/', '<rootDir>/__tests__/setup.ts', '<rootDir>/__tests__/global-setup.ts'],
};

export default config;
