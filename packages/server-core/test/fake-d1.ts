import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { openD1Database, type D1DatabaseLike, type D1PreparedStatementLike, type D1SongbookDatabase } from "../src/db/d1.js";

/** The schema D1 was given at cutover; the only one production has ever run. */
export const initSql = readFileSync(
  fileURLToPath(new URL("../../../apps/worker/migrations/0001_init.sql", import.meta.url)),
  "utf8"
);

/**
 * A D1 binding backed by better-sqlite3, so the storage code can be tested
 * without a Workers runtime. The database is reached only through the D1
 * binding shape, so anything the D1 executor cannot express fails here the way
 * it would on Cloudflare. Foreign keys are switched on because D1 enforces
 * them and better-sqlite3 does not by default.
 */
export function fakeD1(schemaSql: string = initSql): D1DatabaseLike & { raw: Database.Database } {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(schemaSql);
  const statement = (sql: string): D1PreparedStatementLike => {
    let bound: unknown[] = [];
    const self: D1PreparedStatementLike = {
      bind(...values: unknown[]) { bound = values; return self; },
      async first<T>() { return (db.prepare(sql).get(...(bound as never[])) ?? null) as T | null; },
      async all<T>() { return { results: db.prepare(sql).all(...(bound as never[])) as T[] }; },
      async run() { const r = db.prepare(sql).run(...(bound as never[])); return { meta: { changes: Number(r.changes) } }; }
    };
    return self;
  };
  return { prepare: statement, raw: db };
}

export function openFakeDatabase(): D1SongbookDatabase {
  return openD1Database(fakeD1());
}
