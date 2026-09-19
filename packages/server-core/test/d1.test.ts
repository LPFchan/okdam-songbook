import { describe, expect, it } from "vitest";
import { openD1Database } from "../src/db/d1.js";
import { fakeD1 as fakeD1WithSchema } from "./fake-d1.js";

const fakeD1 = () => fakeD1WithSchema("CREATE TABLE items (id TEXT PRIMARY KEY NOT NULL, label TEXT NOT NULL, flag INTEGER)");

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
});
