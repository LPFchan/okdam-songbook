import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { runMigrations } from "./migrations.js";
import { schema } from "./schema.js";
import type { SqlExecutor, SqliteStatement, SongbookDatabaseBase } from "./sql.js";

export interface DatabaseOptions {
  filename?: string;
  migrate?: boolean;
}

class BetterSqliteStatement implements SqliteStatement {
  constructor(private readonly statement: Database.Statement) {}

  run(...params: unknown[]): { changes: number } {
    const result = this.statement.run(...(params as never[]));
    return { changes: Number(result.changes) };
  }

  get<T>(...params: unknown[]): T | undefined {
    return this.statement.get(...(params as never[])) as T | undefined;
  }

  all<T>(...params: unknown[]): T[] {
    return this.statement.all(...(params as never[])) as T[];
  }
}

class BetterSqliteExecutor implements SqlExecutor {
  private depth = 0;

  constructor(readonly raw: Database.Database) {}

  prepare(sql: string): SqliteStatement {
    return new BetterSqliteStatement(this.raw.prepare(sql));
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  /**
   * A savepoint around a temp table: it exercises the write path and the
   * transaction machinery, then rolls back so nothing is left behind. This
   * used to live inline in the `/healthz` handler, where it ran against
   * whichever executor the runtime supplied and threw on the one that cannot
   * express it.
   */
  writeProbe(): void {
    const name = `songbook_health_${crypto.randomUUID().replaceAll("-", "")}`;
    this.raw.exec(
      `SAVEPOINT ${name}; CREATE TEMP TABLE ${name}(ok INTEGER); INSERT INTO ${name}(ok) VALUES (1); ROLLBACK TO ${name}; RELEASE ${name};`
    );
  }

  /**
   * better-sqlite3 cannot await inside its transaction() helper, so the
   * operation runs inside a manual BEGIN/COMMIT with ROLLBACK on error.
   * Nested transactions use savepoints. The operation is expected to only
   * await statements issued through this executor, so no other connection
   * can interleave.
   */
  async transaction<T>(operation: () => Promise<T> | T): Promise<T> {
    const depth = this.depth;
    const savepoint = "songbook_tx_" + depth;
    this.depth += 1;
    try {
      this.raw.exec(depth === 0 ? "BEGIN" : "SAVEPOINT " + savepoint);
      let result: T;
      try {
        result = await operation();
      } catch (error) {
        this.raw.exec(depth === 0 ? "ROLLBACK" : "ROLLBACK TO " + savepoint + "; RELEASE " + savepoint);
        throw error;
      }
      this.raw.exec(depth === 0 ? "COMMIT" : "RELEASE " + savepoint);
      return result;
    } finally {
      this.depth -= 1;
    }
  }
}

export interface SongbookDatabase extends SongbookDatabaseBase {
  sqlite: BetterSqliteExecutor;
  db: ReturnType<typeof drizzle<typeof schema>>;
  close: () => void;
}

export function openDatabase(options: DatabaseOptions = {}): SongbookDatabase {
  const sqlite = new Database(options.filename ?? ":memory:");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("busy_timeout = 5000");
  if (options.migrate !== false) runMigrations(sqlite);
  const db = drizzle(sqlite, { schema });
  return { sqlite: new BetterSqliteExecutor(sqlite), db, close: () => sqlite.close() };
}

export const createDatabase = openDatabase;

export function withTransaction<T>(database: SongbookDatabase, operation: () => Promise<T> | T): Promise<T> {
  return database.sqlite.transaction(operation);
}

export function databasePragmas(database: SongbookDatabase): Record<string, unknown> {
  const raw = database.sqlite.raw;
  return {
    foreignKeys: raw.pragma("foreign_keys", { simple: true }),
    journalMode: raw.pragma("journal_mode", { simple: true }),
    synchronous: raw.pragma("synchronous", { simple: true }),
    busyTimeout: raw.pragma("busy_timeout", { simple: true })
  };
}
