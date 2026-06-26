/**
 * PROJECT TITAN — Migration runner (Deliverable 5)
 *
 * A tiny, dependency-light runner that applies the numbered `.sql` files in
 * `apps/backend/migrations` in lexical order. Used by tests to stand up a schema
 * against BOTH real Postgres and pg-mem.
 *
 * It executes statements ONE AT A TIME (pg-mem does not support multi-statement
 * query strings, and one-at-a-time gives precise error attribution). Statements
 * are split on top-level `;` while respecting single/double quotes and
 * `$tag$ ... $tag$` dollar-quoted blocks, so a `;` inside a string literal does
 * not split a statement. `CREATE EXTENSION` statements are skipped by default
 * (pg-mem rejects them and the schema does not require them).
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import type { Tx } from './db';

/** Anything that can run a parameterless SQL statement: Db, Tx, or a raw pg client. */
export interface SqlExecutor {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

export interface MigrateOptions {
  /** Directory holding the numbered .sql files. Defaults to ../../migrations. */
  dir?: string;
  /** Skip `CREATE EXTENSION ...` statements (default true; required for pg-mem). */
  skipExtensions?: boolean;
  /** Basenames to skip entirely (e.g. migrations using engine features the target lacks). */
  excludeFiles?: string[];
}

const DEFAULT_MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

/**
 * Split a SQL script into individual statements on top-level semicolons,
 * ignoring `;` inside '…', "…", line comments, block comments, and
 * `$tag$…$tag$` dollar-quoted strings.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];

    // line comment -> consume to end of line
    if (ch === '-' && next === '-') {
      const nl = sql.indexOf('\n', i);
      const end = nl === -1 ? n : nl;
      current += sql.slice(i, end);
      i = end;
      continue;
    }
    // block comment -> consume to closing */
    if (ch === '/' && next === '*') {
      const close = sql.indexOf('*/', i + 2);
      const end = close === -1 ? n : close + 2;
      current += sql.slice(i, end);
      i = end;
      continue;
    }
    // single- or double-quoted string -> consume to matching quote (doubled = escape)
    if (ch === "'" || ch === '"') {
      const quote = ch;
      current += ch;
      i++;
      while (i < n) {
        current += sql[i];
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            current += sql[i + 1];
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    // dollar-quoted block: $tag$ ... $tag$
    if (ch === '$') {
      const tagMatch = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i));
      if (tagMatch) {
        const tag = tagMatch[0];
        const close = sql.indexOf(tag, i + tag.length);
        const end = close === -1 ? n : close + tag.length;
        current += sql.slice(i, end);
        i = end;
        continue;
      }
    }
    // statement terminator
    if (ch === ';') {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = '';
      i++;
      continue;
    }
    current += ch;
    i++;
  }

  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
}

/** Strip comment-only noise so the extension guard sees real keywords. */
function isExtensionStatement(stmt: string): boolean {
  return /^\s*CREATE\s+EXTENSION/i.test(stmt);
}

/** Read and lexically sort the migration filenames (001_, 002_, ...). */
export async function listMigrationFiles(dir = DEFAULT_MIGRATIONS_DIR): Promise<string[]> {
  const entries = await fs.readdir(dir);
  return entries
    .filter((f) => f.toLowerCase().endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Apply every migration file in order against `exec` (a Db, Tx, or pg client).
 * Returns the number of statements executed.
 */
export async function migrate(exec: SqlExecutor, opts: MigrateOptions = {}): Promise<number> {
  const dir = opts.dir ?? DEFAULT_MIGRATIONS_DIR;
  const skipExtensions = opts.skipExtensions ?? true;
  const exclude = new Set(opts.excludeFiles ?? []);
  const files = await listMigrationFiles(dir);

  let applied = 0;
  for (const file of files) {
    if (exclude.has(file)) continue;
    const sql = await fs.readFile(path.join(dir, file), 'utf8');
    for (const stmt of splitStatements(sql)) {
      if (skipExtensions && isExtensionStatement(stmt)) continue;
      await exec.query(stmt);
      applied++;
    }
  }
  return applied;
}

/**
 * Convenience wrapper to run all migrations inside a single transaction on a
 * {@link Tx}-providing unit of work. Real Postgres supports transactional DDL;
 * tests against pg-mem can also pass their executor directly to {@link migrate}.
 */
export async function migrateInTx(
  run: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>,
  opts: MigrateOptions = {},
): Promise<number> {
  return run((tx) => migrate(tx as unknown as SqlExecutor, opts));
}

