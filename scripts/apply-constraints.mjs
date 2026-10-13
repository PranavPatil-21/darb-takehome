#!/usr/bin/env node
/**
 * Applies `prisma/constraints.sql` after `prisma db push`.
 *
 * The brief's project layout is `prisma/schema.prisma` + `prisma/seed.ts`, and `db push`
 * is what its setup implies — so there is no migration history to hang a hand-written
 * index on. But `db push` only knows what the schema can say, and the one rule the brief
 * asks to be enforced "at the data layer" needs a *partial* unique index, which Prisma's
 * schema language cannot express.
 *
 * So the statements live in SQL next to the schema and are applied here, every time the
 * schema is pushed. Each is `IF NOT EXISTS`, so running it repeatedly is a no-op.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sqlPath = join(root, 'prisma', 'constraints.sql');

if (!existsSync(sqlPath)) {
  console.error(`apply-constraints: ${sqlPath} is missing.`);
  process.exit(1);
}

/** `file:./dev.db` in `.env` is relative to `prisma/`, which is where Prisma resolves it. */
function databaseFile() {
  const url = process.env.DATABASE_URL ?? 'file:./dev.db';
  if (!url.startsWith('file:')) {
    console.error(`apply-constraints: only SQLite file URLs are supported, got "${url}".`);
    process.exit(1);
  }
  return resolve(join(root, 'prisma'), url.slice('file:'.length));
}

const sql = readFileSync(sqlPath, 'utf8');
const file = databaseFile();

try {
  // `prisma db execute` rather than a sqlite3 binary, so this needs no system dependency
  // beyond what the project already installs.
  execFileSync(
    'npx',
    ['prisma', 'db', 'execute', '--url', `file:${file}`, '--stdin'],
    { input: sql, stdio: ['pipe', 'ignore', 'inherit'] },
  );
  console.log('Applied prisma/constraints.sql.');
} catch {
  console.error('apply-constraints: failed to apply prisma/constraints.sql.');
  process.exit(1);
}
