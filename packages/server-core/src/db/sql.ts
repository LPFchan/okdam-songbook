/**
 * Minimal async SQL surface shared by the Node (better-sqlite3) and
 * Cloudflare D1 runtimes. Statements use positional `?` parameters only.
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
  exec(sql: string): void;
  transaction<T>(operation: () => Promise<T> | T): Promise<T>;
}

export interface SongbookDatabaseBase {
  sqlite: SqlExecutor;
  close: () => void;
}
