/**
 * Creates `.env` from `.env.example` on a fresh clone.
 *
 * `.env` is gitignored (it is the file that holds secrets in a real deployment), so a
 * reviewer cloning this repo would otherwise hit `Environment variable not found:
 * DATABASE_URL` on their first command. Rather than commit an env file — a habit worth
 * keeping even when the contents are placeholders — setup materialises it.
 *
 * Idempotent: an existing `.env` is never overwritten.
 */
import { copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const target = join(root, '.env');
const template = join(root, '.env.example');

if (existsSync(target)) {
  process.exit(0);
}

if (!existsSync(template)) {
  console.error('[setup] .env.example is missing — cannot create .env');
  process.exit(1);
}

copyFileSync(template, target);
console.log('[setup] created .env from .env.example (SQLite, no secrets required)');
