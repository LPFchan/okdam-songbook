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
  /**
   * Prove the database accepts writes, without leaving one behind.
   *
   * Optional because it cannot be expressed on every runtime: the Node probe
   * is a savepoint around a temp table, and D1 has neither savepoints nor
   * multi-statement exec. An executor that omits it is saying "I cannot check
   * this", which a caller must not read as "writes are fine" — a health check
   * calls it when present and reports reachability only when it is not.
   */
  writeProbe?(): Promise<void> | void;
}

export interface SongbookDatabaseBase {
  sqlite: SqlExecutor;
  close: () => void;
}
