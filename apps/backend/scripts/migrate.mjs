/**
 * PROJECT TITAN — apply SQL migrations to a real Postgres.
 *
 * Reads DATABASE_URL, applies every apps/backend/migrations/*.sql in order (each
 * whole file in one statement via the simple query protocol, so plpgsql triggers
 * + dollar-quoting work). Migrations are written idempotent, so re-running is safe.
 *
 * Run from apps/backend:
 *   node --env-file=.env scripts/migrate.mjs
 */
import { Pool } from 'pg';
import { readdir, readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL not set (use --env-file=.env).'); process.exit(2); }
console.log('DB host =>', new URL(url).hostname);

// Resolve migrations relative to THIS script, so it works from any cwd (e.g. a
// cloud start command run from the repo root).
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const pool = new Pool({ connectionString: url });

try {
  const files = (await readdir(dir)).filter((f) => f.toLowerCase().endsWith('.sql')).sort();
  for (const f of files) {
    const sql = await readFile(path.join(dir, f), 'utf8');
    process.stdout.write(`applying ${f} ... `);
    await pool.query(sql);
    console.log('ok');
  }
  console.log(`done: ${files.length} migration(s) applied`);
} catch (e) {
  console.error(`\nMIGRATION FAILED: ${e.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}

