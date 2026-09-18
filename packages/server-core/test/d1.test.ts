import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openD1Database, type D1DatabaseLike, type D1PreparedStatementLike } from "../src/db/d1.js";

/**
 * A D1 binding backed by better-sqlite3 so the executor can be tested without
 * a Workers runtime.
 */
function fakeD1(): D1DatabaseLike {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE items (id TEXT PRIMARY KEY NOT NULL, label TEXT NOT NULL, flag INTEGER)");
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
  return { prepare: statement };
}

describe("D1 executor", () => {
  it("runs statements immediately", async () => {
    const database = openD1Database(fakeD1());
    const inserted = await database.sqlite.prepare("INSERT INTO items (id, label) VALUES (?, ?)").run("a", "first");
    expect(inserted.changes).toBe(1);
    expect(await database.sqlite.prepare("SELECT label FROM items WHERE id=?").get("a")).toEqual({ label: "first" });
  });

  it("sees its own writes inside a transaction", async () => {
    const database = openD1Database(fakeD1());
    const seen = await database.sqlite.transaction(async () => {
      await database.sqlite.prepare("INSERT INTO items (id, label) VALUES (?, ?)").run("b", "written");
      return await database.sqlite.prepare("SELECT label FROM items WHERE id=?").get("b");
    });
    expect(seen).toEqual({ label: "written" });
  });

  it("nests transactions without failing", async () => {
    const database = openD1Database(fakeD1());
    const result = await database.sqlite.transaction(async () =>
      await database.sqlite.transaction(async () => {
        await database.sqlite.prepare("INSERT INTO items (id, label) VALUES (?, ?)").run("c", "nested");
        return "inner";
      })
    );
    expect(result).toBe("inner");
    expect(await database.sqlite.prepare("SELECT label FROM items WHERE id=?").get("c")).toEqual({ label: "nested" });
  });

  it("does not roll back a failed transaction, because D1 cannot", async () => {
    const database = openD1Database(fakeD1());
    await expect(database.sqlite.transaction(async () => {
      await database.sqlite.prepare("INSERT INTO items (id, label) VALUES (?, ?)").run("d", "kept");
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect(await database.sqlite.prepare("SELECT label FROM items WHERE id=?").get("d")).toEqual({ label: "kept" });
  });

  it("converts booleans to integers and undefined to null when binding", async () => {
    const database = openD1Database(fakeD1());
    await database.sqlite.prepare("INSERT INTO items (id, label, flag) VALUES (?, ?, ?)").run("e", "on", true);
    await database.sqlite.prepare("INSERT INTO items (id, label, flag) VALUES (?, ?, ?)").run("f", "off", undefined);
    expect(await database.sqlite.prepare("SELECT flag FROM items WHERE id=?").get("e")).toEqual({ flag: 1 });
    expect(await database.sqlite.prepare("SELECT flag FROM items WHERE id=?").get("f")).toEqual({ flag: null });
  });

  it("rejects exec()", async () => {
    const database = openD1Database(fakeD1());
    expect(() => database.sqlite.exec("SELECT 1")).toThrow(/exec/);
  });
});
