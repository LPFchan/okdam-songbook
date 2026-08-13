import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { runMigrations } from "./migrations.js";
import { schema } from "./schema.js";

export interface DatabaseOptions {
  filename?: string;
  migrate?: boolean;
}

export interface SongbookDatabase {
  sqlite: Database.Database;
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
  return { sqlite, db, close: () => sqlite.close() };
}

export const createDatabase = openDatabase;

export function withTransaction<T>(database: SongbookDatabase, operation: () => T): T {
  return database.sqlite.transaction(operation)();
}

export function databasePragmas(database: SongbookDatabase): Record<string, unknown> {
  return {
    foreignKeys: database.sqlite.pragma("foreign_keys", { simple: true }),
    journalMode: database.sqlite.pragma("journal_mode", { simple: true }),
    synchronous: database.sqlite.pragma("synchronous", { simple: true }),
    busyTimeout: database.sqlite.pragma("busy_timeout", { simple: true })
  };
}
