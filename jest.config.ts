import type { Config } from 'jest';

const config: Config = {
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
