import type { SqlExecutor, SqliteStatement, SqlRunResult, SongbookDatabaseBase } from "./sql.js";

/** Structural subset of the Cloudflare D1 binding used by the Worker. */
export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta?: { changes?: number } }>;
}

export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatementLike;
}

function sanitize(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

class D1Statement implements SqliteStatement {
  constructor(private readonly statement: D1PreparedStatementLike) {}

  private bound(params: unknown[]): D1PreparedStatementLike {
    return this.statement.bind(...params.map(sanitize));
  }

  async run(...params: unknown[]): Promise<SqlRunResult> {
    const result = await this.bound(params).run();
    return { changes: Number(result.meta?.changes ?? 0) };
  }

  async get<T>(...params: unknown[]): Promise<T | undefined> {
    const row = await this.bound(params).first<T>();
    return row === null ? undefined : row;
  }

  async all<T>(...params: unknown[]): Promise<T[]> {
    const result = await this.bound(params).all<T>();
    return result.results;
  }
}

/**
 * D1 runs one statement per round trip and offers no interactive transaction:
 * you cannot hold BEGIN open while application code reads a result and decides
 * what to write next. Its batch() API is all-or-nothing, but every statement in
 * the batch must be composed before any of them runs.
 *
 * The songbook's mutations are interactive by nature — reserve an idempotency
 * key, read what the reservation produced, act on it, record the outcome — so
 * they cannot be expressed as a batch. Statements therefore execute
 * immediately and transaction() is a pass-through that provides grouping for
 * the Node runtime and no isolation here.
 *
 * What that costs: a mutation that throws partway leaves its earlier statements
 * applied, so a song can land without its audit row. What it does not cost:
 * idempotent retries. Claiming a key is a single INSERT OR IGNORE against the
 * primary key, and one statement is atomic on its own, so two racing requests
 * still produce one claim and one song.
 */
class D1Executor implements SqlExecutor {
  constructor(private readonly d1: D1DatabaseLike) {}

  prepare(sql: string): SqliteStatement {
    return new D1Statement(this.d1.prepare(sql));
  }

  exec(_sql: string): void {
    throw new Error("D1Executor: exec() is not supported; use prepare().run() or migrations");
  }

  async transaction<T>(operation: () => Promise<T> | T): Promise<T> {
    return await operation();
  }
}

export interface D1SongbookDatabase extends SongbookDatabaseBase {
  sqlite: D1Executor;
}

export function openD1Database(d1: D1DatabaseLike): D1SongbookDatabase {
  return { sqlite: new D1Executor(d1), close: () => undefined };
}
