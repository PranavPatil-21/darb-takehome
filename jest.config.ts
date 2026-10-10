import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
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
