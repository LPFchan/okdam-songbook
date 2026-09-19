/**
 * Minimal async SQL surface the repositories are written against. Cloudflare
 * D1 is the only production executor; tests drive the same interface with a
 * better-sqlite3 database behind a D1-shaped binding. Statements use
 * positional `?` parameters only.
 */
export interface SqlRunResult {
  changes: number;
}

export interface SqliteStatement {
  run(...params: unknown[]): Promise<SqlRunResult> | SqlRunResult;
  get<T = Record<string, unknown>>(...params: unknown[]): Promise<T | undefined> | T | undefined;
  all<T = Record<string, unknown>>(...params: unknown[]): Promise<T[]> | T[];
}

export interface SqlExecutor {
  prepare(sql: string): SqliteStatement;
  transaction<T>(operation: () => Promise<T> | T): Promise<T>;
}

export interface SongbookDatabaseBase {
  sqlite: SqlExecutor;
  close: () => void;
}
