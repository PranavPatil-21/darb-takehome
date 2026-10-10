import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Creates a throwaway SQLite database for the integration tests.
 *
 * Idempotency and the one-confirmed-document-per-transaction rule are enforced by
 * database constraints, so testing them against a mocked Prisma client would prove
 * nothing — these tests have to hit a real database.
 */
export default function globalSetup(): void {
  const databasePath = join(process.cwd(), 'prisma', 'test.db');
  rmSync(databasePath, { force: true });
  rmSync(`${databasePath}-journal`, { force: true });

  process.env.DATABASE_URL = `file:./test.db`;
  execSync('npx prisma db push --skip-generate --accept-data-loss', {
    stdio: 'ignore',
    env: { ...process.env, DATABASE_URL: 'file:./test.db' },
  });
}
